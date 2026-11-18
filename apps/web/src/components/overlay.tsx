'use client';

import { X } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button, type ButtonTone, Field, INPUT_CLASS } from './ui.tsx';

// Modal surfaces on the native <dialog>: focus stays inside, Esc and a click
// on the backdrop close it. The dialog scales in (modal open / close) and the
// drawer slides in from the right (panel reveal); closing waits for the exit
// transition before the dialog leaves the top layer.

type SurfaceKind = 'drawer' | 'modal';

/** The exit duration of a surface in milliseconds, read from its :root token (written as ms or s). */
function closeDuration(kind: SurfaceKind): number {
  const token = kind === 'modal' ? '--modal-close-dur' : '--panel-close-dur';
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith('ms') ? amount : amount * 1000;
}

/** Opens and closes the dialog with its transition; `shown` stays true until the exit has finished. */
function useModal(
  open: boolean,
  kind: SurfaceKind,
): { ref: RefObject<HTMLDialogElement | null>; entered: boolean; shown: boolean } {
  const ref = useRef<HTMLDialogElement>(null);
  const [entered, setEntered] = useState(false);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open) {
      setShown(true);
      if (!dialog.open) {
        dialog.showModal();
        // The closed styles must be computed before they change, or nothing transitions.
        void dialog.offsetWidth;
      }
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    if (!dialog.open) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(
      () => {
        dialog.close();
        setShown(false);
      },
      reduced ? 0 : closeDuration(kind),
    );
    return () => clearTimeout(timer);
  }, [open, kind]);
  return { ref, entered, shown };
}

interface SurfaceProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
}

function Surface({
  kind,
  open,
  onClose,
  title,
  kicker,
  children,
  className,
}: SurfaceProps & {
  readonly kind: SurfaceKind;
  readonly kicker?: ReactNode;
  readonly className: string;
}) {
  const { ref, entered, shown } = useModal(open, kind);
  const titleId = useId();
  // Leaving starts on the render that closes, not one effect later.
  const visible = open && entered;
  const state =
    kind === 'modal'
      ? { className: `t-modal ${visible ? 'is-open' : shown ? 'is-closing' : ''}` }
      : { className: 't-panel-slide', 'data-open': visible };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; the keyboard closes with Esc (the cancel event).
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      {...state}
      className={`bg-card p-0 text-ink ${state.className} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full flex-col p-7 max-sm:p-5">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {kicker}
            <h2
              id={titleId}
              className={`text-[22px] leading-7 font-semibold tracking-[-0.015em] ${kicker === undefined ? '' : 'mt-2'}`}
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mt-1 -mr-1 grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-muted transition-colors duration-(--duration-quick) hover:bg-canvas-2 hover:text-ink"
          >
            <X aria-hidden className="size-[18px]" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{(open || shown) && children}</div>
      </div>
    </dialog>
  );
}

/** A side panel from the right, for the full text of a record. */
export function Drawer(props: SurfaceProps & { readonly kicker?: ReactNode }) {
  return (
    <Surface
      kind="drawer"
      {...props}
      className="fixed inset-y-3 right-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[min(440px,calc(100%-24px))] max-w-none rounded-drawer shadow-drawer [&>div]:h-full"
    />
  );
}

interface ConfirmOptions {
  readonly warning?: ReactNode;
  readonly confirmLabel: string;
  readonly dismissLabel?: string;
  readonly tone?: ButtonTone;
  /** When given, the action is not offered until a reason is written. */
  readonly reason?: { readonly label: string; readonly name: string };
  readonly onConfirm: (reason: string) => void;
}

/** A second, explicit step before an action that cannot simply be taken back. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  ...options
}: SurfaceProps & ConfirmOptions) {
  return (
    <Surface
      kind="modal"
      open={open}
      onClose={onClose}
      title={title}
      className="m-auto w-[min(480px,calc(100%-32px))] rounded-panel shadow-lift"
    >
      <ConfirmBody
        {...options}
        onCancel={onClose}
        onConfirm={(reason) => {
          onClose();
          options.onConfirm(reason);
        }}
      >
        {children}
      </ConfirmBody>
    </Surface>
  );
}

/** Mounted afresh each time the dialog opens, so the reason starts empty. */
function ConfirmBody({
  children,
  warning,
  confirmLabel,
  dismissLabel = '取消',
  tone = 'primary',
  reason,
  onCancel,
  onConfirm,
}: ConfirmOptions & { readonly children: ReactNode; readonly onCancel: () => void }) {
  const [text, setText] = useState('');
  const ready = reason === undefined || text.trim() !== '';
  return (
    <form
      className="space-y-4 text-body text-ink-soft"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onConfirm(text.trim());
      }}
    >
      {warning !== undefined && (
        <p className="rounded-field bg-apricot-soft px-4 py-3 text-meta text-apricot-ink">
          {warning}
        </p>
      )}
      <div className="space-y-2">{children}</div>
      {reason !== undefined && (
        <Field label={reason.label}>
          <textarea
            name={reason.name}
            rows={3}
            className={INPUT_CLASS}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button onClick={onCancel}>{dismissLabel}</Button>
        <Button type="submit" tone={tone} disabled={!ready}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
