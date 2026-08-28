import type { HostPorts, McpServerSpec } from '@tars/core';
import type { PermissionPolicy } from '@tars/shared';

/**
 * Manifest setting ids. Kept beside their readers so a rename in
 * `package.json` has exactly one place to land on this side.
 */
const PERMISSION_POLICY_SECTION = 'tars.permissionPolicy';
const TOOL_PERMISSIONS_SECTION = 'tars.toolPermissions';
const OPEN_EDITED_FILES_SECTION = 'tars.review.openEditedFiles';
const MCP_SERVERS_SECTION = 'tars.mcpServers';

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

/**
 * Whether a file the agent edits is brought forward so its hunks are visible.
 *
 * On by default: the review is in the editor, so a change in a file nobody opens
 * is a change nobody reviews. Off is for users who would rather drive from the
 * chat panel's file list on a turn that touches many files.
 */
export function readOpenEditedFiles(ports: HostPorts): boolean {
  return ports.workspace.getConfiguration<boolean>(OPEN_EDITED_FILES_SECTION, true);
}

/**
 * MCP servers the agent may use.
 *
 * Validated per entry rather than trusted, for the same reason as the tool
 * policies above: the manifest's JSON schema constrains what the settings UI
 * writes, but a hand-edited `settings.json` can carry anything, and a malformed
 * entry reaching the SDK would fail the whole session rather than one server.
 * A rejected entry is dropped and named in the log.
 *
 * Every tool an MCP server exposes is gated as a class by the permission broker
 * (§4.2). Configuring a server says it may run, not that it may run unattended.
 */
export function readMcpServers(ports: HostPorts): Readonly<Record<string, McpServerSpec>> {
  const raw = ports.workspace.getConfiguration<Record<string, unknown>>(MCP_SERVERS_SECTION, {});
  const log = ports.logger.child('config');
  const servers: Record<string, McpServerSpec> = {};

  for (const [name, value] of Object.entries(raw)) {
    const spec = toServerSpec(value);
    if (spec === null) {
      log.log('warn', 'ignoring a malformed MCP server entry', { server: name });
      continue;
    }
    servers[name] = spec;
  }
  return servers;
}

function toServerSpec(value: unknown): McpServerSpec | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const transport = record['transport'];

  if (transport === 'http' || transport === 'sse') {
    const url = record['url'];
    if (typeof url !== 'string' || url === '') {
      return null;
    }
    const headers = asStringRecord(record['headers']);
    return { transport, url, ...(headers === null ? {} : { headers }) };
  }

  // `stdio` is the default: it is what every locally-installed server uses, and
  // requiring the field would make the common case the verbose one.
  if (transport !== undefined && transport !== 'stdio') {
    return null;
  }
  const command = record['command'];
  if (typeof command !== 'string' || command === '') {
    return null;
  }
  const args = record['args'];
  const env = asStringRecord(record['env']);
  return {
    transport: 'stdio',
    command,
    ...(Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? { args } : {}),
    ...(env === null ? {} : { env }),
  };
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      return null;
    }
    result[key] = entry;
  }
  return result;
}
