/**
 * Composes private tutor hosting, dictation, and optional saved activities. The
 * activity service owns database and media lifetimes; adapters borrow its live
 * facade. The Gateway remains the authority for child/session admission.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerKidsActivityContext } from "./src/activity-context.js";
import { registerKidsActivityGateway } from "./src/activity-gateway.js";
import { createActivityGeneration, type ActivityGeneration } from "./src/activity-generation.js";
import { registerKidsActivityService } from "./src/activity-service.js";
import { registerActivityTools } from "./src/activity-tools.js";
import { parseKidsConfig } from "./src/config.js";
import { createKidsUiHandler } from "./src/http.js";
import { registerKidsTranscription } from "./src/transcription.js";

export default definePluginEntry({
  id: "kids-ui",
  name: "Kids Tutor",
  description: "A minimal browser interface for a child's assigned tutor",
  configSchema: { parse: parseKidsConfig },
  register(api) {
    const { activities } = parseKidsConfig(api.pluginConfig);
    registerKidsTranscription(api);
    if (activities) {
      let generation: ActivityGeneration | null = null;
      const owner = registerKidsActivityService(api, {
        children: activities.children,
        startGeneration({ stateDir, signal }) {
          generation = createActivityGeneration({
            api,
            children: activities.children,
            mediaRoot: path.join(stateDir, "plugins", "kids-ui", "media"),
            referenceRoot: path.join(
              api.rootDir ?? path.dirname(fileURLToPath(import.meta.url)),
              "pets",
            ),
            store: owner,
            signal,
          });
        },
        async stopGeneration() {
          const current = generation;
          generation = null;
          await current?.close();
        },
      });
      registerKidsActivityGateway(api, owner, {
        children: activities.children,
        readImage(childId, imageId, assertCurrent) {
          if (!generation) {
            throw new Error("Activities are restarting. Try again shortly.");
          }
          return generation.readImage(childId, imageId, assertCurrent);
        },
      });
      registerKidsActivityContext(api, owner, activities.children);
      registerActivityTools(api, {
        children: activities.children,
        evidenceJobs: activities.evidenceJobs,
        getRuntime: () => (generation ? { generation, prepare: owner.prepare } : null),
      });
    }
    api.registerHttpRoute({
      path: "/kids",
      match: "prefix",
      // These assets contain no credentials or user data. All conversation access
      // goes through the Gateway's authenticated WebSocket and role policies.
      auth: "plugin",
      handler: createKidsUiHandler(fileURLToPath(new URL("./assets/", import.meta.url))),
    });
  },
});
