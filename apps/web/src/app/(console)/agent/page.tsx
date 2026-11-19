'use client';

import { History, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { z } from 'zod';
import { Composer } from '../../../components/assistant/composer.tsx';
import { ConversationHistory } from '../../../components/assistant/history.tsx';
import { Transcript } from '../../../components/assistant/transcript.tsx';
import {
  AttentionBar,
  CaseWorkspace,
  WorkspaceProvider,
} from '../../../components/assistant/workspace.tsx';
import { Drawer } from '../../../components/overlay.tsx';
import { Button, Loading, RefusalNote } from '../../../components/ui.tsx';
import { UntrustedText } from '../../../components/untrusted-text.tsx';
import { AssistantProvider, useAssistant, useConversations } from '../../../lib/assistant.tsx';

const CONVERSATION_ID = z.uuid();

function AgentLayout() {
  const { conversationId, pending, refusal, select } = useAssistant();
  const { conversations } = useConversations();
  const [historyOpen, setHistoryOpen] = useState(false);
  const title =
    conversations?.find((conversation) => conversation.conversationId === conversationId)?.title ??
    '新对话';
  return (
    <>
      <div className="flex gap-5 max-lg:flex-col lg:min-h-[600px] lg:flex-1">
        <aside className="hidden w-64 shrink-0 flex-col rounded-panel bg-card p-4 shadow-soft xl:flex xl:min-h-0">
          <ConversationHistory />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col rounded-panel bg-card p-5 shadow-soft lg:min-h-0">
          <header className="mb-3 flex items-center justify-between gap-3">
            <h1 className="line-clamp-1 min-w-0 flex-1 text-[17px] leading-6 font-medium">
              <UntrustedText text={title} />
            </h1>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" className="xl:hidden" onClick={() => setHistoryOpen(true)}>
                <History aria-hidden className="size-3.5" />
                <span className="max-sm:sr-only">历史对话</span>
              </Button>
              {/* From xl on, the history column beside the conversation has this button. */}
              <Button
                size="sm"
                className="xl:hidden"
                disabled={pending}
                onClick={() => select(null)}
              >
                <Plus aria-hidden className="size-3.5" />
                <span className="max-sm:sr-only">新对话</span>
              </Button>
            </div>
          </header>
          <Transcript />
          <RefusalNote refusal={refusal} />
          <AttentionBar />
          <Composer />
        </section>
        <div className="flex shrink-0 flex-col lg:min-h-0 lg:w-[440px] 2xl:w-[500px]">
          <CaseWorkspace />
        </div>
      </div>
      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="历史对话">
        <ConversationHistory titled={false} onPicked={() => setHistoryOpen(false)} />
      </Drawer>
    </>
  );
}

/**
 * The workspace starts afresh with every conversation the person opens, and
 * then follows its newest case. The id a new conversation receives on its
 * first turn is no new selection: a case picked before sending stays.
 */
function AgentWorkspace() {
  const { selection } = useAssistant();
  return (
    <WorkspaceProvider key={selection}>
      <AgentLayout />
    </WorkspaceProvider>
  );
}

function AgentConsole({ conversationId }: { readonly conversationId: string | null }) {
  return (
    <AssistantProvider initialConversationId={conversationId}>
      <AgentWorkspace />
    </AssistantProvider>
  );
}

/** The conversation of the address, once the query parameters are readable in the browser. */
function ConversationPage() {
  const params = useSearchParams();
  const raw = params.get('c');
  const parsed = raw === null ? null : CONVERSATION_ID.safeParse(raw);
  const conversationId = parsed?.success === true ? parsed.data : null;
  return <AgentConsole conversationId={conversationId} />;
}

export default function AgentPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-panel bg-card p-5 shadow-soft">
          <Loading label="正在读取对话…" />
        </div>
      }
    >
      <ConversationPage />
    </Suspense>
  );
}
