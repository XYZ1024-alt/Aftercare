import type { Tone } from '../lib/labels.ts';
import { SOLID_CLASS } from './ui.tsx';

// Small charts in plain CSS: rounded bars, no grid, no axes. Every figure is
// also given in words (an accessible label, a title on hover, the legend).
// Bars grow in once when they mount (@starting-style), never on a refresh.

export interface Segment {
  readonly label: string;
  readonly tone: Tone;
  readonly value: number;
}

export interface Slot {
  readonly label: string;
  readonly segments: readonly Segment[];
}

const sum = (segments: readonly Segment[]) =>
  segments.reduce((total, segment) => total + segment.value, 0);

const GROW =
  'transition-[scale] duration-(--duration-very-slow) ease-smooth-out motion-reduce:transition-none';

/** Stacked columns, one per slot; ticks under the first, middle and last. */
export function StackedBars({
  slots,
  label,
  describe,
}: {
  readonly slots: readonly Slot[];
  readonly label: string;
  readonly describe: (slot: Slot) => string;
}) {
  const max = Math.max(1, ...slots.map((slot) => sum(slot.segments)));
  const ticks = new Set([0, Math.floor((slots.length - 1) / 2), slots.length - 1]);
  return (
    <figure aria-label={label} className="m-0">
      <div className="flex h-44 items-end gap-1.5">
        {slots.map((slot) => {
          const total = sum(slot.segments);
          return (
            <div
              key={slot.label}
              title={describe(slot)}
              className="flex h-full flex-1 items-end justify-center rounded-bar transition-colors duration-(--duration-quick) hover:bg-canvas"
            >
              {total === 0 ? (
                <div className="h-1.5 w-full max-w-6 rounded-full bg-track" />
              ) : (
                <div
                  className={`flex w-full max-w-6 origin-bottom flex-col-reverse gap-[3px] starting:scale-y-0 ${GROW}`}
                  style={{ height: `${(total / max) * 100}%` }}
                >
                  {slot.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => (
                      <div
                        key={segment.label}
                        className={`min-h-1.5 rounded-bar ${SOLID_CLASS[segment.tone]}`}
                        style={{ flexGrow: segment.value }}
                      />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div aria-hidden className="mt-2 flex gap-1.5 text-[11px] text-muted tabular-nums">
        {slots.map((slot, index) => (
          <span key={slot.label} className="flex-1 text-center">
            {ticks.has(index) ? slot.label : ''}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function Legend({
  items,
}: {
  readonly items: readonly { readonly tone: Tone; readonly label: string }[];
}) {
  return (
    <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-soft">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`size-2.5 rounded-full ${SOLID_CLASS[item.tone]}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bars against the largest value. */
export function HBars({
  rows,
  unit,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number; readonly tone: Tone }[];
  readonly unit: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="grid content-between gap-3.5">
      {rows.map((row) => (
        <li
          key={row.label}
          className="grid grid-cols-[96px_minmax(0,1fr)_44px] items-center gap-3 text-meta"
        >
          <span className="inline-flex min-w-0 items-center gap-2 text-ink-soft">
            <span aria-hidden className={`size-2 shrink-0 rounded-full ${SOLID_CLASS[row.tone]}`} />
            <span className="truncate">{row.label}</span>
          </span>
          <span className="h-3 overflow-hidden rounded-full bg-track">
            {row.value > 0 && (
              <span
                className={`block h-full min-w-3 origin-left rounded-full starting:scale-x-0 ${GROW} ${SOLID_CLASS[row.tone]}`}
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            )}
          </span>
          <span className="text-right font-medium text-ink tabular-nums">
            {row.value}
            <span className="ml-0.5 font-normal text-muted">{unit}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
