'use client';

import type { AssistantConversationSummary, Refusal } from '@aftercare/console/client';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { useAssistant, useConversations } from '../../lib/assistant.tsx';
import { whenShort } from '../../lib/labels.ts';
import { useSession } from '../../lib/session.tsx';
import { ConfirmDialog } from '../overlay.tsx';
import { Button, Empty, Loading, Notice, RefusalNote } from '../ui.tsx';
import { UntrustedText } from '../untrusted-text.tsx';

const GROUP_ORDER = ['today', 'yesterday', 'week', 'earlier'] as const;
type GroupId = (typeof GROUP_ORDER)[number];
const GROUP_LABEL: Readonly<Record<GroupId, string>> = {
  today: '今天',
  yesterday: '昨天',
  week: '7 天内',
  earlier: '更早',
};

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** The group of a conversation by the local calendar day it was last written. */
const groupOf = (updatedAt: string, today: number): GroupId => {
  const days = Math.round((today - startOfDay(new Date(updatedAt))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days < 7 ? 'week' : 'earlier';
};

interface Group {
  readonly id: GroupId;
  readonly label: string;
  readonly conversations: readonly AssistantConversationSummary[];
}

/** Newest first, split by day, in the order the groups are read. */
const grouped = (conversations: readonly AssistantConversationSummary[]): readonly Group[] => {
  const today = startOfDay(new Date());
  const byGroup = new Map<GroupId, AssistantConversationSummary[]>();
  for (const conversation of conversations) {
    const id = groupOf(conversation.updatedAt, today);
    const list = byGroup.get(id) ?? [];
    list.push(conversation);
    byGroup.set(id, list);
  }
  return GROUP_ORDER.flatMap((id) => {
    const list = byGroup.get(id);
    return list === undefined ? [] : [{ id, label: GROUP_LABEL[id], conversations: list }];
  });
};

export function ConversationHistory({
  onPicked,
  titled = true,
}: {
  readonly onPicked?: () => void;
  /** False where the surrounding surface (the drawer) already names the list. */
  readonly titled?: boolean;
}) {
  const { conversations, error, refresh } = useConversations();
  const { conversationId, pending, select } = useAssistant();
  const { csrfToken } = useSession();
  const [confirming, setConfirming] = useState<AssistantConversationSummary | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const groups = conversations === undefined ? [] : grouped(conversations);

  const remove = async (conversation: AssistantConversationSummary): Promise<void> => {
    setDeleting(conversation.conversationId);
    setRefusal(null);
    const result = await sendJson<{ readonly conversationId: string }>(
      `/api/assistant/conversations/${conversation.conversationId}`,
      {},
      csrfToken,
      'DELETE',
    );
    setDeleting(null);
    if (!result.ok) {
      setRefusal(result.refusal);
      return;
    }
    await refresh();
    if (conversation.conversationId === conversationId) select(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className={`mb-2 flex shrink-0 items-center gap-2 ${titled ? 'justify-between' : 'justify-end'}`}
      >
        {titled && <h2 className="px-1 text-meta font-medium text-ink-soft">历史对话</h2>}
        <Button
          size="sm"
          data-testid="new-conversation"
          disabled={pending}
          onClick={() => {
            select(null);
            onPicked?.();
          }}
        >
          <Plus aria-hidden className="size-3.5" />
          新对话
        </Button>
      </header>
      <RefusalNote refusal={refusal} />
      {error !== undefined && (
        <div className="mb-2">
          <Notice tone="rose">对话列表读取失败：{error.message}</Notice>
        </div>
      )}
      {conversations === undefined && error === undefined ? (
        <Loading />
      ) : conversations !== undefined && conversations.length === 0 ? (
        <Empty>暂无历史对话</Empty>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.id}>
              <p className="px-2 pt-2 pb-1 text-meta text-muted">{group.label}</p>
              <ul className="space-y-1">
                {group.conversations.map((conversation) => {
                  const active = conversation.conversationId === conversationId;
                  return (
                    <li
                      key={conversation.conversationId}
                      data-testid="conversation-item"
                      data-conversation={conversation.conversationId}
                      data-active={active}
                      className="group relative min-w-0"
                    >
                      <button
                        type="button"
                        disabled={pending}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          select(conversation.conversationId);
                          onPicked?.();
                        }}
                        className={`w-full min-w-0 rounded-field border px-3 py-2.5 pr-11 text-left text-body transition-colors duration-(--duration-quick) ease-smooth-out disabled:cursor-not-allowed disabled:opacity-60 ${active ? 'border-sky-line bg-sky-soft font-medium text-ink forced-colors:outline-2 forced-colors:outline-offset-[-2px] forced-colors:outline-[Highlight]' : 'border-transparent hover:bg-subtle'}`}
                      >
                        <span className={`block truncate ${active ? 'font-medium' : ''}`}>
                          <UntrustedText text={conversation.title} />
                        </span>
                        <span className="mt-0.5 block text-meta text-muted">
                          {conversation.running ? (
                            <span className="text-ink-soft">进行中</span>
                          ) : (
                            whenShort(conversation.updatedAt)
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="删除对话"
                        disabled={deleting === conversation.conversationId}
                        onClick={() => setConfirming(conversation)}
                        className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-line-subtle bg-card text-muted opacity-0 transition-[opacity,background-color,color] duration-(--duration-quick) ease-smooth-out group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-subtle hover:text-rose-ink disabled:cursor-not-allowed pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:opacity-100"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="确认删除这段对话？"
        confirmLabel="删除对话"
        tone="danger"
        onConfirm={() => {
          if (confirming !== null) void remove(confirming);
        }}
      >
        删除后对话记录将无法恢复；对话中已创建的案例及执行过的操作不受影响。
      </ConfirmDialog>
    </div>
  );
}
