'use client';

import type { Refusal } from '@aftercare/console/client';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  type LucideIcon,
  SearchCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  Fragment,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Tone } from '../lib/labels.ts';

// The primitives of the console. Colour follows the tone roles of labels.ts and
// fills a surface from the inside; every state is also said in words.

/** Soft background and dark text of a tone: pills, notices. */
export const SOFT_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-track text-ink-soft',
  sky: 'bg-sky-soft text-sky-ink',
  violet: 'bg-violet-soft text-violet-ink',
  apricot: 'bg-apricot-soft text-apricot-ink',
  mint: 'bg-mint-soft text-mint-ink',
  rose: 'bg-rose-soft text-rose-ink',
};

/** The stronger tint of a tone with its dark text: icon tiles, tinted cards. */
export const WASH_CLASS: Readonly<Record<Tone, string>> = {
  neutral: 'bg-canvas-2 text-ink-soft',
  sky: 'bg-sky-wash text-sky-ink',
  violet: 'bg-violet-wash text-violet-ink',
  apricot: 'bg-apricot-wash text-apricot-ink',
  mint: 'bg-mint-wash text-mint-ink',
  rose: 'bg-rose-wash text-rose-ink',
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

/** The dark text of a tone. */
export const INK_CLASS: Readonly<Record<Tone, string>> = {
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

const NOTICE_ICON: Readonly<Record<Tone, LucideIcon>> = {
  neutral: Info,
  sky: Info,
  violet: SearchCheck,
  apricot: AlertTriangle,
  mint: CheckCircle2,
  rose: XCircle,
};

/** Quick, state-change motion shared by the controls (hover, press, select). */
const MOTION = 'duration-(--duration-quick) ease-smooth-out motion-reduce:transition-none';

/** Style of a `.t-enter` block that enters `index` stagger steps after its first sibling. */
export const stagger = (index: number): CSSProperties =>
  ({ '--enter-index': index }) as CSSProperties;

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
      className={`inline-block w-max max-w-full rounded-full px-2.5 py-[3px] text-xs font-medium ${SOFT_CLASS[tone]}`}
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

/** A rounded square holding an icon, tinted by its tone. */
export function IconTile({
  icon: Icon,
  tone,
  size = 'md',
}: {
  readonly icon: LucideIcon;
  readonly tone: Tone;
  readonly size?: 'sm' | 'md';
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center ${size === 'md' ? 'size-9 rounded-xl' : 'size-7 rounded-lg'} ${WASH_CLASS[tone]}`}
    >
      <Icon className={size === 'md' ? 'size-[18px]' : 'size-4'} strokeWidth={2} />
    </span>
  );
}

export function Card({
  title,
  description,
  aside,
  icon,
  tone = 'neutral',
  children,
  testId,
  className = '',
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly aside?: ReactNode;
  /** An icon tile before the title, tinted by `tone`. */
  readonly icon?: LucideIcon;
  readonly tone?: Tone;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`min-w-0 rounded-panel bg-card p-6 shadow-soft max-sm:p-4 ${className}`}
    >
      {(title !== undefined || aside !== undefined) && (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            {icon !== undefined && <IconTile icon={icon} tone={tone} />}
            <div className="min-w-0">
              {title !== undefined && (
                <h2 className="text-[17px] leading-6 font-medium tracking-[-0.01em]">{title}</h2>
              )}
              {description !== undefined && (
                <p className="mt-0.5 text-meta text-muted">{description}</p>
              )}
            </div>
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
  return <h2 className="mb-3 px-1 text-[17px] leading-6 font-medium">{children}</h2>;
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
    <div className="t-enter mb-7 flex flex-wrap items-end justify-between gap-4 max-sm:mb-5">
      <div className="min-w-0">
        <h1 className="text-title font-semibold max-sm:text-[26px] max-sm:leading-8">{title}</h1>
        {description !== undefined && <p className="mt-1.5 text-sm text-muted">{description}</p>}
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
  primary: 'bg-ink text-white shadow-soft enabled:hover:bg-ink-soft',
  secondary: 'bg-card text-ink shadow-soft ring-1 ring-ink/10 enabled:hover:bg-canvas',
  sandbox: 'bg-mint-ink text-white shadow-soft enabled:hover:bg-mint-ink/88',
  approval: 'bg-apricot-ink text-white shadow-soft enabled:hover:bg-apricot-ink/88',
  danger: 'bg-rose-soft text-rose-ink enabled:hover:bg-rose-wash',
};
const BUTTON_SIZE = { md: 'h-10 px-[18px] text-sm', sm: 'h-8 px-3.5 text-meta' } as const;

export const buttonClass = (
  tone: ButtonTone = 'secondary',
  size: keyof typeof BUTTON_SIZE = 'md',
) =>
  `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,scale] ${MOTION} enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_TONE[tone]} ${BUTTON_SIZE[size]}`;

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
    <Link {...rest} className={`${buttonClass(tone)} active:scale-[0.97]`}>
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
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-meta font-medium transition-[background-color,color,scale] ${MOTION} active:scale-[0.97] ${active ? SELECTED_CLASS[tone] : 'bg-card text-ink-soft shadow-soft hover:text-ink'}`}
    >
      {tone !== 'neutral' && !active && <Dot tone={tone} className="size-2" />}
      {children}
      {count !== undefined && (
        <span className={`tabular-nums ${active ? 'text-white/70' : 'text-muted'}`}>{count}</span>
      )}
    </button>
  );
}

/**
 * Tabs sliding (transitions.dev): one pill travels to the item marked
 * data-active="true" inside the bar. The first placement and every resize of
 * the bar snap without a transition; a change of `active` tweens.
 */
export function useSlidingPill<T extends HTMLElement>(active: string | null) {
  const bar = useRef<T>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const element = pill.current;
    const container = bar.current;
    if (element === null || container === null) return;
    const place = (animate: boolean) => {
      const target =
        active === null ? null : container.querySelector<HTMLElement>('[data-active="true"]');
      if (target === null) {
        element.style.opacity = '0';
        shown.current = false;
        return;
      }
      const snap = !animate || !shown.current;
      if (snap) element.style.transition = 'none';
      element.style.opacity = '1';
      element.style.transform = `translateX(${target.offsetLeft}px)`;
      element.style.width = `${target.offsetWidth}px`;
      if (snap) {
        void element.offsetWidth;
        element.style.transition = '';
      }
      shown.current = true;
    };
    place(true);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [active]);
  return { bar, pill };
}

/** The travelling pill of useSlidingPill; `className` gives its colour and height. */
export function SlidingPill({
  pill,
  className,
}: {
  readonly pill: ReturnType<typeof useSlidingPill>['pill'];
  readonly className: string;
}) {
  return (
    <span
      ref={pill}
      aria-hidden
      className={`pointer-events-none absolute left-0 w-0 rounded-full opacity-0 transition-[transform,width] duration-(--duration-fast) ease-smooth-out will-change-[transform,width] motion-reduce:transition-none ${className}`}
    />
  );
}

/** An overview figure: a large number on the tint of its tone, with its icon. */
export function MetricCard({
  tone,
  icon,
  label,
  value,
  unit,
  foot,
}: {
  readonly tone: Tone;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly foot?: ReactNode;
}) {
  const Icon = icon;
  return (
    <div
      className={`flex min-h-40 min-w-0 flex-col rounded-panel px-5 pt-5 pb-4 max-sm:min-h-36 max-sm:px-4 ${SOFT_CLASS[tone]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <span
          aria-hidden
          className={`grid size-9 place-items-center rounded-full text-white ${SOLID_CLASS[tone]}`}
        >
          <Icon className="size-[18px]" strokeWidth={2.2} />
        </span>
      </div>
      <p className="mt-3 flex items-baseline gap-1.5 text-ink">
        <span className="text-display font-semibold tabular-nums lining-nums max-sm:text-[38px]">
          {value}
        </span>
        {unit !== undefined && <span className="text-sm font-medium text-muted">{unit}</span>}
      </p>
      {foot !== undefined && <p className="mt-auto pt-3 text-meta opacity-85">{foot}</p>}
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
      className="t-enter mt-3 flex items-start gap-2.5 rounded-input bg-rose-soft px-3.5 py-2.5 text-sm text-rose-ink"
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
      className={`flex items-start gap-2.5 rounded-field px-4 py-3 text-sm ${SOFT_CLASS[tone]}`}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A header that opens a body below it (accordion expand, transitions.dev). */
export function Disclosure({
  summary,
  children,
  className = '',
  summaryClassName = '',
}: {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly summaryClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className={`t-acc ${className}`} data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className={`inline-flex cursor-pointer select-none items-center gap-1 rounded-full transition-colors ${MOTION} ${summaryClassName}`}
      >
        {summary}
        <span className="t-acc-chevron">
          <ChevronDown aria-hidden className="size-3.5" />
        </span>
      </button>
      <div id={panel} className="t-acc-panel" inert={!open}>
        <div className="t-acc-panel-inner">{children}</div>
      </div>
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
    <Disclosure
      summary={label}
      className="mt-3 text-xs text-muted"
      summaryClassName="text-left hover:text-ink-soft"
    >
      <div className="mt-2 space-y-1 break-all rounded-input bg-canvas px-3 py-2.5 font-mono text-ink-soft">
        {children}
      </div>
    </Disclosure>
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

/** The face every typed control shares: surface, hover, focus ring, disabled state. */
const CONTROL_FACE = `rounded-input border border-transparent bg-canvas text-ink transition-[background-color,border-color,box-shadow] ${MOTION} hover:bg-canvas-2/60 in-[.bg-canvas]:bg-card focus-visible:border-sky/60 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/15 disabled:bg-track disabled:text-muted`;

export const INPUT_CLASS = `w-full ${CONTROL_FACE} px-3.5 py-2.5 text-body placeholder:text-muted/70 [&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_var(--color-card)] [&:-webkit-autofill]:[-webkit-text-fill-color:var(--color-ink)]`;

/** A textarea keeps the input face, grows with its content and never shows the native resize grip. */
export const TEXTAREA_CLASS = `${INPUT_CLASS} resize-none field-sizing-content max-h-72 min-h-[4.5rem]`;

const CHECKBOX_INPUT = `peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[6px] bg-card ring-1 ring-ink/20 ring-inset transition-[background-color,box-shadow] ${MOTION} hover:ring-ink/35 checked:bg-ink checked:ring-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky disabled:cursor-not-allowed disabled:opacity-45`;
const CHECKBOX_ICON =
  'pointer-events-none relative size-3 scale-75 text-white opacity-0 transition-[opacity,scale] duration-(--duration-quick) ease-bounce motion-reduce:transition-none peer-checked:scale-100 peer-checked:opacity-100 peer-disabled:opacity-45';
const RADIO_INPUT = `peer absolute inset-0 size-full cursor-pointer appearance-none rounded-full bg-card ring-1 ring-ink/20 ring-inset transition-[background-color,box-shadow] ${MOTION} hover:ring-ink/35 checked:bg-ink checked:ring-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky disabled:cursor-not-allowed disabled:opacity-45`;
const RADIO_DOT =
  'pointer-events-none relative size-2 scale-0 rounded-full bg-white transition-transform duration-(--duration-quick) ease-bounce motion-reduce:transition-none peer-checked:scale-100 peer-disabled:opacity-45';

/**
 * A checkbox keeps the native input (keyboard, forms, Playwright's check()) and
 * paints the box itself; the icon is a sibling so peer-checked can animate it in.
 */
export function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  return (
    <span className="relative mt-0.5 grid size-[18px] shrink-0 place-items-center">
      <input type="checkbox" {...props} className={CHECKBOX_INPUT} />
      <Check aria-hidden strokeWidth={3} className={CHECKBOX_ICON} />
    </span>
  );
}

/** A radio, styled like Checkbox: the native input stays, a white dot fills the checked circle. */
export function Radio(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  return (
    <span className="relative mt-0.5 grid size-[18px] shrink-0 place-items-center">
      <input type="radio" {...props} className={RADIO_INPUT} />
      <span aria-hidden className={RADIO_DOT} />
    </span>
  );
}

type SelectSize = 'md' | 'sm';

const SELECT_TRIGGER_SIZE: Readonly<Record<SelectSize, string>> = {
  md: 'px-3.5 py-2.5 text-body',
  sm: 'h-9 px-3 text-meta',
};
const SELECT_TRIGGER_CLASS = `flex w-full cursor-pointer items-center justify-between gap-2 text-left ${CONTROL_FACE}`;
const SELECT_CHEVRON =
  'size-4 shrink-0 text-muted transition-transform duration-(--duration-quick) ease-smooth-out motion-reduce:transition-none';

/** Distance between the trigger and the open list, and the room the list needs below it. */
const DROPDOWN_OFFSET = 6;
const DROPDOWN_MIN_BELOW = 280;

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  readonly group?: string;
}

/**
 * A select-only combobox (WAI-ARIA): a button trigger, and a listbox in the top
 * layer (native popover) so scroll containers and transformed ancestors cannot
 * clip it. Focus never leaves the trigger; the active option is announced
 * through aria-activedescendant.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  name,
  placeholder = '请选择',
  disabled = false,
  'aria-label': ariaLabel,
  size = 'md',
  testId,
}: {
  readonly value: T | null;
  readonly options: readonly SelectOption<T>[];
  readonly onChange: (value: T) => void;
  readonly name?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly 'aria-label'?: string;
  readonly size?: SelectSize;
  readonly testId?: string;
}): ReactNode {
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex < 0 ? undefined : options[selectedIndex];

  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  // Opening always highlights the current value (or the first option).
  const openAt = (index: number) => {
    setActiveIndex(index >= 0 && index < options.length ? index : options.length === 0 ? -1 : 0);
    setOpen(true);
  };

  const move = (step: 1 | -1) => {
    setActiveIndex((current) => {
      if (options.length === 0) return -1;
      if (current < 0) return step === 1 ? 0 : options.length - 1;
      return (current + step + options.length) % options.length;
    });
  };

  // The list is fixed-positioned by its trigger and follows it while open.
  useLayoutEffect(() => {
    const anchor = trigger.current;
    const menu = list.current;
    if (!open || anchor === null || menu === null) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const rect = anchor.getBoundingClientRect();
      const side = window.innerHeight - rect.bottom < DROPDOWN_MIN_BELOW ? 'top' : 'bottom';
      menu.dataset.side = side;
      menu.style.left = `${rect.left}px`;
      menu.style.width = `${rect.width}px`;
      if (!menu.matches(':popover-open')) {
        menu.style.top = `${side === 'bottom' ? rect.bottom + DROPDOWN_OFFSET : rect.top}px`;
        menu.showPopover();
      }
      // The height is known only once the list is displayed: an upward list hangs from its bottom edge.
      menu.style.top =
        side === 'bottom'
          ? `${rect.bottom + DROPDOWN_OFFSET}px`
          : `${rect.top - menu.offsetHeight - DROPDOWN_OFFSET}px`;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    place();
    // Capture sees the scroll of every scroll container, not just the window.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      if (menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [open]);

  // A pointer down anywhere outside the trigger and its list closes the list.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const root = wrapper.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${listId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) move(1);
        else openAt(selectedIndex);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) move(-1);
        else openAt(selectedIndex);
        break;
      case 'Home':
        if (!open) break;
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        if (!open) break;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!open) {
          openAt(selectedIndex);
          break;
        }
        const active = options[activeIndex];
        if (active === undefined) setOpen(false);
        else choose(active.value);
        break;
      }
      case 'Escape':
        if (!open) break;
        // The focus stays on the trigger, which is where it already is.
        event.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        if (open) setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={wrapper} className="min-w-0">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
        }
        aria-label={ariaLabel}
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
        className={`${SELECT_TRIGGER_CLASS} ${SELECT_TRIGGER_SIZE[size]}`}
      >
        <span className={`min-w-0 truncate ${selected === undefined ? 'text-muted' : ''}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown aria-hidden className={`${SELECT_CHEVRON}${open ? ' rotate-180' : ''}`} />
      </button>
      {name !== undefined && <input type="hidden" name={name} value={value ?? ''} />}
      {/* biome-ignore-start lint/a11y/noNoninteractiveElementToInteractiveRole lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: a select-only combobox: the trigger keeps the focus and the keys, the options are announced through aria-activedescendant and must not be focusable themselves. */}
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        popover="manual"
        onPointerDown={(event) => {
          // Keep the focus on the trigger when an option is clicked.
          event.preventDefault();
        }}
        onClick={(event) => {
          // The list sits inside the Field's <label>: a click on the padding or a
          // group heading must not fall through and toggle the trigger open again.
          event.preventDefault();
        }}
        className="t-dropdown fixed inset-auto m-0 max-h-72 overflow-auto rounded-field bg-card p-1.5 shadow-lift ring-1 ring-ink/5"
      >
        {options.map((option, index) => {
          const previous = index === 0 ? undefined : options[index - 1];
          const isSelected = option.value === value;
          return (
            <Fragment key={option.value}>
              {option.group !== undefined && option.group !== previous?.group && (
                <li role="presentation" className="px-3 pt-2 pb-1 text-xs text-muted">
                  {option.group}
                </li>
              )}
              <li
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                // The pointer and the keys move one highlight, so a hovered option is the one Enter takes.
                onPointerMove={() => {
                  if (activeIndex !== index) setActiveIndex(index);
                }}
                onClick={(event) => {
                  // Field wraps the control in a <label>, which would forward this
                  // click to the trigger; preventing it keeps the list from reopening.
                  event.preventDefault();
                  choose(option.value);
                }}
                className={`flex cursor-pointer items-start gap-2 rounded-input px-3 py-2 text-sm ${index === activeIndex ? 'bg-canvas' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${isSelected ? 'font-medium' : ''}`}>
                    {option.label}
                  </span>
                  {option.hint !== undefined && (
                    <span className="block text-xs text-muted">{option.hint}</span>
                  )}
                </span>
                {isSelected && (
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-sky-ink" />
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
      {/* biome-ignore-end lint/a11y/noNoninteractiveElementToInteractiveRole lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: end of the combobox listbox pattern */}
    </div>
  );
}

/** A choice among several, as a whole clickable row (a label around a checkbox or radio). */
export const OPTION_CLASS = `flex cursor-pointer items-start gap-3 rounded-input bg-canvas px-3.5 py-3 text-sm transition-colors ${MOTION} hover:bg-canvas-2/70 in-[.bg-canvas]:bg-card has-checked:bg-sky-soft`;

/** Rows separated by a hairline, inside a card. */
export const ROWS_CLASS =
  'divide-y divide-line [&>li]:py-3.5 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0';

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
    <div className="rounded-field bg-canvas px-5 py-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Loading({ label = '加载中…' }: { readonly label?: string }) {
  return (
    <div role="status" className="space-y-3 py-2">
      <span className="t-shimmer text-meta" data-text={label}>
        {label}
      </span>
      {['w-3/5', 'w-11/12', 'w-3/4'].map((width) => (
        <div
          key={width}
          className={`h-3.5 rounded-full bg-track motion-safe:animate-pulse ${width}`}
        />
      ))}
    </div>
  );
}

export function Json({ value }: { readonly value: object | string | number | boolean | null }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-input bg-canvas p-3.5 font-mono text-xs leading-5 text-ink-soft">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
