'use client';

import type { Refusal } from '@aftercare/console/client';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../lib/labels.ts';

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'border-stone-300 bg-stone-100 text-stone-700',
  active: 'border-sky-300 bg-sky-50 text-sky-800',
  waiting: 'border-amber-300 bg-amber-50 text-amber-900',
  good: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  partial: 'border-teal-300 bg-teal-50 text-teal-900',
  warning: 'border-orange-300 bg-orange-50 text-orange-900',
  bad: 'border-rose-300 bg-rose-50 text-rose-800',
};

const TONE_ICON = {
  neutral: CircleDashed,
  active: Loader2,
  waiting: Clock,
  good: CheckCircle2,
  partial: ShieldAlert,
  warning: AlertTriangle,
  bad: XCircle,
} as const;

/** A status is always said in words, with an icon; colour only supports it. */
export function Badge({
  tone,
  children,
  testId,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

export function Card({
  title,
  aside,
  children,
  testId,
}: {
  readonly title?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-lg border border-stone-200 bg-white">
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonTone = 'primary' | 'plain' | 'danger';
const BUTTON_CLASS: Readonly<Record<ButtonTone, string>> = {
  primary: 'bg-stone-900 text-white hover:bg-stone-700 border-stone-900',
  plain: 'bg-white text-stone-800 hover:bg-stone-100 border-stone-300',
  danger: 'bg-white text-rose-700 hover:bg-rose-50 border-rose-300',
};

export function Button({
  tone = 'plain',
  pending = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: ButtonTone;
  readonly pending?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || pending}
      className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_CLASS[tone]} ${rest.className ?? ''}`}
    >
      {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
      {children}
    </button>
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
      className="mt-2 flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900"
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
  const Icon = TONE_ICON[tone === 'active' ? 'neutral' : tone];
  return (
    <p
      data-testid={testId}
      className={`flex items-start gap-2 rounded border px-3 py-2 text-sm ${TONE_CLASS[tone]}`}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
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
    <details className="mt-2 text-xs text-stone-600">
      <summary className="cursor-pointer select-none text-stone-500 hover:text-stone-800">
        {label}
      </summary>
      <div className="mt-2 space-y-1 break-all font-mono">{children}</div>
    </details>
  );
}

export function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is always passed as the child of this label.
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}

export const INPUT_CLASS =
  'w-full rounded border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-stone-500 focus:outline-none';

export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-stone-500">{children}</p>;
}

export function Json({ value }: { readonly value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded bg-stone-100 p-3 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
