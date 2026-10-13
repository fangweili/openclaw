import "../styles/base.css";
import "./styles.css";
import { KidsApp } from "./app.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Rocky app container is missing");
}
const app = new KidsApp(root);
app.start();

// pagehide cancels microphone capture immediately; asynchronous cleanup is best
// effort during document destruction. BFCache restoration creates a fresh owner.
window.addEventListener("pagehide", () => void app.dispose());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    location.reload();
  }
});
