/**
 * OS keychain access, backed by `ExtensionContext.secrets`
 * (Docs/TARS_SPEC.md §3.2). This is a security boundary, not plumbing: it is the
 * reason an optional API-key override never lands in `settings.json`, which users
 * commit. Values written here are per-user and never synchronized.
 */
export interface SecretsPort {
  /** `null` rather than `undefined` so an absent secret is an explicit, matchable value. */
  get(key: string): Promise<string | null>;

  store(key: string, value: string): Promise<void>;

  delete(key: string): Promise<void>;
}
