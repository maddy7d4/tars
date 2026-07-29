/**
 * Nominal typing helper. A `Brand` exists only in the type system — it costs
 * nothing at runtime, but makes passing a `SessionId` where a `ProviderId` is
 * expected a compile error. Raw `string` ids are indistinguishable and were the
 * source of real defects in comparable systems.
 */
export type Brand<T, K extends string> = T & { readonly __brand: K };

/** Identifies one agent conversation and its append-only event log file. */
export type SessionId = Brand<string, 'SessionId'>;

/** Identifies a registered provider implementation, e.g. `'claude-code'`. */
export type ProviderId = Brand<string, 'ProviderId'>;

/** Identifies one user turn and every event emitted while answering it. */
export type TurnId = Brand<string, 'TurnId'>;

/** Narrows a validated string into a `SessionId`. */
export function toSessionId(value: string): SessionId {
  return value as SessionId;
}

/** Narrows a validated string into a `ProviderId`. */
export function toProviderId(value: string): ProviderId {
  return value as ProviderId;
}

/** Narrows a validated string into a `TurnId`. */
export function toTurnId(value: string): TurnId {
  return value as TurnId;
}
