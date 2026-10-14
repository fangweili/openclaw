// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
export { createTalkRealtimeRelaySession } from "./session-create.js";
export {
  assertTalkRealtimeRelayClientToolCallAllowed,
  ensureTalkRealtimeRelayVoiceSession,
} from "./client-consult.js";
export {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./operations.js";
