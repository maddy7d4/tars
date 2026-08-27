import { memo, type JSX } from 'react';
import type { PlanStep } from '@tars/shared';
import type { PlanItem } from '../store.js';

interface PlanViewProps {
  readonly item: PlanItem;
}

const STEP_GLYPH: Record<PlanStep['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

/**
 * The agent's task list. `plan_update` always carries the complete list, so this
 * renders a snapshot and the reducer replaces it in place — a transcript that
 * accumulated one plan per update would bury the conversation in duplicates.
 */
export const PlanView = memo(function PlanView({ item }: PlanViewProps): JSX.Element {
  const done = item.steps.filter((step) => step.status === 'completed').length;

  return (
    <section aria-label="Plan" className="mx-3 my-1 rounded border border-widget-border bg-widget-bg px-3 py-2">
      <h3 className="text-description-fg">
        Plan ({done}/{item.steps.length})
      </h3>
      <ol className="mt-1 flex flex-col gap-0.5">
        {item.steps.map((step) => (
          <li key={step.id} className="flex items-baseline gap-2">
            <span aria-hidden="true" className={step.status === 'completed' ? 'text-success-fg' : ''}>
              {STEP_GLYPH[step.status]}
            </span>
            <span className={step.status === 'completed' ? 'text-description-fg line-through' : ''}>
              {step.title}
            </span>
            <span className="sr-only">{step.status.replace('_', ' ')}</span>
          </li>
        ))}
      </ol>
    </section>
  );
});
