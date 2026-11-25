'use client';

import { X } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  type ButtonTone,
  closeTopLayer,
  Field,
  TEXTAREA_CLASS,
  waitForAnimations,
} from './ui.tsx';

// Modal surfaces on the native <dialog>: focus stays inside, Esc and a click
// on the backdrop close it. The dialog scales in (modal open / close) and the
// drawer slides in from the right (panel reveal); closing waits for the exit
// transition before the dialog leaves the top layer.

type SurfaceKind = 'drawer' | 'modal';

/** Opens and closes the dialog with its native top-layer transition; `shown` stays true until the exit finishes. */
function useModal(open: boolean): { ref: RefObject<HTMLDialogElement | null>; shown: boolean } {
  const ref = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open) {
      setShown(true);
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }
    if (!dialog.open) {
      setShown(false);
      return;
    }
    let cancelled = false;
    void closeTopLayer(dialog, () => {
      if (dialog.open) dialog.close();
    })
      .then(() => waitForAnimations(dialog))
      .then(() => {
        if (!cancelled) setShown(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return { ref, shown };
}

interface SurfaceProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
}

function isOutsideDialog(clientX: number, clientY: number, dialog: HTMLDialogElement): boolean {
  const rect = dialog.getBoundingClientRect();
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
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
  const { ref, shown } = useModal(open);
  const titleId = useId();
  const pressedOutside = useRef(false);
  const lastTitle = useRef(title);
  const lastChildren = useRef(children);
  if (open) {
    lastTitle.current = title;
    lastChildren.current = children;
  }
  const displayTitle = open ? title : lastTitle.current;
  const displayChildren = open ? children : lastChildren.current;
  const surfaceClass = kind === 'modal' ? 't-modal' : 't-panel-slide';
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`p-0 text-ink ${surfaceClass} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedOutside.current = isOutsideDialog(event.clientX, event.clientY, event.currentTarget);
      }}
      onPointerUp={(event) => {
        if (
          pressedOutside.current &&
          isOutsideDialog(event.clientX, event.clientY, event.currentTarget)
        ) {
          onClose();
        }
        pressedOutside.current = false;
      }}
    >
      <div className="flex max-h-full flex-col p-7 max-sm:p-5">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {kicker}
            <h2
              id={titleId}
              className={`text-figure font-semibold ${kicker === undefined ? '' : 'mt-2'}`}
            >
              {displayTitle}
            </h2>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mt-1 -mr-1 grid size-9 min-h-6 min-w-6 shrink-0 place-items-center rounded-input bg-sunken text-muted transition-colors duration-(--duration-quick) hover:bg-line-subtle hover:text-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <X aria-hidden className="size-4.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{(open || shown) && displayChildren}</div>
      </div>
    </dialog>
  );
}

/** A side panel from the right, for the full text of a record. */
export function Drawer({
  size = 'md',
  ...props
}: SurfaceProps & { readonly kicker?: ReactNode; readonly size?: 'md' | 'lg' }) {
  const sizeClass =
    size === 'lg'
      ? 'w-[min(600px,calc(100%-24px))] bg-canvas'
      : 'w-[min(440px,calc(100%-24px))] bg-card';
  return (
    <Surface
      kind="drawer"
      {...props}
      className={`fixed inset-y-3 right-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none max-w-none rounded-drawer shadow-drawer [&>div]:h-full ${sizeClass}`}
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
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(480px,calc(100%-32px))] rounded-panel bg-card shadow-lift [&>div]:max-h-[calc(100dvh-32px)]"
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
        <p className="rounded-field border border-apricot-line bg-apricot-soft px-4 py-3 text-meta text-apricot-ink">
          {warning}
        </p>
      )}
      <div className="space-y-2">{children}</div>
      {reason !== undefined && (
        <Field label={reason.label}>
          <textarea
            name={reason.name}
            rows={3}
            // biome-ignore lint/a11y/noAutofocus: focus moves to the required reason field when the dialog opens
            autoFocus
            className={TEXTAREA_CLASS}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button onClick={onCancel} autoFocus={tone === 'danger' && reason === undefined}>
          {dismissLabel}
        </Button>
        <Button type="submit" tone={tone} disabled={!ready}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
