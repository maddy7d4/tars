import type { HostPorts } from '@tars/core';
import type { PermissionPolicy } from '@tars/shared';

/**
 * Manifest setting ids. Kept beside their readers so a rename in
 * `package.json` has exactly one place to land on this side.
 */
const PERMISSION_POLICY_SECTION = 'tars.permissionPolicy';
const TOOL_PERMISSIONS_SECTION = 'tars.toolPermissions';

function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  return value === 'always_allow' || value === 'ask' || value === 'deny';
}

/** Session-wide default for gated tools (Docs/TARS_SPEC.md §4.2). */
export function readPermissionPolicy(ports: HostPorts): PermissionPolicy {
  const value = ports.workspace.getConfiguration<string>(PERMISSION_POLICY_SECTION, 'ask');
  // Settings files are user-editable text: an unrecognised value falls back to the
  // safe default rather than being forwarded to the broker as an unknown policy.
  return isPermissionPolicy(value) ? value : 'ask';
}

/**
 * Per-tool overrides, e.g. `{ "Bash": "deny" }`. §4.2 requires policy to be
 * configurable *per tool*, and `SessionOptions.toolPolicies` is where that lands.
 *
 * Entries are validated rather than trusted: the manifest's JSON schema only
 * constrains what the settings UI writes, and a hand-edited `.vscode/settings.json`
 * can still carry anything. An unrecognised value is dropped, which leaves the tool
 * on the session default — never silently promoted to `always_allow`.
 */
export function readToolPolicies(ports: HostPorts): Readonly<Record<string, PermissionPolicy>> {
  const raw = ports.workspace.getConfiguration<Record<string, unknown>>(
    TOOL_PERMISSIONS_SECTION,
    {},
  );
  const policies: Record<string, PermissionPolicy> = {};
  for (const [toolName, value] of Object.entries(raw)) {
    if (isPermissionPolicy(value)) {
      policies[toolName] = value;
    }
  }
  return policies;
}
