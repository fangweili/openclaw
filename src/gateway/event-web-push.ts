import { createHash } from "node:crypto";
import nodePath from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronExecutionId } from "../cron/run-id.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  isTranscriptOnlyOpenClawAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import {
  listCurrentWebPushTargets,
  withCurrentWebPushAuthority,
  webPushTargetClient,
  webPushSessionAccess,
  type WebPushAuthority,
} from "./web-push-authority.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
const MAX_PENDING_COMPLETIONS = 16;
const MAX_RECENT_COMPLETIONS = 256;
const defaultLog = createSubsystemLogger("gateway/web-push");

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
  path?: string;
};

export type HumanMentionWebPush = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

function readCronCompletion(message: unknown) {
  if (!isRecord(message) || !isRecord(message.openclawAutomation)) {
    return undefined;
  }
  const { kind } = message.openclawAutomation;
  const jobId = normalizeOptionalString(message.openclawAutomation.jobId);
  const runId = normalizeOptionalString(message.openclawAutomation.runId);
  return message.role === "assistant" &&
    message.api === OPENCLAW_TRANSCRIPT_ARTIFACT_API &&
    message.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    message.model === "automation-result" &&
    kind === "cron" &&
    jobId &&
    runId &&
    message.idempotencyKey === `cron-current-completion:${runId}`
    ? { jobId, runId }
    : undefined;
}

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    const questionId = normalizeOptionalString(value.id);
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
      ...(questionId ? { path: `ask/${encodeURIComponent(questionId)}` } : {}),
    };
  }
  if (
    event === "chat" &&
    value.state === "final" &&
    value.yielded !== true &&
    !isTranscriptOnlyOpenClawAssistantMessage(value.message)
  ) {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
      tag: `openclaw-agent-finished-${runId}`,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = isRecord(value.job) ? value.job : null;
    const jobId = normalizeOptionalString(value.jobId);
    const jobTag = normalizeWebPushDisplayLabel(jobId) ?? "failed";
    const jobName = normalizeWebPushDisplayLabel(job?.name);
    const query = new URLSearchParams();
    if (jobId) {
      query.set("job", jobId);
      const runId =
        normalizeOptionalString(value.runId) ??
        (typeof value.runAtMs === "number" &&
        Number.isSafeInteger(value.runAtMs) &&
        value.runAtMs >= 0
          ? createCronExecutionId(jobId, value.runAtMs)
          : undefined);
      if (runId) {
        query.set("run", runId);
      }
    }
    return {
      category: "scheduled-task-failed",
      title: "OpenClaw scheduled task failed",
      body: "A scheduled task needs attention.",
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobTag}`,
      path: `automations${query.size ? `?${query}` : ""}`,
    };
  }
  return null;
}

/**
 * Routes attention events to offline browsers without expanding session visibility.
 * The connection-state owner retains this dispatcher for one Gateway lifetime.
 * Canonical automation notifications have at most 16 pending deliveries and 256
 * recent run identities; saturation drops only the optional push, never the
 * durable conversation result. Runtime subscriptions retain/join their returned
 * work and abort admission on shutdown. Already-started provider I/O may finish.
 */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: Pick<SubsystemLogger, "warn">;
  stateDir?: string;
}) {
  const log = params.log ?? defaultLog;
  const pendingCompletions = new Set<string>();
  const recentCompletions = new Set<string>();
  const deliver = (
    notification: EventNotification,
    event: string,
    payload?: unknown,
    opts?: GatewayBroadcastOpts,
    mention?: HumanMentionWebPush,
    isCurrent?: (authority: WebPushAuthority) => boolean,
  ): Promise<void> => {
    return (async () => {
      if (!(await hasBoundWebPushSubscriptions(params.stateDir))) {
        return;
      }
      const sender = await prepareWebPushNotificationSender(params.stateDir);
      const agentId = normalizeOptionalString(
        opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
      );
      const sessionKeys = opts?.sessionKeys ?? [];
      const groupedResults = await withCurrentWebPushAuthority(
        { ...params, sessionKeys, agentId, preparePublication: mention?.prepare },
        (authority) => {
          const { cfg } = authority;
          const recipientProfileId =
            mention &&
            authority.profile?.readCurrentIdentity(mention.recipientProfileId)?.profileId;
          if (mention && !recipientProfileId) {
            return undefined;
          }
          const sessionKey = mention?.sessionKey ?? sessionKeys[0];
          const sessionPath = sessionKey
            ? buildControlUiSessionPath({
                namespace: "chat",
                sessionKey,
                fallbackAgentId: agentId,
                mainKey: cfg.session?.mainKey,
                exactKey: true,
              })
            : undefined;
          if (mention && !sessionPath) {
            return undefined;
          }
          const path = notification.path ?? sessionPath?.slice(1) ?? "sessions";
          const url = resolveControlUiWebPushUrl(cfg, path);
          const targets = listCurrentWebPushTargets({
            ...authority,
            requiredScopes:
              notification.category === "agent-question"
                ? [READ_SCOPE, QUESTIONS_SCOPE]
                : [READ_SCOPE],
            // Completion notices can use narrow session access only when the
            // producer supplied authoritative resource keys. Global attention
            // events and questions retain their existing scope requirements.
            ...(notification.category === "agent-finished" && sessionKeys.length > 0
              ? { fallbackScopes: [SESSION_READ_SCOPE] }
              : {}),
            ...(mention ? { visibilityScopes: [ADMIN_SCOPE] } : {}),
          });
          const agentLabel = normalizeWebPushDisplayLabel(agentId);
          const groups = new Map<
            string,
            { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
          >();
          for (const target of targets) {
            if (mention && target.userProfileId !== recipientProfileId) {
              continue;
            }
            const { preferences } = target;
            if (
              !webPushCategoryEnabled(preferences, notification.category) ||
              isWebPushQuietHours(preferences) ||
              !webPushAgentAllowed(preferences, agentId)
            ) {
              continue;
            }
            const client = webPushTargetClient(target);
            const sessionAccess = webPushSessionAccess(authority, client);
            if (
              target.scopes.includes(SESSION_READ_SCOPE) &&
              sessionKeys.some((key) => {
                const session = sessionAccess.target(key);
                return (
                  !session ||
                  authorizeGatewaySessionCreation(
                    { cfg, client, agentId: session.agentId },
                    { policy: sessionAccess.sharing.policy },
                  ) !== undefined
                );
              })
            ) {
              continue;
            }
            if (
              sessionKeys.length > 0 &&
              !canReceiveSessionEvent({
                cfg,
                client,
                prepared: sessionAccess,
                sessionKeys,
                ...(agentId ? { agentId } : {}),
                event,
                payload,
              })
            ) {
              continue;
            }
            if (cfg.gateway?.roles && sessionKeys.length === 0) {
              // Multi-user events without an authoritative session owner are not broadcast offline.
              continue;
            }
            const prefix = preferences.label ? `${preferences.label} · ` : "";
            const title = `${prefix}${notification.title}`;
            const body =
              preferences.detailLevel === "private"
                ? notification.body
                : (notification.identifiedBody ??
                  (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
            const key = JSON.stringify({ title, body });
            const group = groups.get(key) ?? { title, body, subscriptions: [] };
            group.subscriptions.push(target.subscription);
            groups.set(key, group);
          }
          // The mention owner fences dismissal, expiry, session replacement and Gateway
          // teardown after preparation. No awaited work may separate it from the send.
          if ((mention && !mention.isCurrent()) || (isCurrent && !isCurrent(authority))) {
            return undefined;
          }
          const topic = createHash("sha256")
            .update(notification.tag)
            .digest("base64url")
            .slice(0, 32);
          return {
            start: () =>
              Promise.all(
                [...groups.values()].map((group) =>
                  sender({
                    subscriptions: group.subscriptions,
                    payload: {
                      title: group.title,
                      body: group.body,
                      tag: notification.tag,
                      renotify: false,
                      url,
                    },
                    deliveryOptions: {
                      TTL: EVENT_PUSH_TTL_SECONDS,
                      urgency: notification.category.includes("failed") ? "high" : "normal",
                      topic,
                    },
                  }),
                ),
              ),
          };
        },
      );
      if (!groupedResults) {
        return;
      }
      const results = groupedResults.flat();
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) {
        log.warn("event Web Push delivery failed", {
          category: notification.category,
          attempted: results.length,
          failed,
        });
      }
    })().catch(() => {
      // Transport failures can contain endpoints and payload bytes; log only the closed category.
      log.warn("event Web Push delivery could not complete", { category: notification.category });
    });
  };

  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (notification) {
        void deliver(notification, event, payload, opts);
      }
    },
    /**
     * Consumes internal canonical transcript publications, including offline ones.
     * Rereads the committed message before accepting cron provenance; retries of
     * the same run/generation coalesce before any await. Authority and generation
     * are checked synchronously at provider start, after all preparation. Failure
     * is best effort and never retries an ambiguous send; history is authoritative.
     */
    async deliverAutomationCompletion(
      this: void,
      update: InternalSessionTranscriptUpdate,
      signal: AbortSignal,
    ): Promise<void> {
      const completion = readCronCompletion(update.message);
      const target = update.target;
      if (!completion || !target?.storePath || !update.messageId || signal.aborted) {
        return;
      }
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            target.agentId,
            target.sessionKey,
            target.sessionId,
            nodePath.resolve(target.storePath),
            normalizeOptionalString(update.lifecycleRevision),
            completion.jobId,
            completion.runId,
          ]),
        )
        .digest("base64url");
      if (pendingCompletions.has(id) || recentCompletions.has(id)) {
        return;
      }
      if (pendingCompletions.size >= MAX_PENDING_COMPLETIONS) {
        log.warn("automation Web Push capacity exceeded");
        return;
      }
      pendingCompletions.add(id);
      let accepted = false;
      try {
        const { readSessionMessageByIdAsync } = await import("./session-transcript-readers.js");
        const stored = await readSessionMessageByIdAsync(target, update.messageId);
        const canonical = readCronCompletion(stored.message);
        if (
          canonical?.jobId !== completion.jobId ||
          canonical?.runId !== completion.runId ||
          signal.aborted
        ) {
          return;
        }
        accepted = true;
        await deliver(
          {
            category: "agent-finished",
            title: "OpenClaw agent finished",
            body: "An agent completed its response.",
            tag: `openclaw-automation-${id}`,
          },
          "session.message",
          undefined,
          { agentId: target.agentId, sessionKeys: [target.sessionKey] },
          undefined,
          (authority) => {
            const current = authority.sessions.get(target.sessionKey)?.target;
            return (
              !signal.aborted &&
              current?.agentId === target.agentId &&
              current.entry.sessionId === target.sessionId &&
              normalizeOptionalString(current.entry.lifecycleRevision) ===
                normalizeOptionalString(update.lifecycleRevision) &&
              nodePath.resolve(current.storePath) === nodePath.resolve(target.storePath!)
            );
          },
        );
      } catch {
        log.warn("automation Web Push delivery could not complete");
      } finally {
        pendingCompletions.delete(id);
        if (accepted) {
          recentCompletions.add(id);
          if (recentCompletions.size > MAX_RECENT_COMPLETIONS) {
            recentCompletions.delete(recentCompletions.values().next().value!);
          }
        }
      }
    },
    deliverMention(this: void, mention: HumanMentionWebPush): void {
      const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
      const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
      const id = createHash("sha256").update(mention.id).digest("base64url");
      void deliver(
        {
          category: "human-mentioned",
          title: "OpenClaw mention",
          body: "Someone mentioned you in a conversation.",
          identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
          tag: `openclaw-mention-${id}`,
        },
        "human-mentioned",
        undefined,
        { agentId: mention.agentId, sessionKeys: [mention.sessionKey] },
        mention,
      );
    },
  };
}
