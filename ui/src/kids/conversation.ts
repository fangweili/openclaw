/**
 * Owns the kids app's single, authenticated tutor conversation. The Gateway owns
 * identity, agent access, session ownership, transcript order, and send admission.
 * This projection is memory-only and exists for one connection generation.
 *
 * Connect resolves the verified profile and its sole accessible agent, creates or
 * reopens their stable session, subscribes, then loads a bounded transcript. Each
 * asynchronous continuation checks its connection owner before publishing or
 * issuing another request. Disconnect aborts reads and immediately forgets the
 * transcript. Dispose also removes the listener and joins subscription cleanup.
 * Sends are serialized; uncertain transport outcomes are reconciled from input
 * receipts or an explicit retry of the exact original request, never a fresh
 * idempotency key. One uncertain request survives disconnect in memory; a
 * different verified profile, agent, or backing session discards that request.
 */
import {
  createSessionProjection,
  GatewaySessionMessageSubscriptionCoordinator,
  isGatewayProtocolResponseError,
  reduceSessionProjection,
  type GatewayProtocolRequestOptions,
  type GatewaySessionMessageSubscription,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import type {
  AgentsListResult,
  ChatSendParamsSchema,
  UsersSelfResult,
} from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Static } from "typebox";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { isToolCallContentType } from "../../../src/chat/tool-content.js";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { extractText } from "../lib/chat/message-extract.ts";
import { isVisibleChatHistoryMessage } from "../lib/chat/message-visibility.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";

registerKidsEnglish();

export type KidsMessage = { id: string; role: "user" | "assistant"; text: string };

export type KidsConversationState = {
  childName: string;
  agentId: string;
  sessionKey: string;
  messages: readonly KidsMessage[];
  status: "disconnected" | "loading" | "ready" | "error";
  busy: boolean;
  canRetrySend: boolean;
  error: string | null;
};

type ConversationClient = Pick<
  GatewayBrowserClient,
  "request" | "addEventListener" | "connected" | "connectionGeneration"
>;

type Connection = {
  profileId: string;
  generation: number;
  abort: AbortController;
  subscriptions: GatewaySessionMessageSubscriptionCoordinator;
  subscription?: GatewaySessionMessageSubscription;
  projection: SessionProjectionState;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  leaf: string | null;
  history?: Promise<void>;
  refreshAgain: boolean;
  sending: boolean;
  uncertainSend?: string;
  eventRevision: number;
  replying: boolean;
  runError: string | null;
};

/** One memory-only retry, retaining the original authority and admission fences. */
type PendingSend = {
  profileId: string;
  params: Static<typeof ChatSendParamsSchema>;
  accepted: boolean;
};

const HISTORY_LIMIT = 80;
const HISTORY_MAX_BYTES = 256 * 1024;

function emptyState(): KidsConversationState {
  return {
    childName: "",
    agentId: "",
    sessionKey: "",
    messages: [],
    status: "disconnected",
    busy: false,
    canRetrySend: false,
    error: null,
  };
}

function visibleMessage(message: unknown): boolean {
  const record = asOptionalRecord(message);
  const role = record?.role;
  if ((role !== "user" && role !== "assistant") || !isVisibleChatHistoryMessage(message)) {
    return false;
  }
  // Tool-bearing turns are activity. A pure-text final may legitimately inherit
  // a toolUse stop reason. The shared extractor owns explicit final/commentary
  // precedence and removes thinking, envelopes, and internal runtime context.
  return (
    (role === "user" ||
      (record?.stopReason !== "error" &&
        record?.stopReason !== "aborted" &&
        (!Array.isArray(record?.content) ||
          !record.content.some((part) => isToolCallContentType(asOptionalRecord(part)?.type))))) &&
    Boolean(extractText(message)?.trim())
  );
}

/** The app owns the socket; this owner never starts, stops, or upgrades its scopes. */
export class KidsConversation {
  private connection: Connection | null = null;
  private snapshot = emptyState();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private uncertain: PendingSend | null = null;
  private readonly removeListener: () => void;

  /**
   * Callbacks must not throw. State snapshots are immutable. onAccepted reports
   * one acknowledged original text per send, only in its current binding; it
   * also covers receipt reconciliation after reconnect, without a replay.
   */
  constructor(
    private readonly client: ConversationClient,
    private readonly onState: (state: KidsConversationState) => void,
    private readonly onAccepted: (text: string) => void = () => {},
  ) {
    this.removeListener = client.addEventListener((event) => this.handleEvent(event));
  }

  /** Current presentation only; session authority remains on the Gateway. */
  get state(): KidsConversationState {
    return this.snapshot;
  }

  /**
   * Call for each authenticated hello. A repeated call retires previous work;
   * shared-owner and ambiguous agent access fail before creating any session.
   * Bootstrap errors are shown in state; reconnecting starts a fresh admission.
   */
  async connect(_hello: GatewayHelloOk): Promise<void> {
    this.disconnect();
    if (this.disposed || !this.client.connected) {
      return;
    }
    const connection: Connection = {
      profileId: "",
      generation: this.client.connectionGeneration,
      abort: new AbortController(),
      subscriptions: new GatewaySessionMessageSubscriptionCoordinator({
        request: (method, params, options) => this.request(connection, method, params, options),
      }),
      projection: createSessionProjection(),
      sessionKey: "",
      agentId: "",
      leaf: null,
      refreshAgain: false,
      sending: false,
      eventRevision: 0,
      replying: false,
      runError: null,
    };
    this.connection = connection;
    this.publish({ status: "loading" });
    try {
      const [{ profile }, roster] = await Promise.all([
        this.request<UsersSelfResult>(connection, "users.self", {}),
        this.request<AgentsListResult>(connection, "agents.list", {}),
      ]);
      if (!this.current(connection)) {
        return;
      }
      if (
        this.uncertain &&
        (this.uncertain.profileId !== profile.id ||
          roster.agents.length !== 1 ||
          this.uncertain.params.agentId !== roster.agents[0]?.id)
      ) {
        this.uncertain = null;
      }
      if (profile.id === GATEWAY_OWNER_PROFILE_ID || !profile.id || roster.agents.length !== 1) {
        this.publish({
          status: "error",
          error: t("kids.setupNeeded"),
        });
        return;
      }
      const agent = roster.agents[0]!;
      const key = `agent:${agent.id}:kids:${encodeURIComponent(profile.id).toLowerCase()}`;
      const created = await this.request<{ key: string }>(connection, "sessions.create", {
        key,
        agentId: agent.id,
        displayName: t("kids.name"),
      });
      if (!this.current(connection)) {
        return;
      }
      // No server alias may silently redirect a child's stable conversation.
      if (created.key !== key) {
        throw new Error("The tutor session changed during setup");
      }
      connection.sessionKey = created.key;
      connection.agentId = agent.id;
      connection.profileId = profile.id;
      if (this.uncertain?.params.sessionKey === created.key) {
        connection.uncertainSend = this.uncertain.params.idempotencyKey;
      }
      connection.projection = createSessionProjection({ sessionKey: key, agentId: agent.id });
      this.publish({
        childName: profile.displayName || t("kids.you"),
        agentId: agent.id,
        sessionKey: key,
      });
      if (!this.current(connection)) {
        return;
      }
      connection.subscription = await connection.subscriptions.acquire(key, { agentId: agent.id });
      if (this.current(connection)) {
        await this.refresh();
      }
    } catch {
      if (this.current(connection)) {
        this.publish({
          status: "error",
          busy: false,
          error: t("kids.connectionError"),
        });
      }
    }
  }

  /** Called immediately on socket close; old observers belong to the closed socket. */
  disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.abort.abort();
      connection.subscriptions.reset();
    }
    this.snapshot = emptyState();
    if (!this.disposed) {
      this.onState(this.snapshot);
    }
  }

  /**
   * Sends one plain-text turn using the displayed session/branch and a unique
   * idempotency key. Joins any current history refresh before admission, then
   * rechecks connection ownership and busy state so concurrent callers serialize.
   * Returns true only for an acknowledged or receipt-proven accepted turn.
   * False retains the caller's draft. Never automatically resends.
   */
  async send(text: string): Promise<boolean> {
    const connection = this.connection;
    const message = text.trim();
    if (!connection) {
      return false;
    }
    while (connection.history && this.current(connection)) {
      await connection.history;
    }
    if (
      !this.current(connection) ||
      this.snapshot.status !== "ready" ||
      this.snapshot.busy ||
      !connection.sessionId ||
      !message
    ) {
      return false;
    }
    return this.transmit(connection, {
      profileId: connection.profileId,
      accepted: false,
      params: {
        sessionKey: connection.sessionKey,
        agentId: connection.agentId,
        sessionId: connection.sessionId,
        expectedLeafEntryId: connection.leaf,
        message,
        idempotencyKey: generateUUID(),
        deliver: false,
        suppressCommandInterpretation: true,
      },
    });
  }

  /**
   * Explicitly retries one unresolved send after any authoritative read finishes.
   * Reuses its complete original payload, including session/branch and run ID;
   * Gateway replay admission owns deduplication. Concurrent calls serialize and
   * each click makes at most one send attempt. No replay crosses a changed binding.
   * Returns true only for an acknowledged or receipt-proven accepted turn;
   * onAccepted owns draft cleanup. Transport failure retains the same request.
   */
  async retrySend(): Promise<boolean> {
    const connection = this.connection;
    const pending = this.uncertain;
    if (!connection || !pending) {
      return false;
    }
    while (connection.history && this.current(connection)) {
      await connection.history;
    }
    if (!this.current(connection)) {
      return false;
    }
    if (pending.accepted) {
      return true;
    }
    if (!this.snapshot.canRetrySend || this.uncertain !== pending) {
      return false;
    }
    return this.transmit(connection, pending);
  }

  /** Owns one wire attempt; retired completions cannot change the active retry or presentation. */
  private async transmit(connection: Connection, pending: PendingSend): Promise<boolean> {
    const { idempotencyKey: runId, message } = pending.params;
    connection.sending = true;
    connection.runError = null;
    connection.projection = reduceSessionProjection(connection.projection, {
      type: "sendPending",
      idempotencyKey: runId,
      message: { role: "user", content: [{ type: "text", text: message }], idempotencyKey: runId },
    });
    this.render(connection, { busy: true, error: null });
    try {
      await this.request(connection, "chat.send", pending.params, {
        onSent: () => {
          if (this.current(connection)) {
            this.uncertain = pending;
          }
        },
      });
      if (!this.current(connection)) {
        return false;
      }
      if (connection.sessionId === pending.params.sessionId) {
        this.acknowledge(pending);
      }
      connection.sending = false;
      connection.uncertainSend = undefined;
      await this.refresh();
      return this.current(connection);
    } catch (error) {
      if (!this.current(connection)) {
        return false;
      }
      connection.sending = false;
      // A subscribed/history receipt can prove acceptance while the wire
      // attempt is still pending. Its authoritative outcome wins a later loss.
      if (pending.accepted) {
        await this.refresh();
        return this.current(connection);
      }
      if (isGatewayProtocolResponseError(error) && this.uncertain === pending) {
        this.uncertain = null;
      }
      if (isGatewayProtocolResponseError(error) || this.uncertain !== pending) {
        connection.uncertainSend = undefined;
        connection.projection = reduceSessionProjection(connection.projection, {
          type: "sendFailed",
          runId,
        });
        connection.runError = t("kids.sendFailed");
        this.render(connection, {
          busy: false,
          error: connection.runError,
        });
        await this.refresh();
        return false;
      }
      connection.uncertainSend = runId;
      this.render(connection, { busy: true, error: t("kids.sendUncertain") });
      await this.refresh();
      return this.current(connection) && !connection.uncertainSend;
    }
  }

  /** Current-binding acknowledgments transfer draft cleanup once, including passive receipts. */
  private acknowledge(pending: PendingSend): void {
    if (this.uncertain === pending) {
      this.uncertain = null;
    }
    if (!pending.accepted) {
      pending.accepted = true;
      this.onAccepted(pending.params.message);
    }
  }

  /**
   * Refreshes the bounded authoritative tail, including after voice. Concurrent
   * callers share a read plus at most one trailing invalidation. A failed read
   * disables new sends until a subsequent refresh succeeds.
   */
  refresh(): Promise<void> {
    const connection = this.connection;
    if (!connection || !connection.sessionKey || !this.current(connection)) {
      return Promise.resolve();
    }
    if (connection.history) {
      connection.refreshAgain = true;
      return connection.history;
    }
    const task = this.loadHistory(connection).finally(() => {
      connection.history = undefined;
    });
    connection.history = task;
    return task;
  }

  /** Retires callbacks, releases the current wire observer, and joins owned I/O. Idempotent. */
  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal;
    }
    this.disposed = true;
    this.removeListener();
    this.disposal = this.close();
    return this.disposal;
  }

  private async close(): Promise<void> {
    const connection = this.connection;
    connection?.abort.abort();
    if (connection?.subscription && this.current(connection, true)) {
      try {
        await connection.subscriptions.release(connection.subscription);
      } catch {
        // Socket teardown owns a failed unsubscribe; no observer crosses reconnect.
      }
    }
    this.disconnect();
    await Promise.allSettled(this.pending);
    this.uncertain = null;
  }

  private current(connection: Connection, duringDispose = false): boolean {
    return (
      (!this.disposed || duringDispose) &&
      this.connection === connection &&
      (!connection.abort.signal.aborted || duringDispose) &&
      this.client.connected &&
      this.client.connectionGeneration === connection.generation
    );
  }

  private request<T = unknown>(
    connection: Connection,
    method: string,
    params: Record<string, unknown>,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    if (!this.current(connection, method === "sessions.messages.unsubscribe")) {
      return Promise.reject(new Error("Conversation has disconnected"));
    }
    const request = this.client.request<T>(method, params, {
      ...options,
      signal: method === "sessions.messages.unsubscribe" ? undefined : connection.abort.signal,
    });
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request)).catch(() => undefined);
    return request;
  }

  private async loadHistory(connection: Connection): Promise<void> {
    do {
      connection.refreshAgain = false;
      const observedRevision = connection.eventRevision;
      try {
        const history = await this.request<ChatHistoryResult>(connection, "chat.history", {
          sessionKey: connection.sessionKey,
          agentId: connection.agentId,
          limit: HISTORY_LIMIT,
          maxBytes: HISTORY_MAX_BYTES,
          ...(connection.uncertainSend ? { inputRunIds: [connection.uncertainSend] } : {}),
        });
        if (!this.current(connection)) {
          return;
        }
        const sessionId = history.sessionInfo?.sessionId ?? history.sessionId;
        if (!sessionId || !Object.hasOwn(history.sessionInfo ?? {}, "activeLeafEntryId")) {
          throw new Error("The conversation is missing its current branch");
        }
        if (connection.sessionId && connection.sessionId !== sessionId) {
          connection.projection = createSessionProjection({
            sessionKey: connection.sessionKey,
            agentId: connection.agentId,
          });
        }
        connection.sessionId = sessionId;
        if (connection.uncertainSend && this.uncertain?.params.sessionId !== sessionId) {
          this.uncertain = null;
          connection.uncertainSend = undefined;
          connection.runError = t("kids.sendContextChanged");
        }
        connection.leaf = history.sessionInfo?.activeLeafEntryId ?? null;
        connection.projection = reduceSessionProjection(connection.projection, {
          type: "snapshotLoaded",
          scope: { sessionId },
          messages: [
            ...(history.messages ?? []),
            ...(history.pendingInputs?.items.map((row) => row.message) ?? []),
          ],
          options: { shouldIncludeMessage: visibleMessage },
        });
        if (
          connection.uncertainSend &&
          history.inputReceipts?.some((receipt) => receipt.runId === connection.uncertainSend)
        ) {
          if (this.uncertain?.params.idempotencyKey === connection.uncertainSend) {
            this.acknowledge(this.uncertain);
          }
          connection.uncertainSend = undefined;
        }
        if (observedRevision === connection.eventRevision) {
          connection.replying = Boolean(history.inFlightRun);
        }
        const queuedCount = history.pendingInputs?.queuedCount ?? 0;
        const interruptedInput = history.pendingInputs?.items.some(
          (input) => input.state === "interrupted" || input.state === "cancelled",
        );
        this.render(connection, {
          status: "ready",
          busy:
            connection.sending ||
            Boolean(connection.uncertainSend) ||
            connection.replying ||
            queuedCount > 0,
          error: connection.uncertainSend
            ? t("kids.sendUncertain")
            : (connection.runError ??
              (interruptedInput && !connection.replying && queuedCount === 0
                ? t("kids.inputInterrupted")
                : null)),
        });
      } catch {
        if (this.current(connection)) {
          this.render(connection, {
            status: "error",
            busy: false,
            error: t("kids.historyFailed"),
          });
        }
        return;
      }
    } while (connection.refreshAgain && this.current(connection));
  }

  private handleEvent(event: GatewayEventFrame): void {
    const connection = this.connection;
    if (!connection || !connection.sessionKey || !this.current(connection)) {
      return;
    }
    const payload = asOptionalRecord(event.payload);
    if (
      !payload ||
      (payload.sessionKey ?? payload.key) !== connection.sessionKey ||
      (payload.agentId !== undefined && payload.agentId !== connection.agentId) ||
      (connection.sessionId &&
        payload.sessionId !== undefined &&
        payload.sessionId !== connection.sessionId)
    ) {
      return;
    }
    if (event.event === "session.message") {
      connection.eventRevision += 1;
      if (visibleMessage(payload.message)) {
        connection.projection = reduceSessionProjection(connection.projection, {
          type: "messagePersisted",
          message: payload.message,
          envelope: payload,
        });
        this.render(connection);
        if (asOptionalRecord(payload.message)?.role === "assistant") {
          // Proactive or voice replies may arrive without this client's chat
          // run lifecycle. Refresh the branch before admitting the next turn.
          void this.refresh();
        }
      }
      return;
    }
    if (event.event !== "chat") {
      return;
    }
    if (payload.state === "delta" || payload.state === "status") {
      connection.eventRevision += 1;
      connection.replying = true;
      this.publish({ busy: true });
      return;
    }
    if (payload.state !== "final" && payload.state !== "error" && payload.state !== "aborted") {
      return;
    }
    connection.eventRevision += 1;
    connection.replying = false;
    // Only durable rows provide reply text. A final event is a refresh trigger,
    // never a second provisional transcript entry that needs content deduping.
    if (payload.state === "error" || payload.state === "aborted") {
      connection.runError = t("kids.runFailed");
    }
    this.render(connection, { busy: true });
    void this.refresh();
  }

  private render(connection: Connection, patch: Partial<KidsConversationState> = {}): void {
    if (!this.current(connection)) {
      return;
    }
    // Bound the live projection as well as snapshots; long tabs do not grow forever.
    const entries = connection.projection.entries.slice(-HISTORY_LIMIT);
    connection.projection = {
      ...connection.projection,
      entries,
      messages: entries.map((entry) => entry.message),
    };
    const messages: KidsMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      const identity = entry.identity;
      if (!identity || !visibleMessage(entry.message)) {
        continue;
      }
      const text = extractText(entry.message)?.trim();
      if (text && (identity.role === "user" || identity.role === "assistant")) {
        messages.push({
          id: identity.id ?? identity.idempotencyKey ?? `message-${index}`,
          role: identity.role,
          text,
        });
      }
    }
    this.publish({
      ...patch,
      messages,
      canRetrySend:
        (patch.status ?? this.snapshot.status) === "ready" &&
        Boolean(connection.uncertainSend) &&
        !connection.sending,
    });
  }

  private publish(patch: Partial<KidsConversationState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onState(this.snapshot);
  }
}
