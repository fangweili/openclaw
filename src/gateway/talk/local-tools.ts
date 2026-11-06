/**
 * Admission for client-executed Talk tool declarations. The RPC schema owns shape
 * validation; providers own parameter-schema compatibility. This stateless module
 * bounds model-facing metadata and keeps client names separate from Gateway tools.
 * It performs no I/O and retains no declarations, credentials or execution state.
 */
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME } from "../../talk/agent-run-control-shared.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../talk/describe-view-tool.js";
import type { RealtimeVoiceTool } from "../../talk/provider-types.js";

const MAX_LOCAL_TOOLS_BYTES = 32 * 1024;
const RESERVED_NAMES = [
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
  "memory_search",
];

/**
 * Check already schema-admitted metadata before minting provider credentials.
 * Return a content-free rejection, or undefined on success; inputs are borrowed
 * and never mutated. Reserved names remain unavailable even when not advertised.
 * Every currently projected Gateway tool is also protected against collisions.
 */
export function validateTalkLocalTools(
  localTools: readonly RealtimeVoiceTool[],
  gatewayTools: readonly RealtimeVoiceTool[],
): string | undefined {
  if (Buffer.byteLength(JSON.stringify(localTools), "utf8") > MAX_LOCAL_TOOLS_BYTES) {
    return "localTools exceeds the 32768-byte metadata limit";
  }
  const names = new Set([...RESERVED_NAMES, ...gatewayTools.map((tool) => tool.name)]);
  for (const tool of localTools) {
    if (names.has(tool.name)) {
      return "localTools contains a duplicate or reserved tool name";
    }
    names.add(tool.name);
  }
  return undefined;
}
