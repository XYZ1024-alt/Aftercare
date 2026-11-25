'use client';

import {
  type AssistantUiComponent,
  type AssistantUiMeta,
  type AssistantUiProps,
  CASE_TAB_IDS,
  createAssistantUiLibrary,
  openCasePanelAction,
} from '@aftercare/console/client';
import type { ComponentRenderer, LibraryActionEvent } from '@openuidev/react-lang';
import { useIsStreaming, useTriggerAction } from '@openuidev/react-lang';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { createContext, type ReactNode, use, useCallback, useState } from 'react';
import { z } from 'zod';
import { useAssistant } from '../../lib/assistant.tsx';
import { useCases } from '../../lib/cases.ts';
import {
  STAGE_GROUPS,
  STAGE_LABEL,
  shortId,
  stageTone,
  TURN_EVENT_LABEL,
  TURN_MODE_LABEL,
  TURN_MODE_TONE,
} from '../../lib/labels.ts';
import { Button, Empty, Notice, Pill, StatusDot, Table } from '../ui.tsx';
import { UntrustedMarkdown, UntrustedText } from '../untrusted-text.tsx';
import { CaseCompactWorkbench } from './case-workbench.tsx';

// The React side of the one OpenUI library the console defines: every renderer
// takes the props of its component schema and draws only records this page
// already has. Model text is untrusted and never becomes markup; a case id is
// checked before it reaches the case API or a provider.

interface TurnUiContextValue {
  /** The server's corroboration flags, or null while a preview streams. */
  readonly meta: AssistantUiMeta | null;
  /** Case ids whose live summary is owned by this message (newest mention per case). */
  readonly expandedCaseIds: ReadonlySet<string>;
  /** True for the newest stored UI reply, whose state the top AgentStateBar already renders. */
  readonly isLatestTurn: boolean;
}

const TurnUiContext = createContext<TurnUiContextValue | null>(null);

/**
 * Hands the turn metadata to every renderer of one message. The provider sits
 * above the Renderer: a renderer cannot know which event it draws or whether
 * the turn of its message was corroborated from its props alone.
 */
export function TurnUiProvider({
  meta,
  expandedCaseIds,
  isLatestTurn = false,
  children,
}: {
  readonly meta: AssistantUiMeta | null;
  readonly expandedCaseIds: ReadonlySet<string>;
  readonly isLatestTurn?: boolean;
  readonly children: ReactNode;
}) {
  return <TurnUiContext value={{ meta, expandedCaseIds, isLatestTurn }}>{children}</TurnUiContext>;
}

function useTurnUi(): TurnUiContextValue {
  const value = use(TurnUiContext);
  if (value === null) {
    throw new Error('a GenUI renderer is used outside a TurnUiProvider');
  }
  return value;
}

/** The position of the EventItem inside the events of its AgentTurn. */
const EventIndexContext = createContext<number | null>(null);

function useEventIndex(): number | null {
  return use(EventIndexContext);
}

const AgentTurnView: ComponentRenderer<AssistantUiProps['AgentTurn']> = ({ props, renderNode }) => {
  const { isLatestTurn } = useTurnUi();
  return (
    <div className="space-y-3">
      {!isLatestTurn && renderNode(props.state)}
      {props.events.length > 0 && (
        <div
          data-testid="agent-event-strip"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          {props.events.map((event, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an event has no id of its own, and the list only grows at its end during a turn.
            <EventIndexContext key={index} value={index}>
              {renderNode(event)}
            </EventIndexContext>
          ))}
        </div>
      )}
      <div className="space-y-3">{renderNode(props.blocks)}</div>
    </div>
  );
};

const AgentStateView: ComponentRenderer<AssistantUiProps['AgentState']> = ({ props }) => {
  const { isLatestTurn } = useTurnUi();
  if (isLatestTurn) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <Pill tone={TURN_MODE_TONE[props.mode]}>{TURN_MODE_LABEL[props.mode]}</Pill>
      <p className="min-w-0 text-body">
        <UntrustedText text={props.headline} />
      </p>
    </div>
  );
};

const EventItemView: ComponentRenderer<AssistantUiProps['EventItem']> = ({ props }) => {
  const { meta } = useTurnUi();
  const { rows } = useCases();
  const { openCase } = useAssistant();
  const index = useEventIndex();
  // pending: the reply still streams, so no tool record could back this event yet.
  const corroborated = meta === null ? null : meta.eventCorroborated[index ?? -1] === true;
  const caseId = props.caseId ?? null;
  const row = caseId === null ? undefined : rows?.find((entry) => entry.overview.caseId === caseId);
  const opened = props.kind === 'case_opened' && corroborated === true;
  return (
    <div
      data-testid="agent-event"
      data-kind={props.kind}
      data-corroborated={corroborated === null ? 'pending' : String(corroborated)}
      title={corroborated === true ? undefined : '未在本回合的工具记录中核实'}
      className={`inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-meta ${corroborated === true ? 'text-ink-soft' : 'rounded-input border border-dashed border-line px-2 py-0.5 text-muted'}`}
    >
      <span className="font-medium">{TURN_EVENT_LABEL[props.kind]}</span>
      <span className="min-w-0">
        <UntrustedText text={props.summary} />
      </span>
      {caseId !== null && (
        <button
          type="button"
          data-testid={opened ? 'opened-case' : undefined}
          data-case-id={opened ? caseId : undefined}
          onClick={() => openCase(caseId, props.tab ?? undefined)}
          className="inline-flex min-h-7 max-w-full items-center gap-2 rounded-full border border-line-subtle bg-subtle px-2.5 py-0.5 text-meta text-ink-soft transition-[background-color,border-color,color,scale] duration-(--duration-quick) ease-smooth-out hover:border-line hover:text-ink active:scale-[0.97] motion-reduce:transition-none"
        >
          <StatusDot
            tone={row === undefined ? 'neutral' : stageTone(row.stage)}
            label={row === undefined ? '读取中' : STAGE_GROUPS[row.group].label}
          />
          <span className="min-w-0 truncate">
            <UntrustedText text={row?.title ?? shortId(caseId)} />
          </span>
        </button>
      )}
    </div>
  );
};

const NarrativeBlockView: ComponentRenderer<AssistantUiProps['NarrativeBlock']> = ({ props }) => (
  <div data-testid="genui-block" data-block="NarrativeBlock" className="space-y-1.5">
    {props.title !== undefined && props.title !== '' && (
      <h3 className="text-body font-semibold text-ink">
        <UntrustedText text={props.title} />
      </h3>
    )}
    <UntrustedMarkdown text={props.markdown} />
  </div>
);

const CalloutBlockView: ComponentRenderer<AssistantUiProps['CalloutBlock']> = ({ props }) => (
  <div data-testid="genui-block" data-block="CalloutBlock">
    {/* The callout tones are exactly the tones of the console, so Notice takes them as they are. */}
    <Notice tone={props.tone}>
      <p className="font-medium">
        <UntrustedText text={props.title} />
      </p>
      <p className="mt-0.5">
        <UntrustedText text={props.body} />
      </p>
    </Notice>
  </div>
);

const CaseWorkbenchBlockView: ComponentRenderer<AssistantUiProps['CaseWorkbenchBlock']> = ({
  props,
}) => {
  const { meta, expandedCaseIds } = useTurnUi();
  const streaming = useIsStreaming() || meta === null;
  const { rows } = useCases();
  const { openCase } = useAssistant();
  const [expanded, setExpanded] = useState(false);
  // A case id of a streaming reply may be half written: never hand it to the
  // case API or to a provider before it is complete.
  const parsed = z.uuid().safeParse(props.caseId);
  if (!parsed.success) {
    return (
      <div
        data-testid="genui-block"
        data-block="CaseWorkbenchBlock"
        className="text-meta text-muted"
      >
        案例编号无效
      </div>
    );
  }
  const caseId = parsed.data;
  const row = rows?.find((entry) => entry.overview.caseId === caseId);
  const title = row?.title ?? shortId(caseId);
  if (streaming) {
    return (
      <div data-testid="genui-block" data-block="CaseWorkbenchBlock">
        <div className="flex flex-wrap items-center gap-2 rounded-field border border-line-subtle bg-subtle px-3.5 py-3">
          <StatusDot
            tone={row === undefined ? 'neutral' : stageTone(row.stage)}
            label={row === undefined ? '读取中' : STAGE_GROUPS[row.group].label}
          />
          <span className="min-w-0 flex-1 truncate text-body font-medium">
            <UntrustedText text={title} />
          </span>
          <span className="text-meta text-muted">生成中…</span>
        </div>
      </div>
    );
  }
  if (expandedCaseIds.has(caseId) || expanded) {
    return (
      <div data-testid="genui-block" data-block="CaseWorkbenchBlock">
        <CaseCompactWorkbench
          caseId={caseId}
          initialTab={props.tab ?? null}
          reason={props.reason ?? null}
          trackStage={expandedCaseIds.has(caseId)}
          defaultExpanded={expanded}
        />
      </div>
    );
  }
  const openQuestions = row?.overview.openQuestions ?? 0;
  return (
    <div data-testid="genui-block" data-block="CaseWorkbenchBlock">
      <section
        aria-label="案例摘要"
        className="min-w-0 rounded-field border border-line-subtle bg-subtle p-3.5 [--surface-bg:var(--color-subtle)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5">
          <div className="min-w-0 flex-1 basis-56 space-y-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <h3 className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                <UntrustedText text={title} />
              </h3>
              <Link
                href={`/cases/${caseId}`}
                data-testid="open-case-page"
                className="inline-flex shrink-0 items-center gap-1 text-meta font-medium text-ink-soft transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
              >
                案例页
                <ArrowUpRight aria-hidden className="size-3.5" />
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {row === undefined ? (
                <StatusDot tone="neutral" label="读取中" />
              ) : (
                <Pill tone={stageTone(row.stage)}>{STAGE_LABEL[row.stage]}</Pill>
              )}
              {openQuestions > 0 && (
                <span className="text-meta text-ink-soft">{openQuestions} 个业务问题待回答</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setExpanded(true)}>
              展开内嵌视图
            </Button>
            <Button
              size="sm"
              tone="primary"
              onClick={() => openCase(caseId, props.tab ?? undefined)}
            >
              在抽屉中处理
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};

const CaseSummaryBlockView: ComponentRenderer<AssistantUiProps['CaseSummaryBlock']> = ({
  props,
}) => {
  const { rows } = useCases();
  const { openCase } = useAssistant();
  const row = rows?.find((entry) => entry.overview.caseId === props.caseId);
  if (row === undefined) {
    return (
      <div
        data-testid="genui-block"
        data-block="CaseSummaryBlock"
        className="rounded-field border border-line-subtle bg-subtle px-3.5 py-3 text-meta text-muted"
      >
        {rows === undefined ? '读取中…' : '案例不存在'}
      </div>
    );
  }
  return (
    <div
      data-testid="genui-block"
      data-block="CaseSummaryBlock"
      className="rounded-field border border-line-subtle bg-subtle p-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 text-body font-medium">
              <UntrustedText text={row.title} />
            </span>
            <Pill tone={stageTone(row.stage)}>{STAGE_LABEL[row.stage]}</Pill>
          </div>
          <p className="text-meta text-muted">
            {row.overview.openQuestions === 0
              ? '暂无待答问题'
              : `${row.overview.openQuestions} 个业务问题待回答`}
          </p>
          {props.note !== undefined && props.note !== '' && (
            <p className="text-meta text-ink-soft">
              <UntrustedText text={props.note} />
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button size="sm" tone="primary" onClick={() => openCase(props.caseId, props.tab)}>
            处理
          </Button>
          <Link
            href={`/cases/${props.caseId}`}
            className="text-meta text-muted transition-colors duration-(--duration-quick) ease-smooth-out hover:text-ink"
          >
            在案例页打开
          </Link>
        </div>
      </div>
    </div>
  );
};

const CaseListBlockView: ComponentRenderer<AssistantUiProps['CaseListBlock']> = ({ props }) => {
  const { rows } = useCases();
  const { openCase } = useAssistant();
  return (
    <div data-testid="genui-block" data-block="CaseListBlock" className="space-y-2">
      <h3 className="text-body font-medium">
        <UntrustedText text={props.title} />
      </h3>
      {props.caseIds.length === 0 ? (
        <Empty>暂无案例</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>案例</th>
              <th>阶段</th>
              <th className="num">待答问题</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.caseIds.map((caseId) => {
              const row = rows?.find((entry) => entry.overview.caseId === caseId);
              return (
                <tr key={caseId}>
                  <td className="max-w-72">
                    <span className="block truncate">
                      <UntrustedText text={row?.title ?? shortId(caseId)} />
                    </span>
                  </td>
                  <td>
                    {row === undefined ? (
                      <span className="text-muted">读取中…</span>
                    ) : (
                      <Pill tone={stageTone(row.stage)}>{STAGE_LABEL[row.stage]}</Pill>
                    )}
                  </td>
                  <td className="num text-ink-soft">
                    {row === undefined ? '—' : row.overview.openQuestions}
                  </td>
                  <td>
                    <Button size="sm" onClick={() => openCase(caseId)}>
                      处理
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
};

const ActionBarView: ComponentRenderer<AssistantUiProps['ActionBar']> = ({ props, renderNode }) => (
  <div
    data-testid="genui-block"
    data-block="ActionBar"
    className="flex flex-wrap items-center gap-2"
  >
    {renderNode(props.items)}
  </div>
);

/** The action argument of triggerAction: an ActionPlan or the legacy action object. */
type TriggerActionArgument = NonNullable<Parameters<ReturnType<typeof useTriggerAction>>[2]>;

const ActionButtonView: ComponentRenderer<AssistantUiProps['ActionButton']> = ({ props }) => {
  const triggerAction = useTriggerAction();
  const streaming = useIsStreaming();
  const { pending } = useAssistant();
  return (
    <Button
      tone={props.tone === 'primary' ? 'primary' : 'secondary'}
      disabled={streaming || pending}
      // lang-core types an action prop as the legacy object shape, while its
      // evaluator hands a @ToAssistant/@OpenCasePanel step to the renderer as an
      // ActionPlan; triggerAction takes both, so the action goes through as is.
      onClick={() => triggerAction(props.label, undefined, props.action as TriggerActionArgument)}
    >
      <UntrustedText text={props.label} />
    </Button>
  );
};

/**
 * One renderer per component, each checked against the props of its schema.
 * createAssistantUiLibrary carries one renderer type for all ten components,
 * while every component has its own props: the per-component record is checked
 * here and widened once for the library, which only stores the renderers.
 */
const REACT_RENDERERS: {
  readonly [K in AssistantUiComponent]: ComponentRenderer<AssistantUiProps[K]>;
} = {
  AgentTurn: AgentTurnView,
  AgentState: AgentStateView,
  EventItem: EventItemView,
  NarrativeBlock: NarrativeBlockView,
  CalloutBlock: CalloutBlockView,
  CaseWorkbenchBlock: CaseWorkbenchBlockView,
  CaseSummaryBlock: CaseSummaryBlockView,
  CaseListBlock: CaseListBlockView,
  ActionBar: ActionBarView,
  ActionButton: ActionButtonView,
};

type AnyAssistantUiRenderer = ComponentRenderer<AssistantUiProps[AssistantUiComponent]>;

/** Built once at module scope: a new library on every render reparses the reply from the start. */
export const assistantUiLibrary = createAssistantUiLibrary(
  REACT_RENDERERS as Readonly<Record<AssistantUiComponent, AnyAssistantUiRenderer>>,
);

const openCasePanelParams = z.object({
  caseId: z.uuid(),
  tab: z.enum(CASE_TAB_IDS).optional(),
});

/**
 * The action handler of the Renderer. Only two actions may leave a reply: a
 * follow-up message and the case panel; a URL is dropped because it would take
 * the operator to a page this system does not own, and the server rejects it too.
 */
export function useAssistantUiAction(): (
  event: LibraryActionEvent<typeof assistantUiLibrary>,
) => void {
  const { pending, send, openCase } = useAssistant();
  return useCallback(
    (event: LibraryActionEvent<typeof assistantUiLibrary>): void => {
      if (event.type === 'continue_conversation') {
        // Only the words the operator sees are sent; params.context is model
        // data and never becomes part of the next request.
        if (pending) return;
        void send(event.humanFriendlyMessage).catch((error: Error) => {
          // send rethrows only what it cannot read or what is a bug.
          console.error('assistant turn of a GenUI action failed', error);
        });
        return;
      }
      if (event.type === openCasePanelAction.name) {
        const parsed = openCasePanelParams.safeParse(event.params);
        if (!parsed.success) {
          console.error('OpenCasePanel action carried invalid parameters', parsed.error);
          return;
        }
        openCase(parsed.data.caseId, parsed.data.tab);
        return;
      }
      // open_url and any other action is ignored: the reply may not navigate
      // the console, and these two are the only actions the prompt allows.
    },
    [openCase, pending, send],
  );
}
