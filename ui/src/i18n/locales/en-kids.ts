/** Kids-only English stays outside the administrator UI's startup catalog. */
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enKids = {
  kids: {
    name: "Rocky",
    you: "You",
    conversation: "Your conversation with Rocky",
    here: "Here for you",
    thinking: "Rocky is replying…",
    connecting: "Connecting…",
    unavailable: "Let’s reconnect",
    connectionTitle: "Rocky can’t connect yet",
    retry: "Try again",
    welcome: "What’s on your mind?",
    welcomeDetail:
      "A tricky question, a little practice, or something you’re curious about. Let’s figure it out together.",
    message: "Message Rocky",
    placeholder: "Ask Rocky anything…",
    send: "Send message",
    talk: "Talk to Rocky",
    endCall: "End call",
    liveVoice: "Live conversation with Rocky",
    voiceHint: "Just talk naturally. You can interrupt me anytime.",
    voice: {
      idle: "Ready to talk",
      connecting: "Getting ready…",
      listening: "I’m listening",
      thinking: "Let me think…",
      stopping: "Finishing our call…",
      error: "Let’s try that again",
    },
    reconnectDetail: "Check that Tailscale is connected, then try again.",
    pairingDetail: "Ask a parent to finish connecting this device to your Rocky.",
    voiceUnavailable: "Text is ready. Ask a parent to enable voice for your account.",
    setupNeeded: "Ask a parent to connect your own account to your Rocky tutor.",
    connectionError: "Rocky could not connect. Try reconnecting, or ask a parent for help.",
    sendUncertain: "Checking whether your message arrived. Please wait before sending it again.",
    sendFailed: "Your message was not sent. Check the conversation and try again.",
    historyFailed: "The conversation could not refresh. Reconnect to continue.",
    runFailed: "Rocky could not finish that reply. You can try asking again.",
    inputInterrupted: "A message did not finish. You can send it again when you’re ready.",
    notifications: {
      enable: "Notify me",
      disable: "Turn off notifications",
      enabled: "Notifications are on",
      working: "Setting up notifications…",
      installRequired:
        "On iPhone or iPad, choose Share → Add to Home Screen, then open Rocky from there to turn on notifications.",
      unavailable:
        "This browser does not support notifications. You can still chat with Rocky here.",
      blocked:
        "Notifications are blocked. Allow them in your browser or device settings, then reopen Rocky.",
      failed: "Notifications could not be turned on. Try again.",
      workerUnavailable: "Notifications are not ready yet. Reload Rocky and try again.",
      connectionMismatch:
        "This device’s notifications belong to another connection. Ask a parent to reconnect them.",
    },
  },
} satisfies TranslationMap;

/** Registers synchronously before a kids consumer renders; repeated calls are harmless. */
export const registerKidsEnglish = Object.assign(() => Object.assign(en.kids, enKids.kids), {
  catalog: enKids,
});
