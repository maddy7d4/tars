import type { WebviewToHost } from '@tars/shared';

/**
 * The bridge VS Code injects into every webview. Declared locally because
 * `@types/vscode` describes the extension host, not the webview sandbox.
 */
interface VsCodeWebviewApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeWebviewApi;
  }
}

/**
 * `acquireVsCodeApi` may be called only once per webview, so the handle is
 * memoized. Outside a webview (`vite dev`) it is absent, and messages are dropped
 * rather than throwing — the shell must still render for design work.
 */
const api: VsCodeWebviewApi | null = window.acquireVsCodeApi?.() ?? null;

export function postToHost(message: WebviewToHost): void {
  api?.postMessage(message);
}

export const isInsideWebview = api !== null;
