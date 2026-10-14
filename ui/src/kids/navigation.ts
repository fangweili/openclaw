/**
 * Kids URLs carry presentation only. These three fragments never select an
 * identity, tutor, conversation, activity ID, or permission. KidsApp owns applying
 * them after conversation admission and while microphone navigation is allowed.
 */
export type KidsPage = "today" | "solve" | "chat";

/** Parse only an explicit page fragment; callers choose the default for no match. */
export function parseKidsPage(hash: unknown): KidsPage | null {
  return hash === "#today"
    ? "today"
    : hash === "#solve"
      ? "solve"
      : hash === "#chat"
        ? "chat"
        : null;
}
