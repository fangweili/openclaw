/**
 * Admits one administrator-selected child for a shared audio device. The controller
 * keeps transport ownership; the selected child supplies attribution, session access,
 * and a fixed read-only Talk ceiling. This is not a general impersonation capability.
 * Profile and session preparation use their owners' workers; retained checks reuse
 * published facts without database reads. Admission owns the lease until the relay
 * adopts it, then close releases it before provider teardown. Failed preparation
 * releases its own custody. No identity or selection is persisted here.
 */
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { withCommandSenderAuthority } from "../../auto-reply/command-sender-authority.js";
import { prepareSessionEntryMutationDatabases } from "../../config/sessions/session-accessor.entry-mutation.js";
import { operatorScopeSatisfied, roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { retainGatewayDeviceRevocation } from "../device-revocation.js";
import {
  authorizeCurrentOperatorRoleScopes,
  authorizeGatewaySessionCreation,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { gatewayClientSenderFields } from "../server-methods/gateway-client-identity.js";
import { isSyntheticGatewayCaller } from "../server-methods/gateway-personal-caller.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/types.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  authorizePreparedSessionMutation,
  type PreparedSessionMutationFacts,
} from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "../session-sharing-preparation.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const PARTICIPANT_SCOPES = ["operator.sessions.write", "operator.talk"];

function denied(message: string): never {
  throw new SessionMutationAuthorizationChangedError(errorShape(ErrorCodes.FORBIDDEN, message));
}

/**
 * Prepares a real controller's explicit, canonical child selection. Requires the
 * child's sole permitted agent and exact stable kids key, then applies the existing
 * own-session and sharing authorization. Never adopts aliases, another session, or
 * controller privileges. `bindSession` asynchronously retains published facts for the
 * ensured generation; later audio/consult checks perform no database reads. `close`
 * releases that custody and revokes admission without preventing transcript drainage.
 */
export async function prepareTalkParticipant(params: {
  profileId: string;
  target: PreparedTalkSessionTarget;
  controller: GatewayClient | null;
  context: GatewayRequestContext;
  hasCurrentClientAuthority?: () => boolean;
}) {
  const { controller, context, target, profileId } = params;
  const controllerProfileId = controller?.authenticatedUserProfile?.profileId;
  // Ambient tool identity matters at admission only. Later checks can run inside
  // the selected child's tool context without changing the controller's origin.
  if (isSyntheticGatewayCaller(controller)) {
    denied("Selecting a Talk participant requires a real administrator connection.");
  }
  const assertControllerCurrent = () => {
    if (
      !controller?.connId ||
      !controllerProfileId ||
      (controller.connect.role ?? "operator") !== "operator" ||
      controller.internal?.syntheticClient ||
      controller.internal?.agentRuntimeIdentity ||
      controller.internal?.agentToolCaller ||
      !hasGatewayAdminScope(controller) ||
      controller.invalidated ||
      controller.connectionSignal?.aborted ||
      !params.hasCurrentClientAuthority?.() ||
      controller.authenticatedUserProfile?.profileId !== controllerProfileId ||
      authorizeCurrentOperatorRoleScopes(controller, context.getRuntimeConfig())
    ) {
      denied("Selecting a Talk participant requires a current administrator connection.");
    }
  };
  assertControllerCurrent();
  const releaseController = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  let sessionFacts: SessionFactsRead<PreparedSessionMutationFacts> | undefined;
  try {
    const profile = await prepareUserProfileRoleAuthority(profileId);
    assertControllerCurrent();
    if (!profile || profile.profileId !== profileId || profileId === GATEWAY_OWNER_PROFILE_ID) {
      denied("Select an existing child profile by its current canonical ID.");
    }
    const sessionKey = `agent:${target.agentId}:kids:${encodeURIComponent(profileId).toLowerCase()}`;
    if (target.sessionKey !== sessionKey || target.canonicalKey !== sessionKey) {
      denied("The selected participant requires their own stable kids session.");
    }
    let closed = false;
    const assertIdentityCurrent = () => {
      assertControllerCurrent();
      if (closed || !profile.isCurrent()) {
        denied("The selected Talk participant changed; select the child again.");
      }
      const policy = resolveOperatorRolePolicyForAssignment(
        profileId,
        profile.role,
        context.getRuntimeConfig(),
        profile.githubLogin ?? null,
      );
      if (
        !policy ||
        policy.agents === "*" ||
        policy.agents.length !== 1 ||
        policy.agents[0] !== target.agentId ||
        policy.sessions.others !== "none" ||
        operatorScopeSatisfied("operator.admin", policy.scopes) ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: PARTICIPANT_SCOPES,
          allowedScopes: policy.scopes,
        })
      ) {
        denied("The selected participant needs a Talk role restricted to this one agent.");
      }
      return policy;
    };
    const role = assertIdentityCurrent();
    const sandboxRequired = role.sandbox === "required";
    const aliases = new Set(profile.aliases);
    const assertRoleCurrent = () => {
      const current = assertIdentityCurrent();
      if ((current.sandbox === "required") !== sandboxRequired) {
        denied("The selected participant's sandbox requirement changed; select the child again.");
      }
      return current;
    };
    // Build only child facts. Copying the controller would retain admin capability
    // symbols, authentication credentials, reviewer-device identity, or client caps.
    const client: GatewayClient = {
      connect: {
        minProtocol: controller!.connect.minProtocol,
        maxProtocol: controller!.connect.maxProtocol,
        client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
        role: "operator",
        scopes: [...PARTICIPANT_SCOPES],
        caps: [],
      },
      authenticatedUserProfile: {
        profileId,
        displayName: profile.display.displayName,
        hasAvatar: profile.display.hasAvatar,
        avatarRevision: profile.display.avatarRevision,
        updatedAt: 0,
      },
      internal: {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId },
        senderAttribution: {
          id: profileId,
          identity: { type: "profile", id: profileId },
          ...(profile.display.displayName ? { name: profile.display.displayName } : {}),
        },
      },
    };
    {
      // Settle first-use database creation before negative facts capture its source.
      // The facts lease takes over physical custody before this writer lease closes.
      await using storage = prepareSessionEntryMutationDatabases(
        [{ scope: target, assertCurrent: assertRoleCurrent }],
        Promise.resolve(),
      );
      sessionFacts = await prepareSessionMutationFacts({
        cfg: context.getRuntimeConfig(),
        agentId: target.agentId,
        sessionKey,
        allowMissing: true,
        storageReady: storage.preparations[0]!.then((prepared) => prepared.assertCurrent()),
      });
    }
    const initial = sessionFacts.readCurrent(context.getRuntimeConfig()).target;
    let expectedSessionId = initial?.entry.sessionId;
    let lifecycleRevision = initial?.entry.lifecycleRevision;
    let bound = false;
    const assertCurrent = () => {
      const currentRole = assertRoleCurrent();
      const cfg = context.getRuntimeConfig();
      const retained = sessionFacts!;
      const facts = retained.readCurrent(cfg);
      if (
        retained.storageTarget.agentId !== target.agentId ||
        retained.storageTarget.canonicalKey !== target.canonicalKey ||
        retained.storageTarget.storePath !== target.storePath ||
        facts.target?.entry.sessionId !== expectedSessionId ||
        facts.target?.entry.lifecycleRevision !== lifecycleRevision
      ) {
        denied("The selected participant's session was replaced.");
      }
      const error = facts.target
        ? authorizePreparedSessionMutation(
            { cfg, client, sessionKey, agentId: target.agentId },
            facts,
            { policy: currentRole, aliases },
          )
        : authorizeGatewaySessionCreation(
            { cfg, client, agentId: target.agentId },
            { policy: currentRole },
          );
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    };
    assertCurrent();
    const consultAuthority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    consultAuthority.senderId = profileId;
    if (consultAuthority.replyCaller) {
      consultAuthority.replyCaller = withCommandSenderAuthority(
        consultAuthority.replyCaller,
        () => {
          assertCurrent();
          return profileId;
        },
      );
    }
    return {
      metadata: Object.freeze({ profileId, agentId: target.agentId, sessionKey }),
      transcriptSender: gatewayClientSenderFields(client).sender,
      consultAuthority,
      creation: {
        ...resolveOperatorSessionCreation(client),
        ...(sandboxRequired ? { sandbox: "required" as const } : {}),
      },
      assertCurrent,
      async bindSession(sessionId: string) {
        if (bound) {
          denied("The selected participant's session is already bound.");
        }
        bound = true;
        if (initial) {
          if (sessionId !== expectedSessionId) {
            denied("The selected participant's session was replaced.");
          }
          assertCurrent();
          return;
        }
        // The negative read guards ensure's precommit. After that known write,
        // capture its returned generation before publishing the relay. The caller's
        // existing mutation authority also fences the original target around this await.
        assertRoleCurrent();
        const retained = await prepareSessionMutationFacts({
          cfg: context.getRuntimeConfig(),
          agentId: target.agentId,
          sessionKey,
        });
        try {
          const entry = retained.readCurrent(context.getRuntimeConfig()).target.entry;
          if (entry.sessionId !== sessionId) {
            denied("The selected participant's session was replaced.");
          }
          expectedSessionId = sessionId;
          lifecycleRevision = entry.lifecycleRevision;
          sessionFacts!.release();
          sessionFacts = retained;
          assertCurrent();
        } catch (error) {
          retained.release();
          throw error;
        }
      },
      close() {
        closed = true;
        sessionFacts?.release();
        releaseController?.();
      },
    };
  } catch (error) {
    sessionFacts?.release();
    releaseController?.();
    throw error;
  }
}

export type TalkParticipant = Awaited<ReturnType<typeof prepareTalkParticipant>>;
