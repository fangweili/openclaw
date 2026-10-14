import {
  ACTIVITY_EXPLANATION_MAX_LENGTH,
  ACTIVITY_NUMERIC_MAX_LENGTH,
  type ActivityMutation,
} from "@openclaw/kids-activity-contract";
/**
 * Scoped activity RPC adapters. Gateway participation admission proves the caller's
 * session; this module maps that prepared target to exactly one configured child.
 * Mutations retain the live request guard through worker COMMIT. Read responses
 * and private image bytes are discarded after disconnect/revocation.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ActivityChildBinding } from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import type { ActivityOwner } from "./activity-service.js";

type GatewayOptions = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type ImageReader = (
  childId: string,
  imageId: string,
  assertCurrent: () => void,
) => Promise<{ mimeType: string; base64: string }>;
const METHODS = ["get", "start", "answer", "hint", "touch", "image"] as const;
type Method = (typeof METHODS)[number];

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 180) {
    throw new ActivityInputError("Invalid activity request.");
  }
  return value;
}

function parseMutation(
  method: Exclude<Method, "get" | "image">,
  params: Record<string, unknown>,
): ActivityMutation {
  const requestId = text(params.requestId);
  if (method === "touch") {
    if (params.source !== "chat" && params.source !== "voice") {
      throw new ActivityInputError("Invalid interaction source.");
    }
    return { kind: method, requestId, source: params.source };
  }
  const activityId = text(params.activityId);
  if (method === "start") {
    return { kind: method, requestId, activityId };
  }
  const questionId = text(params.questionId);
  if (method === "hint") {
    return { kind: method, requestId, activityId, questionId };
  }
  const answer = params.answer;
  if (
    typeof answer !== "object" ||
    answer === null ||
    Array.isArray(answer) ||
    !("kind" in answer)
  ) {
    throw new ActivityInputError("Enter an answer to check.");
  }
  if (answer.kind === "choice") {
    return {
      kind: method,
      requestId,
      activityId,
      questionId,
      answer: {
        kind: "choice",
        optionId: text("optionId" in answer ? answer.optionId : undefined),
      },
    };
  }
  if (
    (answer.kind !== "numeric" && answer.kind !== "explanation") ||
    !("text" in answer) ||
    typeof answer.text !== "string" ||
    !answer.text.trim() ||
    answer.text.length >
      (answer.kind === "numeric" ? ACTIVITY_NUMERIC_MAX_LENGTH : ACTIVITY_EXPLANATION_MAX_LENGTH)
  ) {
    throw new ActivityInputError("Enter a short answer to check.");
  }
  return {
    kind: method,
    requestId,
    activityId,
    questionId,
    answer: { kind: answer.kind, text: answer.text },
  };
}

/** The returned assertion is request-bound and must never be saved for background work. */
function admitChild(options: GatewayOptions, children: readonly ActivityChildBinding[]) {
  const authority = options.sessionAccessAuthority;
  const admitted = authority?.target;
  const child =
    admitted &&
    children.find(
      (binding) =>
        binding.agentId === admitted.agentId && binding.sessionKey === admitted.sessionKey,
    );
  if (!child || !authority) {
    throw new Error("Open your own Rocky conversation to use activities.");
  }
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    authority.assertCurrent();
  };
  assertCurrent();
  return { child, assertCurrent };
}

/** Methods require the existing own-session write scope, without granting broad read access. */
export function registerKidsActivityGateway(
  api: OpenClawPluginApi,
  owner: ActivityOwner,
  options: { children: readonly ActivityChildBinding[]; readImage: ImageReader },
): void {
  for (const method of METHODS) {
    api.registerGatewayMethod(
      `kids.activity.${method}`,
      async (request) => {
        let admitted = false;
        try {
          const { child, assertCurrent } = admitChild(request, options.children);
          admitted = true;
          const params = request.params;
          const result =
            method === "get"
              ? await owner.get(child.childId, assertCurrent)
              : method === "image"
                ? await options.readImage(child.childId, text(params.imageId), assertCurrent)
                : await owner.mutate(child.childId, parseMutation(method, params), assertCurrent);
          assertCurrent();
          request.respond(true, result);
        } catch (error) {
          const rejected =
            error instanceof Error && "code" in error && error.code === "KIDS_ACTIVITY_INVALID";
          request.respond(false, undefined, {
            code: !admitted ? "FORBIDDEN" : rejected ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: !admitted
              ? "Open your own Rocky conversation and reconnect to use activities."
              : rejected
                ? error.message
                : "Couldn't load this activity. Refresh and try again.",
          });
        }
      },
      { scope: "operator.write", sessionAccess: { mode: "write", allowOwnSessionScope: true } },
    );
  }
}
