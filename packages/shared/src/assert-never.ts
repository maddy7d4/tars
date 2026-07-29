/**
 * Exhaustiveness guard for discriminated unions. Placed in a `switch` default,
 * it turns "a new AgentEvent member was added and someone forgot to handle it"
 * from a silent runtime no-op into a compile error.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(x)}`);
}
