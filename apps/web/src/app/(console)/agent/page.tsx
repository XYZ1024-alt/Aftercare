'use client';

import { History, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { z } from 'zod';
import { CaseDrawer } from '../../../components/assistant/case-drawer.tsx';
import { Composer } from '../../../components/assistant/composer.tsx';
import { ConversationHistory } from '../../../components/assistant/history.tsx';
import { AgentStateBar } from '../../../components/assistant/state-bar.tsx';
import { Transcript } from '../../../components/assistant/transcript.tsx';
import { CaseLivePoolProvider } from '../../../components/case/case-context.tsx';
import { Drawer } from '../../../components/overlay.tsx';
import {
  Button,
  Loading,
  RefusalNote,
  Select,
  type SelectOption,
} from '../../../components/ui.tsx';
import { UntrustedText } from '../../../components/untrusted-text.tsx';
import { AssistantProvider, useAssistant, useConversations } from '../../../lib/assistant.tsx';
import { type CaseRow, useCases } from '../../../lib/cases.ts';
import { STAGE_LABEL, shortId } from '../../../lib/labels.ts';

const CONVERSATION_ID = z.uuid();

const FOLLOWED_GROUP = '本对话';
const OTHERS_GROUP = '全部案例';

const caseHint = (row: CaseRow): string => {
  const stage = STAGE_LABEL[row.stage];
  return row.overview.openQuestions > 0
    ? `${stage} · ${row.overview.openQuestions} 个问题待回答`
    : stage;
};

/** The cases of the conversation first, then the others; a followed case that is still loading says so. */
const caseOptions = (
  rows: readonly CaseRow[] | undefined,
  followed: readonly string[],
): readonly SelectOption<string>[] => {
  const known = new Map((rows ?? []).map((row) => [row.overview.caseId, row]));
  const opened = followed.map((caseId): SelectOption<string> => {
    const row = known.get(caseId);
    return row === undefined
      ? { value: caseId, label: shortId(caseId), hint: '读取中…', group: FOLLOWED_GROUP }
      : { value: caseId, label: row.title, hint: caseHint(row), group: FOLLOWED_GROUP };
  });
  const others = (rows ?? [])
    .filter((row) => !followed.includes(row.overview.caseId))
    .map(
      (row): SelectOption<string> => ({
        value: row.overview.caseId,
        label: row.title,
        hint: caseHint(row),
        group: OTHERS_GROUP,
      }),
    );
  return [...opened, ...others];
};

/**
 * Opens any case in the drawer without leaving the conversation. The control is
 * a command, not a state: it returns to its placeholder after a choice so the
 * same case can be opened again.
 */
function CasePicker() {
  const { followed, openCase } = useAssistant();
  const { rows } = useCases();
  const [chosen, setChosen] = useState<string | null>(null);
  const options = useMemo(() => caseOptions(rows, followed), [rows, followed]);
  return (
    <div className="w-44 shrink-0 max-sm:w-32">
      <Select
        value={chosen}
        options={options}
        onChange={(caseId) => {
          setChosen(null);
          openCase(caseId);
        }}
        aria-label="打开案例"
        placeholder="打开案例"
        size="sm"
        testId="case-picker"
        disabled={options.length === 0}
      />
    </div>
  );
}

function AgentLayout() {
  const { conversationId, latestState, pending, refusal, select } = useAssistant();
  const { conversations } = useConversations();
  const [historyOpen, setHistoryOpen] = useState(false);
  const title =
    conversations?.find((conversation) => conversation.conversationId === conversationId)?.title ??
    '新对话';
  return (
    <>
      <div className="flex gap-5 max-lg:flex-col lg:min-h-[600px] lg:flex-1">
        <aside className="hidden w-64 shrink-0 flex-col rounded-panel border border-line-subtle bg-card p-4 shadow-soft xl:flex xl:min-h-0">
          <ConversationHistory />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col rounded-panel border border-line-subtle bg-card p-5 shadow-soft lg:min-h-0">
          <div className="mx-auto flex min-h-0 w-full max-w-[920px] flex-1 flex-col">
            <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h1 className="min-w-0 flex-1 truncate text-heading font-medium">
                <UntrustedText text={title} />
              </h1>
              <div className="flex shrink-0 items-center gap-2">
                <CasePicker />
                <Button
                  size="sm"
                  className="xl:hidden max-sm:min-w-8 max-sm:px-2 pointer-coarse:max-sm:min-h-11 pointer-coarse:max-sm:min-w-11"
                  onClick={() => setHistoryOpen(true)}
                >
                  <History aria-hidden className="size-3.5" />
                  <span className="max-sm:sr-only">历史对话</span>
                </Button>
                {/* From xl on, the history column beside the conversation has this button. */}
                <Button
                  size="sm"
                  className="xl:hidden max-sm:min-w-8 max-sm:px-2 pointer-coarse:max-sm:min-h-11 pointer-coarse:max-sm:min-w-11"
                  disabled={pending}
                  onClick={() => select(null)}
                >
                  <Plus aria-hidden className="size-3.5" />
                  <span className="max-sm:sr-only">新对话</span>
                </Button>
              </div>
            </header>
            {latestState !== null && (
              <div className="sticky top-0 z-10 bg-card pb-3">
                <AgentStateBar />
              </div>
            )}
            <Transcript />
            <RefusalNote refusal={refusal} />
            <Composer />
          </div>
        </section>
      </div>
      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="历史对话">
        <ConversationHistory titled={false} onPicked={() => setHistoryOpen(false)} />
      </Drawer>
      <CaseDrawer />
    </>
  );
}

function AgentConsole({ conversationId }: { readonly conversationId: string | null }) {
  return (
    <AssistantProvider initialConversationId={conversationId}>
      <CaseLivePoolProvider>
        <AgentLayout />
      </CaseLivePoolProvider>
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
        <div className="rounded-panel border border-line-subtle bg-card p-5 shadow-soft">
          <Loading label="正在读取对话…" />
        </div>
      }
    >
      <ConversationPage />
    </Suspense>
  );
}
