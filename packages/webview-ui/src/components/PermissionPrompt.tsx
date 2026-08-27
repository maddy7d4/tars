import { useEffect, useRef, type JSX } from 'react';
import type { PermissionPolicy } from '@tars/shared';
import type { PendingPermission } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { FilePath } from './FilePath.js';

interface PermissionPromptProps {
  readonly requests: readonly PendingPermission[];
}

function decide(requestId: string, decision: PermissionPolicy): void {
  postToHost({ type: 'permission_decision', requestId, decision });
}

/**
 * The safety gate (Docs/TARS_SPEC.md §4.2). The agent is blocked on this promise,
 * so the prompt is rendered in the input's place rather than as a dismissible
 * banner: there is no scroll position or transcript length at which a user can miss
 * it, and nothing else in the panel is actionable while it stands.
 *
 * Deny takes focus. A prompt that arrives while the user is typing must not turn a
 * stray Enter into approval of a shell command, so the keyboard default is the
 * decision that cannot destroy anything.
 *
 * Allowing is split in two because the two answers differ in blast radius, and a
 * single "Allow" that quietly carried the wider one would be the worst of both.
 * "Allow once" covers this invocation; "Always allow" stops prompting for the tool
 * for the rest of the session, and says so in the button rather than in a tooltip.
 */
export function PermissionPrompt({ requests }: PermissionPromptProps): JSX.Element | null {
  const head = requests[0];
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (head !== undefined) {
      denyRef.current?.focus();
    }
  }, [head?.requestId]);

  if (head === undefined) {
    return null;
  }

  return (
    <div className="border-t border-panel-border">
      {requests.map((request, index) => (
        <section
          key={request.requestId}
          role="alertdialog"
          aria-labelledby={`permission-title-${request.requestId}`}
          aria-describedby={`permission-body-${request.requestId}`}
          className="border-b border-widget-border bg-widget-bg px-3 py-2"
        >
          <h2 id={`permission-title-${request.requestId}`} className="font-mono">
            Allow <span className="text-warning-fg">{request.toolName}</span>?
          </h2>

          <div id={`permission-body-${request.requestId}`}>
            {request.affectedPaths.length > 0 && (
              <>
                <h3 className="mt-1 text-description-fg">Affected files</h3>
                <ul className="flex flex-col items-start">
                  {request.affectedPaths.map((path) => (
                    <li key={path}>
                      <FilePath path={path} />
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="mt-1 text-description-fg">Arguments</h3>
            {/* Verbatim: the shape is tool-specific and summarizing it could hide the
                one field — a path, a flag, a URL — the decision actually turns on. */}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-code-bg px-2 py-1 font-mono">
              {JSON.stringify(request.input, null, 2)}
            </pre>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              ref={index === 0 ? denyRef : null}
              onClick={() => {
                decide(request.requestId, 'deny');
              }}
              className="rounded bg-secondary-bg px-3 py-1 text-secondary-fg hover:bg-secondary-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => {
                // `ask` as a decision means "approved, but do not promote the tool" —
                // the broker's vocabulary for a one-shot allow.
                decide(request.requestId, 'ask');
              }}
              className="rounded bg-button-bg px-3 py-1 text-button-fg hover:bg-button-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => {
                decide(request.requestId, 'always_allow');
              }}
              title={`Stop asking about ${request.toolName} until this session ends`}
              className="rounded bg-secondary-bg px-3 py-1 text-secondary-fg hover:bg-secondary-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
            >
              Always allow
            </button>
            <span className="text-description-fg">default: {request.defaultPolicy}</span>
          </div>
        </section>
      ))}
    </div>
  );
}
