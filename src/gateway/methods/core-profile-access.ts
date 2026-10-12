import { isSessionProfileDependentMethod } from "../session-method-policy.js";

const PROFILE_DEPENDENT_CORE_METHODS = new Set([
  "agent.wait",
  // The first UI interaction may arrive before post-hello identity hydration.
  "presence.activity",
  // Wait for post-hello identity enrichment so an identified caller does not
  // cache a shared-only catalog before their personal accounts are available.
  "models.list",
  "presence.query",
  // Subscription ownership must use hydrated identity, never a temporary
  // profile-less connection during post-hello authentication.
  "push.web.subscribe",
  "push.web.unsubscribe",
  "push.web.preferences.get",
  "push.web.preferences.set",
  "webSearch.status",
  "webSearch.test",
  // talk.config projects the caller's profile accent; without this gate a
  // client asking during the post-hello GitHub identity sync window would get
  // the gateway-wide accent instead. Profile-less clients pass through.
  "talk.config",
  // Transcript-producing admission captures trusted caller attribution. Identified
  // clients wait for enrichment; truly profile-less callers remain supported.
  "talk.client.create",
  "talk.client.transcript",
  "talk.session.create",
  // Voice catalogs authorize participation in the call's chat.
  "talk.voice.get",
  "ui.command",
  "users.linkAuthProfile",
  "users.linkEmail",
  "users.merge",
  "users.linkChannelIdentity",
  "users.unlinkChannelIdentity",
  "users.listChannelIdentities",
  "users.listAuthLinks",
  "users.listModelAccounts",
  "users.selectModelAccount",
  "users.mentionable",
  "users.setAvatar",
  "users.setDisplayName",
  "users.setRole",
  "users.unlinkAuthProfile",
]);
const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "mentions.",
  "openclaw.approval.",
  "openclaw.chat",
  "progressCard.",
  "projects.",
  "secrets.",
  "session.",
  "sessions.",
  "taskSuggestions.",
  "terminal.",
  "transcripts.",
  "users.authConnect.",
  "users.prefs.",
  "themes.",
  "users.github.",
  "skills.library.",
] as const;

/** Classifies core methods whose behavior reads or mutates durable user/session ownership. */
export function isCoreGatewayMethodProfileDependent(method: string): boolean {
  return (
    isSessionProfileDependentMethod(method) ||
    PROFILE_DEPENDENT_CORE_METHODS.has(method) ||
    PROFILE_DEPENDENT_CORE_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}
