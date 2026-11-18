'use client';

import type { Refusal } from '@aftercare/console/client';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  SearchCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import type { Tone } from '../lib/labels.ts';

// The primitives of the console. Colour follows the tone roles of labels.ts;
// every state is also said in words.

/** Soft background and dark text of a tone: pills, notices. */
export const SOFT_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-track text-ink-soft',
  sky: 'bg-sky-soft text-sky-ink',
  violet: 'bg-violet-soft text-violet-ink',
  apricot: 'bg-apricot-soft text-apricot-ink',
  mint: 'bg-mint-soft text-mint-ink',
  rose: 'bg-rose-soft text-rose-ink',
};

/** The solid colour of a tone: dots, bars, legends. */
export const SOLID_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-muted',
  sky: 'bg-sky',
  violet: 'bg-violet',
  apricot: 'bg-apricot',
  mint: 'bg-mint',
  rose: 'bg-rose',
};

const WASH_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-canvas-2',
  sky: 'bg-sky-wash',
  violet: 'bg-violet-wash',
  apricot: 'bg-apricot-wash',
  mint: 'bg-mint-wash',
  rose: 'bg-rose-wash',
};

const INK_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'text-ink-soft',
  sky: 'text-sky-ink',
  violet: 'text-violet-ink',
  apricot: 'text-apricot-ink',
  mint: 'text-mint-ink',
  rose: 'text-rose-ink',
};

const SELECTED_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-ink text-white',
  sky: 'bg-sky-ink text-white',
  violet: 'bg-violet-ink text-white',
  apricot: 'bg-apricot-ink text-white',
  mint: 'bg-mint-ink text-white',
  rose: 'bg-rose-ink text-white',
};

const NOTICE_ICON = {
  neutral: Info,
  sky: Info,
  violet: SearchCheck,
  apricot: AlertTriangle,
  mint: CheckCircle2,
  rose: XCircle,
} as const;

/** A status, in words, on the soft colour of its tone. */
export function Pill({
  tone,
  children,
  testId,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-block w-max max-w-full rounded-full px-[9px] py-[3px] text-xs font-medium ${SOFT_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Dot({
  tone,
  className = '',
}: {
  readonly tone: Tone;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2.5 shrink-0 rounded-full ${SOLID_CLASS[tone]} ${className}`}
    />
  );
}

export function Card({
  title,
  description,
  aside,
  children,
  testId,
  className = '',
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`min-w-0 rounded-panel bg-card px-[22px] py-5 shadow-soft max-sm:px-4 ${className}`}
    >
      {(title !== undefined || aside !== undefined) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {title !== undefined && <h2 className="text-base font-medium">{title}</h2>}
            {description !== undefined && (
              <p className="mt-0.5 text-meta text-muted">{description}</p>
            )}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

/** A heading for a group of cards. */
export function SectionHeading({ children }: { readonly children: ReactNode }) {
  return <h2 className="mb-3 text-base font-medium">{children}</h2>;
}

export function PageHead({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-title font-medium max-sm:text-[24px] max-sm:leading-[30px]">{title}</h1>
        {description !== undefined && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/**
 * primary: the default action. sandbox: an action on the case's sandbox.
 * approval: an approval. danger: removes, revokes or cancels. secondary: everything else.
 */
export type ButtonTone = 'primary' | 'secondary' | 'sandbox' | 'approval' | 'danger';
const BUTTON_TONE: Readonly<Record<ButtonTone, string>> = {
  primary: 'border-ink bg-ink text-white enabled:hover:border-ink-soft enabled:hover:bg-ink-soft',
  secondary: 'border-ink/20 bg-card text-ink enabled:hover:border-ink/50',
  sandbox: 'border-mint-ink bg-mint-ink text-white enabled:hover:border-mint enabled:hover:bg-mint',
  approval:
    'border-apricot-ink bg-apricot-ink text-white enabled:hover:border-apricot enabled:hover:bg-apricot',
  danger:
    'border-rose/45 bg-card text-rose-ink enabled:hover:border-rose enabled:hover:bg-rose-soft',
};
const BUTTON_SIZE = { md: 'h-10 px-4 text-sm', sm: 'h-8 px-3 text-meta' } as const;

export const buttonClass = (
  tone: ButtonTone = 'secondary',
  size: keyof typeof BUTTON_SIZE = 'md',
) =>
  `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border font-medium transition-colors duration-160 disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_TONE[tone]} ${BUTTON_SIZE[size]}`;

export function Button({
  tone = 'secondary',
  size = 'md',
  pending = false,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: ButtonTone;
  readonly size?: keyof typeof BUTTON_SIZE;
  readonly pending?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || pending}
      className={`${buttonClass(tone, size)} ${className}`}
    >
      {pending && <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
      {children}
    </button>
  );
}

export function ButtonLink({
  tone = 'secondary',
  children,
  ...rest
}: ComponentProps<typeof Link> & { readonly tone?: ButtonTone }) {
  return (
    <Link {...rest} className={buttonClass(tone)}>
      {children}
    </Link>
  );
}

/** A filter or a segment: off is a white chip, on is dark (or the dark ink of its tone). */
export function Chip({
  active,
  tone = 'neutral',
  count,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly active: boolean;
  readonly tone?: Tone;
  readonly count?: number;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-meta font-medium transition-colors duration-160 ${active ? SELECTED_CLASS[tone] : 'bg-card text-ink-soft shadow-soft hover:text-ink'}`}
    >
      {children}
      {count !== undefined && (
        <span className={`tabular-nums ${active ? 'text-white/70' : 'text-muted'}`}>{count}</span>
      )}
    </button>
  );
}

/** An overview figure: a large near-black number on a white card, framed by the wash of its tone. */
export function MetricCard({
  tone,
  label,
  value,
  unit,
  foot,
}: {
  readonly tone: Tone;
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly foot?: ReactNode;
}) {
  return (
    <div className={`min-w-0 rounded-panel p-2.5 ${WASH_CLASS[tone]}`}>
      <div className="flex h-full min-h-33 flex-col rounded-block bg-card px-5 pt-[18px] pb-4 shadow-card">
        <p className={`mb-2 text-meta font-medium ${INK_CLASS[tone]}`}>{label}</p>
        <p className="flex items-baseline gap-2">
          <span className="text-display font-bold tabular-nums lining-nums max-lg:text-[44px] max-sm:text-[40px]">
            {value}
          </span>
          {unit !== undefined && <span className="text-base font-medium text-muted">{unit}</span>}
        </p>
        {foot !== undefined && <p className="mt-auto pt-2.5 text-meta text-ink-soft">{foot}</p>}
      </div>
    </div>
  );
}

/** Why the server refused, in its words, and what to do about it. */
export function RefusalNote({ refusal }: { readonly refusal: Refusal | null }) {
  if (refusal === null) {
    return null;
  }
  return (
    <p
      role="alert"
      data-testid="refusal"
      data-code={refusal.code}
      className="mt-3 flex items-start gap-2.5 rounded-input bg-rose-soft px-3.5 py-2.5 text-sm text-rose-ink"
    >
      <Ban aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-medium">未执行（{refusal.code}）：</span>
        {refusal.message}
        {refusal.recovery === 'reload_and_review' && ' 页面内容已刷新，请重新审核后再操作。'}
      </span>
    </p>
  );
}

export function Notice({
  tone,
  children,
  testId,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      data-testid={testId}
      className={`flex items-start gap-2.5 rounded-input px-3.5 py-2.5 text-sm ${SOFT_CLASS[tone]}`}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Technical detail (ids, digests, raw records): available, never in the way. */
export function Technical({
  label = '技术详情',
  children,
}: {
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="group mt-3 text-xs text-muted">
      <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-full hover:text-ink-soft [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform motion-safe:duration-160"
        />
        {label}
      </summary>
      <div className="mt-2 space-y-1 break-all font-mono text-ink-soft">{children}</div>
    </details>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is always passed as the child of this label.
    <label className="block min-w-0">
      <span className="mb-1.5 block text-meta font-medium text-ink-soft">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const INPUT_CLASS =
  'w-full rounded-input border border-line bg-card px-3 py-2.5 text-body text-ink transition-[border-color,box-shadow] duration-160 placeholder:text-muted/70 focus-visible:border-sky focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-sky-soft disabled:bg-track disabled:text-muted';

export const CHECK_CLASS = 'mt-0.5 size-4 shrink-0 accent-ink';

/** A choice among several, as a whole clickable row (a label around a checkbox or radio). */
export const OPTION_CLASS =
  'flex cursor-pointer items-start gap-3 rounded-input border border-line px-3.5 py-2.5 text-sm transition-colors duration-160 hover:border-ink/30 has-checked:border-ink/40 has-checked:bg-canvas';

/** Rows separated by a hairline, inside a card. */
export const ROWS_CLASS =
  'divide-y divide-line [&>li]:py-3 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0';

export function Table({ children }: { readonly children: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-sm [&_.num]:text-right [&_.num]:tabular-nums [&_td]:border-line [&_td]:border-b [&_td]:py-3 [&_td]:pr-4 [&_td]:align-top [&_th]:border-line [&_th]:border-b [&_th]:pr-4 [&_th]:pb-2.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted [&_th]:text-xs [&_tr:last-child_td]:border-b-0 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
        {children}
      </table>
    </div>
  );
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-field bg-canvas/70 px-5 py-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Loading({ label = '加载中…' }: { readonly label?: string }) {
  return (
    <div role="status" className="space-y-3 py-2">
      <p className="text-meta text-muted">{label}</p>
      {['w-3/5', 'w-11/12', 'w-3/4'].map((width) => (
        <div
          key={width}
          className={`h-3.5 rounded-lg bg-track motion-safe:animate-pulse ${width}`}
        />
      ))}
    </div>
  );
}

export function Json({ value }: { readonly value: object | string | number | boolean | null }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-input bg-canvas p-3 font-mono text-xs leading-5 text-ink-soft">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
