/** Definitive domain rejection: the activity mutation was not committed. */
export class ActivityInputError extends Error {
  readonly code = "KIDS_ACTIVITY_INVALID";
}
