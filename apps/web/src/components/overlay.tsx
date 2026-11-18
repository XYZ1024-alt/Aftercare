'use client';

import { type AnimationParams, animate } from 'animejs';
import { X } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button, type ButtonTone, Field, INPUT_CLASS } from './ui.tsx';

// Modal surfaces on the native <dialog>: focus stays inside, Esc and a click
// on the backdrop close it. They enter with a short motion, none when the
// operator asked for reduced motion.

type SurfaceKind = 'drawer' | 'modal';
const ENTER: Readonly<Record<SurfaceKind, AnimationParams>> = {
  drawer: { translateX: ['32px', '0px'], opacity: [0, 1] },
  modal: { scale: [0.97, 1], opacity: [0, 1] },
};

function useModal(open: boolean, kind: SurfaceKind): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        animate(dialog, { ...ENTER[kind], duration: 200, ease: 'outQuad' });
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, kind]);
  return ref;
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
  const ref = useModal(open, kind);
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; the keyboard closes with Esc (the cancel event).
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`bg-card p-0 text-ink backdrop:bg-ink/35 ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full flex-col p-6 max-sm:p-5">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {kicker}
            <h2
              id={titleId}
              className={`text-[22px] leading-7 font-medium ${kicker === undefined ? '' : 'mt-2'}`}
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mt-1 -mr-1 grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors duration-160 hover:bg-track hover:text-ink"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{open && children}</div>
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
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(420px,100%)] max-w-none rounded-l-drawer shadow-drawer [&>div]:h-full"
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
      className="m-auto w-[min(460px,calc(100%-32px))] rounded-panel shadow-card"
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
        <p className="rounded-input bg-apricot-soft px-3.5 py-2.5 text-meta text-apricot-ink">
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
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button onClick={onCancel}>{dismissLabel}</Button>
        <Button type="submit" tone={tone} disabled={!ready}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
