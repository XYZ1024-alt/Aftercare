import { randomUUID } from 'node:crypto';
import type {
  FinishReason,
  ModelCatalog,
  ModelMessage,
  ModelOutcome,
  ModelRequest,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelToolCall,
  StreamingModelAdapter,
} from '@aftercare/agent';
import type { CaseTabId, TurnEvent, TurnStateMode } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { z } from 'zod';
import { repairPrompt, validateAssistantUi } from './ui-parser.ts';

// A test double for the console assistant, used when no model is configured
// (AFTERCARE_MODEL_MODE=scripted_test). It follows a script instead of
// reasoning: the last user message becomes one tool call — list_cases,
// read_case or open_case — and the last tool result becomes a final reply
// written in OpenUI Lang, the same language a live model has to answer in. The
// state, events and blocks of that reply are derived from that result alone,
// so the whole assistant path — request schema, stored conversation, tool
// loop, streamed preview, OpenUI validation — runs deterministically and
// without a network. A conversation it drives proves nothing about a model.

const MODEL = 'assistant-driver';

/** The scripted turn has no caller to abort it: complete() runs the same script as stream(). */
const NO_SIGNAL = new AbortController().signal;

/**
 * The opening line of the repair message. A request whose last user message
 * starts with it is the server asking for the same answer again, so the
 * scripted turn repeats the reply of the tool result it already answered.
 */
const REPAIR_OPENING = repairPrompt([]).split('\n')[0] ?? '';

/** A message starting with it lists cases; one starting with "查看案例 <uuid>" reads that case. */
const LIST_PREFIX = '列出';
const READ_PREFIX = '查看案例 ';

/** The stages whose result a person reads on the results tab. */
const RESULT_STAGES: ReadonlySet<string> = new Set([
  'verified_sealed',
  'partially_resolved',
  'result_stale',
]);

const documentSchema = z.record(z.string(), z.json());

const refusalSchema = z.looseObject({
  refusal: z.looseObject({ code: z.string().min(1).max(64), message: z.string().min(1) }),
});

const listCaseSchema = z.looseObject({
  caseId: z.uuid(),
  stage: z.string(),
  openQuestions: z.number(),
});

const listDocumentSchema = z.looseObject({
  total: z.number(),
  cases: z.array(listCaseSchema),
});

const readDocumentSchema = z.looseObject({
  caseId: z.uuid(),
  stage: z.looseObject({
    stage: z.string().min(1).max(64),
    waitingOnOperator: z.boolean(),
  }),
  openQuestions: z.array(z.looseObject({ kind: z.string().min(1).max(64) })),
});

const openDocumentSchema = z.looseObject({ caseId: z.uuid() });

const caseIdArgumentsSchema = z.looseObject({ caseId: z.uuid() });

/** One answer shape this double returns: it never fails, so a broken path shows in the transcript. */
function outcomeOf(
  text: string | null,
  toolCalls: readonly ModelToolCall[],
  finishReason: FinishReason,
): ModelOutcome {
  return {
    ok: true,
    response: { text, toolCalls, finishReason, usage: null, model: MODEL, reasoning: null },
  };
}

/** An abort is not a service failure: the stream ends with the text received so far. */
function abortedOutcome(text: string): ModelOutcome {
  return outcomeOf(text.trim() === '' ? null : text, [], 'other');
}

/** A result document of one tool, read with the context of the tool that produced it. */
function resultDocumentOf(content: string): JsonObject {
  try {
    return documentSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error(
      `the scripted double got a tool result that is not a JSON object (${error instanceof Error ? error.name : 'Error'})`,
    );
  }
}

/**
 * The result read through the schema of its tool. A shape that does not fit is
 * an internal error of the double, not a case to describe: hiding it behind a
 * normal-looking reply would make a broken transcript look like a working one.
 */
function parseResult<S extends z.ZodType>(
  tool: string,
  schema: S,
  document: JsonObject,
): z.output<S> {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `the scripted double cannot read the ${tool} result: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** The tool a result belongs to: the transcript carries the name and the arguments on the call. */
function callOf(messages: readonly ModelMessage[], toolCallId: string): ModelToolCall | null {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.id === toolCallId) return call;
    }
  }
  return null;
}

/** The newest tool result of the conversation: the one the last final answer was written from. */
function lastToolResult(
  messages: readonly ModelMessage[],
): Extract<ModelMessage, { role: 'tool' }> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === 'tool') return message;
  }
  return null;
}

/** The case id the user asked to read: only "查看案例 <uuid>" carries one, and nothing else does. */
function readCaseIdOf(content: string): string | null {
  if (!content.startsWith(READ_PREFIX)) return null;
  const parsed = z.uuid().safeParse(content.slice(READ_PREFIX.length).trim());
  return parsed.success ? parsed.data : null;
}

/** The one tool call a user message asks for. */
function callForUser(content: string): { readonly name: string; readonly argumentsText: string } {
  if (content.startsWith(LIST_PREFIX)) {
    return { name: 'list_cases', argumentsText: JSON.stringify({ filter: 'all' }) };
  }
  const caseId = readCaseIdOf(content);
  if (caseId !== null) {
    return { name: 'read_case', argumentsText: JSON.stringify({ caseId }) };
  }
  return { name: 'open_case', argumentsText: JSON.stringify({ description: content }) };
}

const literal = (value: string | null): string => (value === null ? 'null' : JSON.stringify(value));

const literalList = (values: readonly string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;

/** The OpenUI Lang program of one turn, before its self-check. */
interface ProgramSpec {
  readonly mode: TurnStateMode;
  readonly headline: string;
  readonly focusCaseId: string | null;
  readonly focusTab: CaseTabId | null;
  readonly trackedCaseIds: readonly string[];
  readonly nextStep: string | null;
  readonly events: readonly TurnEvent[];
  /** The block and button statements of the program, in order. */
  readonly statements: readonly string[];
  /** The statement names AgentTurn receives as its blocks, in order. */
  readonly blocks: readonly string[];
}

/**
 * The program as text, checked before it is returned: an invalid program is an
 * internal error of the double, and a repair the model could never satisfy
 * would hide the bug the double exists to expose.
 */
function programOf(spec: ProgramSpec): string {
  const eventNames = spec.events.map((_, index) => `event${index + 1}`);
  const eventLines = spec.events.map(
    (event, index) =>
      `event${index + 1} = EventItem(${literal(event.kind)}, ${literal(event.summary)}, ${literal(event.caseId)}, ${literal(event.tab)}, ${literal(event.detailCode)})`,
  );
  const lines = [
    `root = AgentTurn(state, [${eventNames.join(', ')}], [${spec.blocks.join(', ')}])`,
    `state = AgentState(${literal(spec.mode)}, ${literal(spec.headline)}, ${literal(spec.focusCaseId)}, ${literal(spec.focusTab)}, ${literalList(spec.trackedCaseIds)}, ${literal(spec.nextStep)})`,
    ...eventLines,
    ...spec.statements,
  ];
  const validation = validateAssistantUi(lines.join('\n'));
  if (!validation.ok) {
    throw new Error(`the scripted reply is not valid OpenUI Lang: ${validation.errors.join('; ')}`);
  }
  return validation.content;
}

/** The tabs a read can land on: where a person reads the stage or acts on the case. */
type ReadTab = Extract<CaseTabId, 'process' | 'questions' | 'plan' | 'results'>;

/** The tab a person acts on, read from the stage and the open questions of the case. */
function tabOfRead(stage: string, questions: readonly { readonly kind: string }[]): ReadTab {
  if (questions.some((question) => question.kind !== 'execution_approval')) {
    return 'questions';
  }
  if (stage === 'awaiting_approval' || questions.length > 0) {
    return 'plan';
  }
  if (RESULT_STAGES.has(stage)) {
    return 'results';
  }
  return 'process';
}

const READ_HEADLINES: Readonly<Record<ReadTab, string>> = {
  process: '跟进案例进展',
  questions: '等待业务问题确认',
  plan: '等待执行批准',
  results: '案例结果已可查看',
};

const READ_NEXT_STEPS: Readonly<Record<ReadTab, string>> = {
  process: '请在进程页签继续处理该案例',
  questions: '请在业务问题页签回答后让我继续',
  plan: '请审核修复计划并决定是否批准',
  results: '请在结果页签查看报告并处理后续事项',
};

const NEEDED_SUMMARIES: Readonly<Record<ReadTab, string>> = {
  process: '需要你处理该案例',
  questions: '需要你回答业务问题',
  plan: '需要你审核修复计划',
  results: '需要你查看案例结果',
};

/** What the reply says about the stage: the tab tells where a person reads or acts. */
function narrativeOfRead(stage: string, tab: ReadTab): string {
  switch (tab) {
    case 'questions':
      return '案例停在业务问题确认，请回答后再让我继续。';
    case 'plan':
      return '案例等待执行批准，请审核修复计划并决定是否批准。';
    case 'results':
      switch (stage) {
        case 'verified_sealed':
          return '案例已验证封存，报告与产物可在结果页签查看。';
        case 'partially_resolved':
          return '案例已部分解决，报告与产物可在结果页签查看。';
        default:
          return '案例结果已失效，报告不再可信，可在结果页签查看原因。';
      }
    default:
      return '案例仍在处理中，可在进程页签查看阶段与运行进展。';
  }
}

function listAnswer(document: JsonObject): string {
  const result = parseResult('list_cases', listDocumentSchema, document);
  const caseIds = result.cases.map((row) => row.caseId);
  const waiting = result.cases.filter(
    (row) => row.openQuestions > 0 || row.stage === 'awaiting_approval',
  );
  const needsHuman = waiting.length > 0;
  const narrative =
    result.total === 0
      ? '目前没有案例。'
      : needsHuman
        ? `共 ${result.total} 个案例，其中 ${waiting.length} 个等待你处理。`
        : `共 ${result.total} 个案例，目前没有等待你处理的。`;
  return programOf({
    mode: needsHuman ? 'waiting_human' : 'idle',
    headline: needsHuman
      ? `已列出 ${result.total} 个案例，${waiting.length} 个等待你处理`
      : `已列出 ${result.total} 个案例`,
    focusCaseId: null,
    focusTab: null,
    trackedCaseIds: [],
    nextStep: needsHuman ? '请在案例列表中打开等待处理的案例' : null,
    events: [
      {
        kind: 'cases_queried',
        summary: `查询了 ${result.total} 个案例`,
        caseId: null,
        tab: null,
        detailCode: null,
      },
    ],
    statements: [
      `narrative = NarrativeBlock(${literal(narrative)})`,
      `cases = CaseListBlock("案例列表", "all", ${literalList(caseIds)})`,
    ],
    blocks: ['narrative', 'cases'],
  });
}

function readAnswer(document: JsonObject): string {
  const result = parseResult('read_case', readDocumentSchema, document);
  const stage = result.stage.stage;
  const tab = tabOfRead(stage, result.openQuestions);
  // The stage says it waits on a person, or an open question does: either way the
  // turn cannot finish without one, so the state says so instead of "completed".
  const needsHuman = result.stage.waitingOnOperator || result.openQuestions.length > 0;
  const events: TurnEvent[] = [
    {
      kind: 'stage_observed',
      summary: `案例当前阶段：${stage}`,
      caseId: result.caseId,
      tab,
      detailCode: stage,
    },
  ];
  if (needsHuman) {
    events.push({
      kind: 'human_action_needed',
      summary: NEEDED_SUMMARIES[tab],
      caseId: result.caseId,
      tab,
      detailCode: null,
    });
  }
  return programOf({
    mode: needsHuman ? 'waiting_human' : 'completed',
    headline: READ_HEADLINES[tab],
    focusCaseId: result.caseId,
    focusTab: tab,
    trackedCaseIds: [result.caseId],
    nextStep: needsHuman ? READ_NEXT_STEPS[tab] : null,
    events,
    statements: [
      `narrative = NarrativeBlock(${literal(narrativeOfRead(stage, tab))})`,
      `workbench = CaseWorkbenchBlock(${literal(result.caseId)}, ${literal(tab)})`,
    ],
    blocks: ['narrative', 'workbench'],
  });
}

function openAnswer(document: JsonObject): string {
  const { caseId } = parseResult('open_case', openDocumentSchema, document);
  return programOf({
    mode: 'tracking',
    headline: '已创建案例并启动调查',
    focusCaseId: caseId,
    focusTab: 'process',
    trackedCaseIds: [caseId],
    nextStep: '调查进展会在这里实时更新',
    events: [
      {
        kind: 'case_opened',
        summary: '已创建案例并启动调查',
        caseId,
        tab: 'process',
        detailCode: null,
      },
    ],
    statements: [
      'narrative = NarrativeBlock("已为这起事故开案，调查在后台进行。")',
      `workbench = CaseWorkbenchBlock(${literal(caseId)}, "process")`,
      'actions = ActionBar([follow])',
      `follow = ActionButton("查看进展", @ToAssistant(${JSON.stringify(`查看案例 ${caseId}`)}))`,
    ],
    blocks: ['narrative', 'workbench', 'actions'],
  });
}

/** A refused call: nothing happened, so the reply says what was asked and why it stopped. */
function refusedAnswer(tool: string, document: JsonObject, caseId: string | null): string {
  const refusal = refusalSchema.safeParse(document);
  const code = refusal.success ? refusal.data.refusal.code : null;
  const reason = refusal.success
    ? refusal.data.refusal.message
    : `${tool} 调用被拒绝，结果没有给出拒绝代码`;
  return programOf({
    mode: 'blocked',
    headline: '操作未执行',
    focusCaseId: caseId,
    focusTab: null,
    trackedCaseIds: caseId === null ? [] : [caseId],
    nextStep: '请查看拒绝原因后再决定下一步',
    events: [
      {
        kind: 'action_refused',
        summary: `操作被拒绝：${tool}`,
        caseId,
        tab: null,
        detailCode: code,
      },
    ],
    statements: [`refused = CalloutBlock("rose", "操作未执行", ${literal(reason)})`],
    blocks: ['refused'],
  });
}

/** The case the call names, when it names one: only read_case carries an id. */
function caseIdOfCall(call: ModelToolCall): string | null {
  let document: JsonObject;
  try {
    document = documentSchema.parse(JSON.parse(call.argumentsText));
  } catch (error) {
    throw new Error(
      `the scripted double cannot read the arguments of ${call.name} (${error instanceof Error ? error.name : 'Error'})`,
    );
  }
  const parsed = caseIdArgumentsSchema.safeParse(document);
  return parsed.success ? parsed.data.caseId : null;
}

function answerForTool(
  messages: readonly ModelMessage[],
  result: Extract<ModelMessage, { role: 'tool' }>,
): string {
  const call = callOf(messages, result.toolCallId);
  if (call === null) {
    throw new Error(
      `the scripted double got a result for ${result.toolCallId} without the tool call that asked for it`,
    );
  }
  const document = resultDocumentOf(result.content);
  if (refusalSchema.safeParse(document).success) {
    return refusedAnswer(call.name, document, caseIdOfCall(call));
  }
  switch (call.name) {
    case 'list_cases':
      return listAnswer(document);
    case 'read_case':
      return readAnswer(document);
    case 'open_case':
      return openAnswer(document);
    default:
      throw new Error(`the scripted double does not script the tool "${call.name}"`);
  }
}

type ScriptedStep =
  | { readonly type: 'tool'; readonly name: string; readonly argumentsText: string }
  | { readonly type: 'answer'; readonly program: string };

/** What the script asks for next, from the last message alone. */
function stepOf(messages: readonly ModelMessage[]): ScriptedStep {
  const last = messages.at(-1);
  if (last === undefined) {
    throw new Error('the scripted double received no message');
  }
  if (last.role === 'user') {
    if (last.content.startsWith(REPAIR_OPENING)) {
      const answered = lastToolResult(messages);
      if (answered === null) {
        throw new Error(
          'the scripted double was asked to repair a reply of a turn that has no tool result',
        );
      }
      return { type: 'answer', program: answerForTool(messages, answered) };
    }
    const call = callForUser(last.content);
    return { type: 'tool', name: call.name, argumentsText: call.argumentsText };
  }
  if (last.role === 'tool') {
    return { type: 'answer', program: answerForTool(messages, last) };
  }
  throw new Error('the scripted double has no step after an assistant message');
}

/**
 * The scripted assistant: it streams the same program complete() returns. The
 * final reply is sent line by line and the loop yields between lines, so a
 * browser test really exercises the preview of a half-written program instead
 * of receiving the whole answer at once.
 */
export function createScriptedAssistantModel(): StreamingModelAdapter {
  const stream = async function* (request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent> {
    if (request.signal.aborted) {
      yield { type: 'done', outcome: abortedOutcome('') };
      return;
    }
    const step = stepOf(request.messages);
    if (step.type === 'tool') {
      // A fresh id per call: a conversation is stored across turns, so ids
      // numbered by position would repeat and pair a result with another call.
      const call: ModelToolCall = {
        id: randomUUID(),
        name: step.name,
        argumentsText: step.argumentsText,
      };
      yield { type: 'tool_call_started', index: 0, name: call.name };
      yield { type: 'done', outcome: outcomeOf(null, [call], 'tool_calls') };
      return;
    }

    const lines = step.program.split('\n');
    let text = '';
    for (const [index, line] of lines.entries()) {
      if (request.signal.aborted) {
        yield { type: 'done', outcome: abortedOutcome(text) };
        return;
      }
      if (index > 0) {
        // Let the event loop turn, so the deltas arrive as a stream and not in one burst.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const delta = index === lines.length - 1 ? line : `${line}\n`;
      text += delta;
      yield { type: 'text_delta', text: delta };
    }
    if (request.signal.aborted) {
      yield { type: 'done', outcome: abortedOutcome(text) };
      return;
    }
    yield { type: 'done', outcome: outcomeOf(text, [], 'stop') };
  };

  /** One implementation of the script: the non-streaming call reads the streamed answer. */
  const complete = async (request: ModelRequest): Promise<ModelOutcome> => {
    let outcome: ModelOutcome | null = null;
    for await (const event of stream({ ...request, signal: NO_SIGNAL })) {
      if (event.type === 'done') outcome = event.outcome;
    }
    if (outcome === null) {
      throw new Error('the scripted stream ended without a done event');
    }
    return outcome;
  };

  return {
    describe: () => ({
      provider: 'scripted-test-double',
      model: MODEL,
      endpointHost: 'localhost',
      timeoutMs: 0,
    }),
    complete,
    stream,
  };
}

/**
 * The fixed limits of the scripted double: a test turn reads them through the
 * same ModelCatalog interface as a live one, so the turn path is identical,
 * but it never asks models.dev — the double makes no network request at all.
 */
export const SCRIPTED_ASSISTANT_CATALOG: ModelCatalog = {
  limits: async () => ({
    ok: true,
    limits: {
      contextTokens: 128_000,
      outputTokens: 8_192,
      providerId: 'scripted_test',
      modelId: MODEL,
    },
  }),
};
