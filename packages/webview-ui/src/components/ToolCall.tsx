import { memo, type JSX } from 'react';
import type { ToolCallItem, ToolCallStatus } from '../store.js';
import { FilePath } from './FilePath.js';

interface ToolCallProps {
  readonly item: ToolCallItem;
}

/**
 * Glyphs rather than an icon font: the webview loads nothing from the network
 * (Docs/TARS_SPEC.md §5.4), and every one of these is a plain character that
 * inherits the theme's colour. The label beside it is what assistive tech reads.
 */
const STATUS: Record<ToolCallStatus, { readonly glyph: string; readonly label: string; readonly tone: string }> = {
  pending: { glyph: '◐', label: 'running', tone: 'text-description-fg' },
  ok: { glyph: '✓', label: 'succeeded', tone: 'text-success-fg' },
  error: { glyph: '✕', label: 'failed', tone: 'text-error-fg' },
};

export const ToolCall = memo(function ToolCall({ item }: ToolCallProps): JSX.Element {
  const status = STATUS[item.status];

  return (
    <details className="mx-3 my-1 rounded border border-widget-border bg-widget-bg">
      <summary className="flex items-center gap-2 px-2 py-1 hover:bg-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border">
        <span aria-hidden="true" className={status.tone}>
          {status.glyph}
        </span>
        <span className="font-mono">{item.toolName}</span>
        <span className="sr-only">{status.label}</span>
        {/* One line of the raw input, so a collapsed row still says what it acts on. */}
        <span className="min-w-0 flex-1 truncate text-description-fg">{item.inputJson}</span>
        {item.durationMs !== null && (
          <span className="text-description-fg">{item.durationMs}ms</span>
        )}
      </summary>

      <div className="border-t border-widget-border px-3 py-2">
        <h4 className="text-description-fg">Input</h4>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-code-bg px-2 py-1 font-mono">
          {item.inputJson === '' ? '—' : item.inputJson}
        </pre>

        {item.affectedPaths.length > 0 && (
          <>
            <h4 className="mt-2 text-description-fg">Affected files</h4>
            <ul className="flex flex-col items-start">
              {item.affectedPaths.map((path) => (
                <li key={path}>
                  <FilePath path={path} />
                </li>
              ))}
            </ul>
          </>
        )}

        {item.result !== null && (
          <>
            <h4 className="mt-2 text-description-fg">Result</h4>
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-code-bg px-2 py-1 font-mono ${
                item.status === 'error' ? 'text-error-fg' : ''
              }`}
            >
              {item.result}
            </pre>
          </>
        )}
      </div>
    </details>
  );
});
