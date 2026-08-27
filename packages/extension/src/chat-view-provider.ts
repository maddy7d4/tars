import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostPorts } from '@tars/core';
import {
  PROTOCOL_VERSION,
  assertNever,
  type HostToWebview,
  type WebviewToHost,
} from '@tars/shared';
import { readPermissionPolicy } from './config.js';
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ports: HostPorts,
    onBusyChanged: (busy: boolean) => void,
  ) {
    // The controller outlives every `WebviewView` this provider resolves, so it is
    // built once here and torn down with the extension, not with the panel.
    this.controller = new SessionController({
      ports,
      post: (message) => {
        this.post(message);
      },
      onBusyChanged,
    });
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
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        if (message.line !== undefined) {
          const position = new vscode.Position(Math.max(0, message.line - 1), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
        }
        return;
      }
      case 'send_prompt': {
        await this.controller.sendPrompt(message.text, message.context);
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
        await this.controller.newSession();
        return;
      }
      default:
        assertNever(message);
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
