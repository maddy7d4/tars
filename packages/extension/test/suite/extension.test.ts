import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Integration tests against a real editor (Docs/TARS_SPEC.md §8.1).
 *
 * Deliberately narrow. These assert the things only a real VS Code can answer —
 * that the manifest activates, that every contributed command is actually
 * registered, that the view is contributed where the manifest says, that the
 * settings schema matches what the readers expect. Behaviour lives in `core`,
 * where the dependency rule made it cheap to test.
 *
 * The recurring failure this catches is a manifest and an implementation that
 * drift: a command contributed but never registered shows up in the palette and
 * throws when invoked, and no unit test can see it.
 */

const EXTENSION_ID = 'tars.tars';

/** Every command the manifest contributes. Kept literal on purpose: reading it
 * back out of the manifest would let both sides drift together. */
const CONTRIBUTED_COMMANDS: readonly string[] = [
  'tars.openChat',
  'tars.newSession',
  'tars.interrupt',
  'tars.restoreCheckpoint',
  'tars.acceptHunk',
  'tars.rejectHunk',
  'tars.acceptFile',
  'tars.rejectFile',
  'tars.openFullDiff',
  'tars.showMemory',
  'tars.clearMemory',
  'tars.resumeSession',
];

suite('TARS activation', () => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} was not found`);

    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('every contributed command is registered', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = new Set(await vscode.commands.getCommands(true));

    // A command in the manifest but not in the registry appears in the palette
    // and throws when invoked — which no unit test can observe.
    const missing = CONTRIBUTED_COMMANDS.filter((command) => !registered.has(command));
    assert.deepEqual(missing, []);
  });

  test('the manifest contributes exactly the commands the suite knows about', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const contributes = extension.packageJSON as {
      contributes?: { commands?: readonly { command: string }[] };
    };
    const declared = (contributes.contributes?.commands ?? []).map((entry) => entry.command);

    // The other direction: a command added to the manifest without being added
    // here would otherwise never be checked for registration.
    assert.deepEqual([...declared].sort(), [...CONTRIBUTED_COMMANDS].sort());
  });
});

suite('TARS contributions', () => {
  test('the chat view is contributed to its own container', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const json = extension.packageJSON as {
      contributes?: {
        views?: Record<string, readonly { id: string }[]>;
        viewsContainers?: { activitybar?: readonly { id: string }[] };
      };
    };
    const containers = json.contributes?.viewsContainers?.activitybar ?? [];
    assert.ok(containers.length > 0, 'no activity bar container is contributed');

    const container = containers[0];
    assert.ok(container);
    const views = json.contributes?.views?.[container.id] ?? [];
    assert.ok(
      views.some((view) => view.id === 'tars.chat'),
      'the chat view is not contributed to the TARS container',
    );
  });

  test('the settings schema matches what the config readers expect', () => {
    const config = vscode.workspace.getConfiguration();

    // Defaults come from the manifest, so reading them back checks that the
    // schema and the readers in config.ts agree on names and types.
    assert.equal(config.get('tars.permissionPolicy'), 'ask');
    assert.deepEqual(config.get('tars.toolPermissions'), {});
    assert.equal(config.get('tars.review.openEditedFiles'), true);
    assert.deepEqual(config.get('tars.mcpServers'), {});
  });

  test('the engine floor is the one compatibility requires', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    // Raising this is an ADR-worthy decision (§8.4), not something a dependency
    // bump does incidentally — so it is asserted rather than trusted.
    const json = extension.packageJSON as { engines?: { vscode?: string } };
    assert.equal(json.engines?.vscode, '^1.90.0');
  });
});

suite('TARS in a real workspace', () => {
  test('a workspace folder is open, which TARS requires', () => {
    // Constraint C3: agent tools run in the workspace directory, so a session
    // cannot open without one.
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(folders.length, 1);
  });

  test('opening the chat view does not throw', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    // Resolving the webview exercises the CSP-bearing HTML and the asset URIs,
    // which are wrong in exactly the way a unit test cannot see.
    await vscode.commands.executeCommand('tars.openChat');
  });

  test('the diff scheme is registered, so review can serve baselines', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();

    const uri = vscode.Uri.from({ scheme: 'tars-diff', path: '/nothing.ts' });
    const document = await vscode.workspace.openTextDocument(uri);

    // An unknown URI is answered with an explanation rather than empty content,
    // which would render as "everything was added".
    assert.match(document.getText(), /TARS/);
  });

  test('interrupting with no session running is harmless', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    // Reachable from the palette at any time, so it must not throw when there is
    // nothing to stop.
    await vscode.commands.executeCommand('tars.interrupt');
  });
});
