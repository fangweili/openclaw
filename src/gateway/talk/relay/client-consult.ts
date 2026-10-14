/**
 * Admits client-forwarded consults against an existing relay and prepares their
 * durable voice record. Owns no state: every synchronous call borrows the relay
 * through its connection/TTL owner. Selected participants use Gateway consultation
 * and are refused before client forwarding can create records or borrow authority.
 */
import { getRelaySession } from "./operations.js";
import { ensureRelayVoiceSession } from "./voice.js";

/** Reject unsupported forwarding before the caller starts any consult side effects. */
export function assertTalkRealtimeRelayClientToolCallAllowed(params: {
  relaySessionId: string;
  connId: string;
}): void {
  if (getRelaySession(params.relaySessionId, params.connId).participant) {
    throw new Error("Selected Talk participants require native agent consultation");
  }
}

/** Ensure a gateway-relay call has its durable record before transcript-free RPCs. */
export function ensureTalkRealtimeRelayVoiceSession(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.participant?.assertCurrent();
  if (session.sessionTarget.sessionKey !== params.sessionKey.trim()) {
    throw new Error("Realtime relay session belongs to another agent session");
  }
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created");
  }
}
