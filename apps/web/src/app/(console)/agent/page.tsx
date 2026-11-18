'use client';

import type { AssistantMessage } from '@aftercare/console/client';
import { Bot, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { Composer } from '../../../components/assistant/composer.tsx';
import { Transcript } from '../../../components/assistant/transcript.tsx';
import {
  Button,
  Card,
  Dot,
  Empty,
  Notice,
  PageHead,
  Pill,
  RefusalNote,
} from '../../../components/ui.tsx';
import { UntrustedText } from '../../../components/untrusted-text.tsx';
import { AssistantProvider, useAssistant } from '../../../lib/assistant.tsx';
import { type CaseRow, useCases } from '../../../lib/cases.ts';
import { STAGE_LABEL, shortId, stageTone } from '../../../lib/labels.ts';

/** The cases the conversation opened, read or acted on, newest first, without repeats. */
const followedCaseIds = (messages: readonly AssistantMessage[]): readonly string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    for (const caseId of message.caseIds) {
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      ids.push(caseId);
    }
  }
  return ids;
};

function NewConversationButton() {
  const { pending, reset } = useAssistant();
  return (
    <Button size="sm" onClick={reset} disabled={pending}>
      <RotateCcw aria-hidden className="size-3.5" />
      新对话
    </Button>
  );
}

function ConversationCard() {
  const { refusal } = useAssistant();
  return (
    <Card title="对话" icon={Bot} tone="sky" aside={<NewConversationButton />} className="t-enter">
      <Transcript />
      <RefusalNote refusal={refusal} />
      <Composer />
    </Card>
  );
}

function FollowedCase({
  caseId,
  row,
}: {
  readonly caseId: string;
  readonly row: CaseRow | undefined;
}) {
  return (
    <li>
      <Link
        href={`/cases/${caseId}`}
        data-testid="followed-case"
        className="flex items-center gap-3 rounded-field px-2 py-2.5 transition-colors duration-(--duration-quick) ease-smooth-out hover:bg-canvas"
      >
        <Dot tone={row === undefined ? 'neutral' : stageTone(row.stage)} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">
            <UntrustedText text={row?.title ?? shortId(caseId)} />
          </span>
          <span className="mt-0.5 block text-meta text-muted">
            {row === undefined ? '读取中…' : STAGE_LABEL[row.stage]}
          </span>
        </span>
        {row !== undefined && row.overview.openQuestions > 0 && (
          <Pill tone="violet">{row.overview.openQuestions} 个问题</Pill>
        )}
      </Link>
    </li>
  );
}

function FollowedCases() {
  const { messages } = useAssistant();
  const { rows, error } = useCases();
  const ids = followedCaseIds(messages);
  return (
    <Card title="跟进的案例" className="t-enter">
      {error !== undefined && (
        <div className="mb-3">
          <Notice tone="rose">案例读取失败：{error.message}</Notice>
        </div>
      )}
      {ids.length === 0 ? (
        <Empty>对话中创建或查看的案例会显示在这里。</Empty>
      ) : (
        <ul className="-my-1">
          {ids.map((caseId) => (
            <FollowedCase
              key={caseId}
              caseId={caseId}
              row={rows?.find((row) => row.overview.caseId === caseId)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AgentConsole() {
  return (
    <>
      <PageHead title="Agent 对话" />
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-lg:grid-cols-1">
        <ConversationCard />
        <FollowedCases />
      </div>
    </>
  );
}

export default function AgentPage() {
  return (
    <AssistantProvider>
      <AgentConsole />
    </AssistantProvider>
  );
}
