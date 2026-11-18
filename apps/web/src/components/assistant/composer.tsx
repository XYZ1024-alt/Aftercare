'use client';

import { Send, Square } from 'lucide-react';
import { useAssistant } from '../../lib/assistant.tsx';
import { useSession } from '../../lib/session.tsx';
import { Button, INPUT_CLASS, Notice } from '../ui.tsx';

/** The text of one turn and the send or stop control. */
export function Composer() {
  const { pending, send, stop, draft, setDraft } = useAssistant();
  const { modelMode } = useSession();
  const unconfigured = modelMode === 'unconfigured';
  const ready = draft.trim() !== '' && !unconfigured;
  const submit = (): void => {
    if (!ready || pending) return;
    const text = draft.trim();
    setDraft('');
    void send(text).catch((error: Error) => {
      // send rethrows only what it cannot read or what is a bug; it must not disappear unseen.
      console.error('assistant turn failed', error);
    });
  };
  return (
    <form
      className="mt-4 border-line border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {unconfigured && (
        <div className="mb-3">
          <Notice tone="neutral">未配置模型，不能对话。</Notice>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          name="message"
          rows={3}
          maxLength={4000}
          className={INPUT_CLASS}
          placeholder="描述事故现象，或询问案例进展…"
          value={draft}
          disabled={unconfigured}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        {/* Stop comes in beside Send, never in its place: the second click of a double click must not stop the turn. */}
        {pending && (
          <Button tone="secondary" onClick={stop}>
            <Square aria-hidden className="size-4" />
            停止
          </Button>
        )}
        <Button tone="primary" type="submit" pending={pending} disabled={!ready}>
          {!pending && <Send aria-hidden className="size-4" />}
          发送
        </Button>
      </div>
      {modelMode === 'scripted_test' && (
        <p className="mt-2 text-xs text-muted">
          测试模式：由脚本化测试替身回复，消息会作为事故描述创建案例；以“列出”开头则列出案例。
        </p>
      )}
    </form>
  );
}
