import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostPorts } from '@tars/core';
import { WorkspaceIndex } from '@tars/core';
import type { InlineDiffController } from '@tars/host';
import {
  PROTOCOL_VERSION,
  assertNever,
  type HostToWebview,
  type ReviewActionMessage,
  type WebviewToHost,
} from '@tars/shared';
import { readOpenEditedFiles, readPermissionPolicy } from './config.js';
import { MentionProvider } from './mention-provider.js';
import { resolveWorkspacePath } from './paths.js';
import { ReviewController } from './review-controller.js';
import { SessionController } from './session-controller.js';

/** Must match the `views` contribution id in package.json. */
export const CHAT_VIEW_ID = 'tars.chat';

const WEBVIEW_DIR = ['dist', 'webview'];
const SCRIPT_PATH = [...WEBVIEW_DIR, 'assets', 'main.js'];
const STYLE_PATH = [...WEBVIEW_DIR, 'assets', 'main.css'];

/**
 * 128 bits of randomness per load. The nonce is what lets the CSP forbid inline
 * script wholesale while still permitting exactly our bundle (Docs/TARS_SPEC.md §5.4).
 */
function createNonce(): string {
  return randomBytes(16).toString('hex');
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private readonly controller: SessionController;
  private readonly review: ReviewController;
  private readonly index: WorkspaceIndex;
  private readonly mentions: MentionProvider;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ports: HostPorts,
    onBusyChanged: (busy: boolean) => void,
  ) {
    const post = (message: HostToWebview): void => {
      this.post(message);
    };
    // Both controllers outlive every `WebviewView` this provider resolves, so
    // they are built once here and torn down with the extension, not the panel.
    this.review = new ReviewController({
      ports,
      post,
      resolve: resolveWorkspacePath,
      openEditedFiles: () => readOpenEditedFiles(ports),
    });
    // The index builds lazily on first use, so a window whose panel is never
    // opened does not pay for the walk.
    this.index = new WorkspaceIndex({
      fileSystem: ports.fileSystem,
      workspace: ports.workspace,
      diagnostics: ports.diagnostics,
      fileWatcher: ports.fileWatcher,
      logger: ports.logger,
    });
    this.mentions = new MentionProvider({ ports, index: this.index });
    this.controller = new SessionController({
      ports,
      post,
      onBusyChanged,
      // The review controller sees the same stream the webview does, so the
      // checkpoint is taken from the `file_edit_proposed` event itself rather
      // than from a second, separately-ordered notification.
      onEvent: (event) => this.review.observe(event),
    });
  }

  /** Restores the workspace to a checkpoint. Reachable from the palette. */
  restoreCheckpoint(): Promise<void> {
    return this.review.restoreCheckpoint();
  }

  /** The in-editor hunk review, for the commands the CodeLenses invoke. */
  get inlineDiff(): InlineDiffController {
    return this.review.inlineDiff;
  }

  /** Opens the full side-by-side diff for a file under review. */
  openFullDiff(uri: vscode.Uri): Promise<void> {
    return this.review.review(uri.fsPath);
  }

  /** Starts a fresh conversation and brings the panel forward to show it. */
  async newSession(): Promise<void> {
    await this.controller.newSession();
    await this.reveal();
  }

  /** Stops the in-flight turn. Reachable from the palette with the view closed. */
  interrupt(): void {
    this.controller.interrupt();
  }

  /**
   * Releases the agent session. Idempotent, and awaited by `deactivate` — VS Code
   * will not wait for a subprocess we only asked to stop.
   */
  dispose(): Promise<void> {
    this.review.dispose();
    this.index.dispose();
    return this.controller.dispose();
  }

  /** Reveals the view, activating the extension if the container was never opened. */
  async reveal(): Promise<void> {
    if (this.view === null) {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      return;
    }
    this.view.show(true);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      // Narrower than the extension root: the webview can read its own assets and
      // nothing else on disk.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_DIR)],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.handleMessage(message);
    });

    view.onDidDispose(() => {
      this.view = null;
    });

    const configSubscription = this.ports.workspace.onConfigurationChanged(() => {
      this.post(this.configMessage());
    });
    view.onDidDispose(configSubscription);
  }

  private configMessage(): HostToWebview {
    const [folder] = this.ports.workspace.folders;
    return {
      type: 'config',
      permissionPolicy: readPermissionPolicy(this.ports),
      workspaceName: folder?.name ?? null,
    };
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'webview_ready': {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          // A stale webview can outlive an extension update in a live window.
          this.post({
            type: 'host_error',
            message: `Webview protocol ${String(message.protocolVersion)} does not match host protocol ${String(PROTOCOL_VERSION)}. Reload the window.`,
          });
          return;
        }
        this.post({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
        this.post(this.configMessage());
        // A remount is indistinguishable from a first mount on this side, so the
        // transcript is always re-seeded from the log; `restore` no-ops when there
        // is no session yet.
        await this.controller.restore();
        return;
      }
      case 'open_file': {
        const document = await vscode.workspace.openTextDocument(resolveWorkspacePath(message.path));
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        if (message.line !== undefined) {
          const position = new vscode.Position(Math.max(0, message.line - 1), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
        }
        return;
      }
      case 'send_prompt': {
        // Mentions are resolved here rather than in the webview: resolving a
        // path is privileged, and the index lives behind the port boundary.
        const resolved = await this.index.resolve(message.text);
        if (resolved.unresolved.length > 0) {
          // Named, not silently dropped: a user who typed `@thing.ts` and got
          // nothing must be told, or they will believe they attached a file.
          this.post({
            type: 'host_error',
            message: `TARS could not resolve: ${resolved.unresolved.map((name) => `@${name}`).join(', ')}`,
          });
        }
        await this.controller.sendPrompt(resolved.text, [
          ...message.context,
          ...resolved.context,
        ]);
        return;
      }
      case 'mention_query': {
        const candidates = await this.mentions.complete(message.query);
        this.post({ type: 'mention_results', query: message.query, candidates });
        return;
      }
      case 'interrupt': {
        this.controller.interrupt();
        return;
      }
      case 'permission_decision': {
        this.controller.decide(message.requestId, message.decision);
        return;
      }
      case 'new_session': {
        this.review.reset();
        await this.controller.newSession();
        return;
      }
      case 'review_action': {
        await this.handleReviewAction(message);
        return;
      }
      default:
        assertNever(message);
    }
  }

  private async handleReviewAction(message: ReviewActionMessage): Promise<void> {
    switch (message.action) {
      case 'keep':
        this.review.keep();
        return;
      case 'revert':
        await this.review.revert();
        return;
      case 'review':
        if (message.path !== undefined) {
          await this.review.review(message.path);
        }
        return;
      default:
        assertNever(message.action);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...SCRIPT_PATH));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...STYLE_PATH));

    // No external origins, no `unsafe-eval`, no inline script beyond the nonce'd
    // module tag. `img-src` allows data: URIs so inlined icons still render.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style.toString()}" />
    <title>TARS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`;
  }
}
