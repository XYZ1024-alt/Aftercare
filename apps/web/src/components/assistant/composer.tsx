'use client';

import { Send, Square } from 'lucide-react';
import { useAssistant } from '../../lib/assistant.tsx';
import { useSession } from '../../lib/session.tsx';
import { Button, Notice } from '../ui.tsx';

/** The text of one turn and the send or stop control, in one field. */
export function Composer() {
  const { pending, runningElsewhere, loading, send, stop, draft, setDraft } = useAssistant();
  const { modelMode } = useSession();
  const unconfigured = modelMode === 'unconfigured';
  const disabled = unconfigured || loading || runningElsewhere;
  const ready = draft.trim() !== '' && !disabled && !pending;
  const submit = (): void => {
    if (!ready) return;
    void send(draft.trim()).catch((error: Error) => {
      // send rethrows only what it cannot read or what is a bug; it must not disappear unseen.
      console.error('assistant turn failed', error);
    });
  };
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {unconfigured && (
        <div className="mb-3">
          <Notice tone="neutral">尚未配置模型服务，暂无法发起对话。</Notice>
        </div>
      )}
      <div className="rounded-field border border-line-control bg-subtle p-2 transition-[background-color,border-color,box-shadow] duration-(--duration-quick) ease-smooth-out hover:border-line-control-hover focus-within:border-sky/60 focus-within:bg-card focus-within:ring-4 focus-within:ring-sky/15">
        <div className="flex items-end gap-2">
          <textarea
            name="message"
            rows={1}
            maxLength={4000}
            className="field-sizing-content max-h-48 min-h-10 w-full flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-body text-ink placeholder:text-muted focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted"
            placeholder="描述事故现象，或询问案例进展…"
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
          />
          <div className="flex shrink-0 items-center gap-2">
            {/* Stop comes in beside Send, never in its place: the second click of a double click must not stop the turn. */}
            {pending && (
              <Button tone="secondary" className="pointer-coarse:min-h-11" onClick={stop}>
                <Square aria-hidden className="size-4" />
                停止
              </Button>
            )}
            <Button
              tone="primary"
              type="submit"
              className="pointer-coarse:min-h-11"
              disabled={!ready}
            >
              <Send aria-hidden className="size-4" />
              发送
            </Button>
          </div>
        </div>
      </div>
      <p className="mt-2 text-meta text-muted">Enter 发送，Shift+Enter 换行</p>
      {modelMode === 'scripted_test' && (
        <p className="mt-1 text-meta text-muted">
          测试模式：发送消息将创建案例；以“列出”开头可查看案例列表。
        </p>
      )}
    </form>
  );
}
