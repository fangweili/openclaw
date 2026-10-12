/** Static hosting only; the browser authenticates tutor access with the Gateway. */
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createKidsUiHandler } from "./src/http.js";

export default definePluginEntry({
  id: "kids-ui",
  name: "Kids Tutor",
  description: "A minimal browser interface for a child's assigned tutor",
  register(api) {
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
