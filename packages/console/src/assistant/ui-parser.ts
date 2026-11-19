import type { AssistantMessage, TurnEvent, TurnState } from '@aftercare/contracts';
import { TURN_EVENT_LIMIT, turnEventSchema, turnStateSchema } from '@aftercare/contracts';
import {
  type ASTNode,
  createParser,
  type ElementNode,
  isElementNode,
  type ParseResult,
  type ValidationError,
} from '@openuidev/lang-core';
import { z } from 'zod';
import { ASSISTANT_UI_ROOT, createAssistantUiLibrary } from './ui-library.ts';

// The one reader of a stored assistant reply. The browser extracts the state
// and the events of a reply from it, the server validates the reply of a model
// with it, and the fallback reply is written in the same language: whatever
// the assistant shows is parsed here first. Only the components of the shared
// library can appear, only two actions can be taken, and everything the model
// claims about the turn is checked against the contracts before it is stored.

/** The tool result messages of a turn, in the order they were recorded. */
export type AssistantToolMessage = Extract<AssistantMessage, { role: 'tool' }>;

/** What a stored reply says about its turn. */
export interface AssistantUi {
  readonly state: TurnState;
  readonly events: readonly TurnEvent[];
  /** caseIds of the CaseWorkbenchBlocks of this turn, in order. */
  readonly workbenchCaseIds: readonly string[];
}

export type AssistantUiValidation =
  | { readonly ok: true; readonly content: string; readonly ui: AssistantUi }
  | { readonly ok: false; readonly errors: readonly string[] };

// The blocks a turn may carry, as component names: the union AgentTurn accepts
// in ui-library.ts. The parser does not enforce a union of refs (it accepts any
// component in any slot), so the validator checks the names itself.
const BLOCK_COMPONENTS: ReadonlySet<string> = new Set([
  'NarrativeBlock',
  'CalloutBlock',
  'CaseWorkbenchBlock',
  'CaseSummaryBlock',
  'CaseListBlock',
  'ActionBar',
]);

/** The two steps a button may carry; everything else is rejected here. */
const ALLOWED_STEPS: ReadonlySet<string> = new Set(['ToAssistant', 'OpenCasePanel']);

const SPEC_RENDERERS = {
  AgentTurn: null,
  AgentState: null,
  EventItem: null,
  NarrativeBlock: null,
  CalloutBlock: null,
  CaseWorkbenchBlock: null,
  CaseSummaryBlock: null,
  CaseListBlock: null,
  ActionBar: null,
  ActionButton: null,
} as const;

// Built once: the parser is pure, and a new library per reply would recompile
// the schema for every validation and every rendered message. The system prompt
// is generated from this same instance, so prompt, parser and renderers cannot
// drift apart.
export const assistantUiSpecLibrary = createAssistantUiLibrary(SPEC_RENDERERS);
const PARSER = createParser(assistantUiSpecLibrary.toJSONSchema(), ASSISTANT_UI_ROOT);

const stripFence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const openingEnd = trimmed.indexOf('\n');
  if (openingEnd === -1) {
    return trimmed;
  }
  const body = trimmed.slice(openingEnd + 1);
  const closingStart = body.lastIndexOf('```');
  return (closingStart === -1 ? body : body.slice(0, closingStart)).trim();
};

const formatParseError = (error: ValidationError): string => {
  const statement = error.statementId ?? 'program';
  const path = error.path === '' ? '' : ` ${error.path}`;
  return `${statement}${path}: ${error.message}`;
};

const elementArray = (value: ElementNode['props'][string]): readonly ElementNode[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const elements: ElementNode[] = [];
  for (const item of value) {
    if (!isElementNode(item)) {
      return null;
    }
    elements.push(item);
  }
  return elements;
};

const isAstNode = (value: ElementNode['props'][string]): value is ASTNode => {
  if (typeof value !== 'object' || value === null || !('k' in value)) {
    return false;
  }
  return typeof value.k === 'string';
};

const readStep = (step: ASTNode, location: string, errors: string[]): void => {
  if (step.k === 'Comp' && ALLOWED_STEPS.has(step.name)) {
    return;
  }
  const written = step.k === 'Comp' ? `@${step.name}` : `a ${step.k} expression`;
  errors.push(
    `${location}: ${written} is not allowed in a button; only @ToAssistant(...) and @OpenCasePanel(...) are`,
  );
};

const checkAction = (
  value: ElementNode['props'][string],
  location: string,
  errors: string[],
): void => {
  if (!isAstNode(value)) {
    errors.push(`${location}: the action is not an action step`);
    return;
  }
  if (value.k === 'Comp' && value.name === 'Action') {
    const list = value.args[0];
    if (value.args.length !== 1 || list === undefined || list.k !== 'Arr') {
      errors.push(`${location}: Action takes exactly one array of steps`);
      return;
    }
    for (const step of list.els) {
      readStep(step, location, errors);
    }
    return;
  }
  readStep(value, location, errors);
};

/** Visits every element of the tree, through props and arrays of props. */
const eachElement = (node: ElementNode, visit: (element: ElementNode) => void): void => {
  visit(node);
  for (const value of Object.values(node.props)) {
    if (isElementNode(value)) {
      eachElement(value, visit);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isElementNode(item)) {
          eachElement(item, visit);
        }
      }
    }
  }
};

const issueStrings = (prefix: string, error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.map(String).join('/');
    return `${prefix}${path === '' ? '' : `/${path}`}: ${issue.message}`;
  });

const parseState = (node: ElementNode, errors: string[]): TurnState | null => {
  const parsed = turnStateSchema.safeParse({
    mode: node.props.mode,
    headline: node.props.headline,
    focusCaseId: node.props.focusCaseId ?? null,
    focusTab: node.props.focusTab ?? null,
    trackedCaseIds: node.props.trackedCaseIds ?? [],
    nextStep: node.props.nextStep ?? null,
  });
  if (!parsed.success) {
    errors.push(...issueStrings('turn /state', parsed.error));
    return null;
  }
  return parsed.data;
};

const parseEvent = (node: ElementNode, location: string, errors: string[]): TurnEvent | null => {
  const parsed = turnEventSchema.safeParse({
    kind: node.props.kind,
    summary: node.props.summary,
    caseId: node.props.caseId ?? null,
    tab: node.props.tab ?? null,
    detailCode: node.props.detailCode ?? null,
  });
  if (!parsed.success) {
    errors.push(...issueStrings(location, parsed.error));
    return null;
  }
  return parsed.data;
};

export function validateAssistantUi(text: string): AssistantUiValidation {
  const content = stripFence(text);
  if (content === '') {
    return { ok: false, errors: ['program: the reply is empty'] };
  }

  let result: ParseResult;
  try {
    result = PARSER.parse(content);
  } catch (error) {
    // Parsing is pure, so a throw means the text is not OpenUI Lang at all.
    const message = error instanceof Error ? error.message : 'unknown failure';
    return { ok: false, errors: [`program: the reply could not be parsed (${message})`] };
  }

  const errors: string[] = result.meta.errors
    .filter((error) => error.severity !== 'warning')
    .map(formatParseError);
  if (result.meta.incomplete) {
    errors.push('program: the reply is truncated');
  }
  if (result.queryStatements.length > 0) {
    const statements = result.queryStatements.map((query) => query.statementId).join(', ');
    errors.push(`program: Query(...) is not allowed (${statements})`);
  }
  if (result.mutationStatements.length > 0) {
    const statements = result.mutationStatements.map((mutation) => mutation.statementId).join(', ');
    errors.push(`program: Mutation(...) is not allowed (${statements})`);
  }
  const declarations = Object.keys(result.stateDeclarations);
  if (declarations.length > 0) {
    errors.push(`program: $state variables are not allowed (${declarations.join(', ')})`);
  }

  const root = result.root;
  if (root === null) {
    errors.push(
      `program: there is no root statement; the reply must be root = ${ASSISTANT_UI_ROOT}(...)`,
    );
    return { ok: false, errors };
  }
  if (root.typeName !== ASSISTANT_UI_ROOT) {
    errors.push(`program: the root is ${root.typeName}, not ${ASSISTANT_UI_ROOT}`);
    return { ok: false, errors };
  }

  let state: TurnState | null = null;
  const stateNode = root.props.state;
  if (!isElementNode(stateNode) || stateNode.typeName !== 'AgentState') {
    errors.push('turn /state: expected the state of the turn, AgentState(...)');
  } else {
    state = parseState(stateNode, errors);
  }

  const events: TurnEvent[] = [];
  const eventNodes = elementArray(root.props.events);
  if (eventNodes === null) {
    errors.push('turn /events: expected an array of EventItem(...)');
  } else {
    if (eventNodes.length > TURN_EVENT_LIMIT) {
      errors.push(
        `turn /events: ${eventNodes.length} events, at most ${TURN_EVENT_LIMIT} are allowed`,
      );
    }
    eventNodes.forEach((node, index) => {
      if (node.typeName !== 'EventItem') {
        errors.push(`turn /events[${index}]: ${node.typeName} is not an EventItem`);
        return;
      }
      const event = parseEvent(node, `turn /events[${index}]`, errors);
      if (event !== null) {
        events.push(event);
      }
    });
  }

  const workbenchCaseIds: string[] = [];
  const blockNodes = elementArray(root.props.blocks);
  if (blockNodes === null) {
    errors.push('turn /blocks: expected an array of blocks');
  } else {
    blockNodes.forEach((node, index) => {
      if (!BLOCK_COMPONENTS.has(node.typeName)) {
        errors.push(`turn /blocks[${index}]: ${node.typeName} is not a block of a turn`);
        return;
      }
      if (node.typeName === 'CaseWorkbenchBlock' && typeof node.props.caseId === 'string') {
        workbenchCaseIds.push(node.props.caseId);
      }
    });
  }

  eachElement(root, (element) => {
    const statement = element.statementId ?? element.typeName;
    for (const [key, value] of Object.entries(element.props)) {
      if (key === 'action') {
        checkAction(value, `${statement} /action`, errors);
        continue;
      }
      // The parser lets an expression through any prop and leaves its type
      // unchecked; outside a button's action only literal values are data a
      // block can render, so an expression anywhere else is refused.
      const values = Array.isArray(value) ? value : [value];
      if (values.some(isAstNode)) {
        errors.push(`${statement} /${key}: write a literal value here, not an expression`);
      }
    }
  });

  if (errors.length > 0 || state === null) {
    return { ok: false, errors };
  }
  return { ok: true, content, ui: { state, events, workbenchCaseIds } };
}

/** The parsed reply of a stored message, or null when the stored text is not valid. */
export function extractAssistantUi(content: string): AssistantUi | null {
  const validation = validateAssistantUi(content);
  return validation.ok ? validation.ui : null;
}

const SUCCESSFUL_QUERY_TOOLS: ReadonlySet<string> = new Set([
  'list_cases',
  'read_case',
  'wait_for_case',
]);

const namedCaseTool = (
  tools: readonly AssistantToolMessage[],
  name: string,
  event: TurnEvent,
  mustSucceed = true,
): boolean =>
  tools.some(
    (tool) =>
      tool.name === name &&
      (!mustSucceed || tool.ok) &&
      event.caseId !== null &&
      tool.caseIds.includes(event.caseId),
  );

/** Whether the tool records of the turn back one event (plan §4.3). */
const isCorroborated = (event: TurnEvent, tools: readonly AssistantToolMessage[]): boolean => {
  switch (event.kind) {
    case 'case_opened':
      return namedCaseTool(tools, 'open_case', event);
    case 'case_rerun':
      return namedCaseTool(tools, 'rerun_case', event);
    case 'run_controlled':
      return namedCaseTool(tools, 'control_run', event);
    case 'wait_finished':
      return namedCaseTool(tools, 'wait_for_case', event, false);
    case 'cases_queried':
    case 'stage_observed':
      return tools.some(
        (tool) =>
          SUCCESSFUL_QUERY_TOOLS.has(tool.name) &&
          tool.ok &&
          (event.caseId === null || tool.caseIds.includes(event.caseId)),
      );
    case 'action_refused':
      // The boundary refusals a model writes without calling a tool cannot be
      // told apart from an invention here; a refused call is the checkable case.
      return tools.some((tool) => !tool.ok);
    case 'human_action_needed':
      return true;
  }
};

/** One flag per event, in order: whether the tool records of the turn back it. */
export function corroborateEvents(
  events: readonly TurnEvent[],
  turnTools: readonly AssistantToolMessage[],
): readonly boolean[] {
  return events.map((event) => isCorroborated(event, turnTools));
}

const refusalCodeSchema = z.looseObject({ refusal: z.looseObject({ code: z.string().max(64) }) });
const stageSchema = z.looseObject({ stage: z.looseObject({ stage: z.string().max(64) }) });
const stoppedSchema = z.looseObject({ stopped: z.enum(['changed', 'timeout', 'aborted']) });

const tabOfStage = (stage: string | null): 'questions' | 'plan' | 'results' | 'process' => {
  switch (stage) {
    case 'awaiting_answer':
      return 'questions';
    case 'awaiting_approval':
      return 'plan';
    case 'verified_sealed':
    case 'partially_resolved':
    case 'result_stale':
      return 'results';
    default:
      return 'process';
  }
};

const stageOf = (tool: AssistantToolMessage): string | null => {
  const parsed = stageSchema.safeParse(tool.result);
  return parsed.success ? parsed.data.stage.stage : null;
};

const refusalOf = (tool: AssistantToolMessage): string | null => {
  const parsed = refusalCodeSchema.safeParse(tool.result);
  return parsed.success ? parsed.data.refusal.code : null;
};

/** The event a tool result of this turn makes true, as far as its record tells. */
const eventOfTool = (tool: AssistantToolMessage): TurnEvent | null => {
  const caseId = tool.caseIds[0] ?? null;
  if (!tool.ok) {
    const summaries: Readonly<Record<string, string>> = {
      open_case: '开案被拒绝',
      rerun_case: '重启调查被拒绝',
      read_case: '读取案例被拒绝',
      control_run: '运行控制被拒绝',
      wait_for_case: '等待案例失败',
      list_cases: '查询案例被拒绝',
    };
    const summary = summaries[tool.name];
    if (summary === undefined) {
      return null;
    }
    return { kind: 'action_refused', summary, caseId, tab: null, detailCode: refusalOf(tool) };
  }
  switch (tool.name) {
    case 'open_case':
      return {
        kind: 'case_opened',
        summary: '已开案并启动调查',
        caseId,
        tab: 'process',
        detailCode: null,
      };
    case 'rerun_case':
      return {
        kind: 'case_rerun',
        summary: '已启动新一轮调查',
        caseId,
        tab: 'process',
        detailCode: null,
      };
    case 'list_cases':
      return {
        kind: 'cases_queried',
        summary: '查询了案例列表',
        caseId: null,
        tab: null,
        detailCode: null,
      };
    case 'read_case': {
      const stage = stageOf(tool);
      return {
        kind: 'stage_observed',
        summary: '读取了案例现状',
        caseId,
        tab: tabOfStage(stage),
        detailCode: stage,
      };
    }
    case 'control_run':
      return {
        kind: 'run_controlled',
        summary: '提交了运行控制请求',
        caseId,
        tab: 'process',
        detailCode: null,
      };
    case 'wait_for_case': {
      const parsed = stoppedSchema.safeParse(tool.result);
      const stopped = parsed.success ? parsed.data.stopped : null;
      const summary =
        stopped === 'changed'
          ? '等待到案例发生变化'
          : stopped === 'aborted'
            ? '等待被中止'
            : '等待结束，案例没有变化';
      return { kind: 'wait_finished', summary, caseId, tab: null, detailCode: stopped };
    }
    default:
      return null;
  }
};

const uniqueCaseIds = (tools: readonly AssistantToolMessage[]): string[] => [
  ...new Set(tools.flatMap((tool) => tool.caseIds)),
];

const stateOfFallback = (tools: readonly AssistantToolMessage[]): TurnState => {
  const opened = tools.filter(
    (tool) => tool.name === 'open_case' && tool.ok && tool.caseIds.length > 0,
  );
  const failed = tools.some((tool) => !tool.ok);
  const mode = opened.length > 0 ? 'tracking' : failed ? 'blocked' : 'idle';
  const headline =
    mode === 'tracking'
      ? '已开案并启动调查'
      : mode === 'blocked'
        ? '本回合有操作未完成'
        : tools.some((tool) => tool.name === 'list_cases' && tool.ok)
          ? '已列出案例'
          : tools.some((tool) => tool.name === 'read_case' && tool.ok)
            ? '已读取案例现状'
            : '本回合没有执行案例操作';
  return {
    mode,
    headline,
    focusCaseId: opened[0]?.caseIds[0] ?? uniqueCaseIds(tools)[0] ?? null,
    focusTab: opened.length > 0 ? 'process' : null,
    trackedCaseIds: uniqueCaseIds(tools).slice(0, 10),
    nextStep:
      mode === 'tracking'
        ? '调查进展会随时间更新'
        : mode === 'blocked'
          ? '请查看工具记录的拒绝原因'
          : null,
  };
};

const stringLiteral = (value: string): string => JSON.stringify(value);
const nullableLiteral = (value: string | null): string =>
  value === null ? 'null' : stringLiteral(value);

/**
 * A valid reply written from the tool records alone, for when the model could
 * not produce one. It says what happened and where a person can act; it invents
 * nothing, and it passes validateAssistantUi like any model reply.
 */
export function synthesizeFallbackUi(
  prose: string | null,
  turnTools: readonly AssistantToolMessage[],
): { readonly content: string; readonly ui: AssistantUi } {
  const state = stateOfFallback(turnTools);
  const events = turnTools
    .map(eventOfTool)
    .filter((event): event is TurnEvent => event !== null)
    .slice(0, TURN_EVENT_LIMIT);

  const text = prose?.trim();
  const narrative =
    text === undefined || text === '' ? '助手的回复格式有误，以下为本回合的执行情况。' : text;

  const summaries: string[] = [];
  const seen = new Set<string>();
  for (const tool of turnTools) {
    if (tool.name !== 'open_case' && tool.name !== 'read_case') {
      continue;
    }
    const caseId = tool.caseIds[0];
    if (caseId === undefined || seen.has(caseId) || summaries.length >= 10) {
      continue;
    }
    seen.add(caseId);
    const tab = tool.name === 'open_case' ? 'process' : tabOfStage(stageOf(tool));
    summaries.push(
      `case${summaries.length + 1} = CaseSummaryBlock(${stringLiteral(caseId)}, "本回合涉及的案例", ${stringLiteral(tab)})`,
    );
  }

  const eventNames = events.map((_, index) => `event${index + 1}`);
  const blockNames = ['narrative', ...summaries.map((_, index) => `case${index + 1}`)];
  const lines = [
    `root = AgentTurn(state, [${eventNames.join(', ')}], [${blockNames.join(', ')}])`,
    `state = AgentState(${stringLiteral(state.mode)}, ${stringLiteral(state.headline)}, ${nullableLiteral(state.focusCaseId)}, ${nullableLiteral(state.focusTab)}, ${JSON.stringify(state.trackedCaseIds)}, ${nullableLiteral(state.nextStep)})`,
    ...events.map(
      (event, index) =>
        `${eventNames[index]} = EventItem(${stringLiteral(event.kind)}, ${stringLiteral(event.summary)}, ${nullableLiteral(event.caseId)}, ${nullableLiteral(event.tab)}, ${nullableLiteral(event.detailCode)})`,
    ),
    `narrative = NarrativeBlock(${stringLiteral(narrative)})`,
    ...summaries,
  ];

  const content = lines.join('\n');
  const validation = validateAssistantUi(content);
  if (!validation.ok) {
    throw new Error(`the fallback reply is not valid OpenUI Lang: ${validation.errors.join('; ')}`);
  }
  return { content: validation.content, ui: validation.ui };
}

/** The message that tells the model its reply was invalid and asks for a new one. */
export function repairPrompt(errors: readonly string[]): string {
  const list = errors.map((error) => `- ${error}`).join('\n');
  return `Your previous reply was not a valid OpenUI Lang program, so it was not shown to the operator.\n\nThe program failed these checks:\n${list}\n\nReply again with one complete program: its first statement must be root = AgentTurn(state, events, blocks), written in Simplified Chinese. Output no explanation, no Markdown and no code fences.`;
}
