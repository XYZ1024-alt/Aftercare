import type { Tone } from '../lib/labels.ts';
import { SOLID_CLASS } from './ui.tsx';

// Small charts in plain CSS: thin bars, no grid, no axes. Every figure is
// also given in words (an accessible label, a title on hover, the legend).

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

/** Thin stacked columns, one per slot; ticks under the first, middle and last. */
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
      <div className="flex h-40 items-end">
        {slots.map((slot) => {
          const total = sum(slot.segments);
          return (
            <div
              key={slot.label}
              title={describe(slot)}
              className="flex h-full flex-1 items-end justify-center"
            >
              {total === 0 ? (
                <div className="h-1 w-[18px] max-w-[42%] rounded-bar bg-track" />
              ) : (
                <div
                  className="flex w-[18px] max-w-[42%] flex-col-reverse gap-px"
                  style={{ height: `${(total / max) * 100}%` }}
                >
                  {slot.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => (
                      <div
                        key={segment.label}
                        className={`min-h-1 rounded-bar opacity-85 ${SOLID_CLASS[segment.tone]}`}
                        style={{ flexGrow: segment.value }}
                      />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div aria-hidden className="mt-1.5 flex text-[11px] text-muted tabular-nums">
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
    <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-soft">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`size-2 rounded-bar ${SOLID_CLASS[item.tone]}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal bars, 10px high, against the largest value. */
export function HBars({
  rows,
  unit,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number; readonly tone: Tone }[];
  readonly unit: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="grid gap-2.5">
      {rows.map((row) => (
        <li
          key={row.label}
          className="grid grid-cols-[96px_minmax(0,1fr)_52px] items-center gap-2.5 text-meta"
        >
          <span className="truncate text-ink-soft">{row.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-track">
            {row.value > 0 && (
              <span
                className={`block h-full min-w-2 rounded-full ${SOLID_CLASS[row.tone]}`}
                style={{ width: `${(row.value / max) * 100}%` }}
              />
            )}
          </span>
          <span className="text-right text-ink-soft tabular-nums">
            {row.value} {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}
