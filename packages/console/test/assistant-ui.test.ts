import type { TurnEvent, TurnEventKind } from '@aftercare/contracts';
import { TURN_EVENT_LIMIT } from '@aftercare/contracts';
import type { JsonObject } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_UI_PROMPT_OPTIONS } from '../src/assistant/ui-library.ts';
import {
  type AssistantToolMessage,
  type AssistantUi,
  assistantUiSpecLibrary,
  corroborateEvents,
  extractAssistantUi,
  repairPrompt,
  synthesizeFallbackUi,
  validateAssistantUi,
} from '../src/assistant/ui-parser.ts';

// The pure reader of an assistant reply: the examples the prompt shows, the
// fence the model wraps its program in, the closed set of components and
// steps, the contract checks of the state and the events, the corroboration
// of an event against the tool records of its turn, and the fallback reply
// written when the model produced none. No database, no model, no browser.

const CASE = '3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f';
const OTHER_CASE = '0b6a3c2d-7e4f-4a1b-8c9d-2e3f4a5b6c7d';

/** A reply that opens one case, with a workbench and one event. */
const openedReply = [
  'root = AgentTurn(state, [opened], [narrative, workbench])',
  `state = AgentState("tracking", "已开案并启动调查", "${CASE}", "process", ["${CASE}"], "调查进展会在这里更新")`,
  `opened = EventItem("case_opened", "已开案并启动调查", "${CASE}", "process", null)`,
  'narrative = NarrativeBlock("已为这起事故开案，调查在后台进行。")',
  `workbench = CaseWorkbenchBlock("${CASE}", "process", "调查进展会在这里更新")`,
].join('\n');

/** A reply that carries one button with the given step. */
const actionReply = (step: string): string =>
  [
    'root = AgentTurn(state, [], [narrative, actions])',
    'state = AgentState("idle", "等待你的下一步")',
    'narrative = NarrativeBlock("文字")',
    'actions = ActionBar([ask])',
    `ask = ActionButton("按钮", ${step})`,
  ].join('\n');

/** A reply with count human action events. */
const eventsReply = (count: number): string => {
  const names = Array.from({ length: count }, (_, index) => `event${index + 1}`);
  return [
    `root = AgentTurn(state, [${names.join(', ')}], [narrative])`,
    'state = AgentState("waiting_human", "等待处理")',
    ...names.map(
      (name, index) => `${name} = EventItem("human_action_needed", "待处理事件 ${index + 1}")`,
    ),
    'narrative = NarrativeBlock("文字")',
  ].join('\n');
};

/** A reply whose workbench blocks are extracted in order beside a summary. */
const twoWorkbenchesReply = [
  'root = AgentTurn(state, [opened], [narrative, first, second, summary])',
  `state = AgentState("tracking", "跟踪两个案例", "${CASE}", "process", ["${CASE}", "${OTHER_CASE}"], "等待进展")`,
  `opened = EventItem("case_opened", "已开案", "${CASE}", "process", null)`,
  'narrative = NarrativeBlock("文字")',
  `first = CaseWorkbenchBlock("${CASE}", "process")`,
  `second = CaseWorkbenchBlock("${OTHER_CASE}", "results", "查看报告")`,
  `summary = CaseSummaryBlock("${CASE}", "摘要")`,
].join('\n');

const replaceOnce = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) {
    throw new Error(`the fixture does not contain ${from}`);
  }
  return text.replace(from, to);
};

/** The reply that must validate, or an error listing why it does not. */
const accept = (text: string): { readonly content: string; readonly ui: AssistantUi } => {
  const validation = validateAssistantUi(text);
  if (!validation.ok) {
    throw new Error(`expected a valid reply: ${validation.errors.join('; ')}`);
  }
  return { content: validation.content, ui: validation.ui };
};

/** The errors of a reply that must be rejected. */
const reject = (text: string): readonly string[] => {
  const validation = validateAssistantUi(text);
  expect(validation.ok).toBe(false);
  return validation.ok ? [] : validation.errors;
};

const eventOf = (kind: TurnEventKind, caseId: string | null = null): TurnEvent => ({
  kind,
  summary: '事件',
  caseId,
  tab: null,
  detailCode: null,
});

const toolOf = (
  name: string,
  ok: boolean,
  caseIds: readonly string[] = [],
  result: JsonObject = {},
): AssistantToolMessage => ({
  role: 'tool',
  toolCallId: `${name}-${caseIds.length}`,
  name,
  ok,
  result,
  caseIds,
});

/** Asserts a fallback reply parses to exactly the UI it reports. */
const settle = (fallback: { readonly content: string; readonly ui: AssistantUi }): void => {
  expect(fallback.content.startsWith('```')).toBe(false);
  expect(validateAssistantUi(fallback.content).ok).toBe(true);
  expect(extractAssistantUi(fallback.content)).toEqual(fallback.ui);
};

describe('ASSISTANT_UI_PROMPT_OPTIONS', () => {
  it('shows only replies that validate', () => {
    const examples = ASSISTANT_UI_PROMPT_OPTIONS.examples ?? [];
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      const { content } = accept(example);
      expect(content).toBe(example);
    }
  });

  it('states the AgentTurn signature in the generated system prompt', () => {
    const prompt = assistantUiSpecLibrary.prompt(ASSISTANT_UI_PROMPT_OPTIONS);
    expect(prompt).toContain('AgentTurn(');
  });
});

describe('validateAssistantUi', () => {
  it('returns the state, the events and the workbench cases of a valid reply', () => {
    const { content, ui } = accept(twoWorkbenchesReply);
    expect(content).toBe(twoWorkbenchesReply);
    expect(ui.state).toEqual({
      mode: 'tracking',
      headline: '跟踪两个案例',
      focusCaseId: CASE,
      focusTab: 'process',
      trackedCaseIds: [CASE, OTHER_CASE],
      nextStep: '等待进展',
    });
    expect(ui.events).toEqual([
      {
        kind: 'case_opened',
        summary: '已开案',
        caseId: CASE,
        tab: 'process',
        detailCode: null,
      },
    ]);
    expect(ui.workbenchCaseIds).toEqual([CASE, OTHER_CASE]);
  });

  it('strips the code fence the model wraps the program in', () => {
    const fenced = ['```', openedReply, '```'].join('\n');
    expect(accept(fenced).content).toBe(openedReply);
    const tagged = ['```openui', openedReply, '```'].join('\n');
    expect(accept(tagged).content).toBe(openedReply);
  });

  it('rejects an empty reply', () => {
    expect(reject('   \n')).toEqual(['program: the reply is empty']);
  });

  it('rejects any step but @ToAssistant and @OpenCasePanel in a button', () => {
    expect(reject(actionReply('@OpenUrl("https://example.com")')).join(' ')).toContain(
      '@OpenUrl is not allowed in a button',
    );
    expect(reject(actionReply('@Set("a", 1)')).join(' ')).toContain(
      '@Set is not allowed in a button',
    );
    accept(actionReply('@ToAssistant("这个案例现在进展如何？")'));
    accept(actionReply(`@OpenCasePanel("${CASE}", "process")`));
  });

  it('rejects an expression in any prop but a button action', () => {
    const reply = (caseId: string, reason: string): string =>
      [
        'root = AgentTurn(state, [], [w])',
        'state = AgentState("idle", "ok")',
        `w = CaseWorkbenchBlock(${caseId}, "process", ${reason})`,
      ].join('\n');
    expect(reject(reply(`"${CASE}"`, '@Set("a", 1)')).join(' ')).toContain(
      'w /reason: write a literal value here',
    );
    expect(reject(reply('@Set("a", 1)', '"原因"')).join(' ')).toContain(
      'w /caseId: write a literal value here',
    );
    accept(reply(`"${CASE}"`, '"原因"'));
  });

  it('rejects state variables, queries and mutations', () => {
    expect(reject([openedReply, '$answer = "x"'].join('\n')).join(' ')).toContain(
      '$state variables are not allowed',
    );
    expect(reject([openedReply, 'q = Query("cases")'].join('\n')).join(' ')).toContain(
      'Query(...) is not allowed',
    );
    expect(reject([openedReply, 'm = Mutation("x")'].join('\n')).join(' ')).toContain(
      'Mutation(...) is not allowed',
    );
  });

  it('rejects a root that is not AgentTurn and a reply without a root', () => {
    const wrongRoot = [
      'root = NarrativeBlock("文字")',
      'state = AgentState("idle", "根不对")',
    ].join('\n');
    expect(reject(wrongRoot).join(' ')).toContain('the root is NarrativeBlock, not AgentTurn');
    const noRoot = [
      'state = AgentState("idle", "没有根")',
      'narrative = NarrativeBlock("文字")',
    ].join('\n');
    expect(reject(noRoot).join(' ')).toContain('there is no root statement');
  });

  it('rejects a block in the event slot and an event in the block slot', () => {
    expect(reject(replaceOnce(openedReply, '[opened]', '[narrative]')).join(' ')).toContain(
      'NarrativeBlock is not an EventItem',
    );
    expect(
      reject(replaceOnce(openedReply, '[narrative, workbench]', '[opened]')).join(' '),
    ).toContain('EventItem is not a block of a turn');
  });

  it('accepts TURN_EVENT_LIMIT events and rejects one more', () => {
    expect(TURN_EVENT_LIMIT).toBe(32);
    expect(accept(eventsReply(TURN_EVENT_LIMIT)).ui.events).toHaveLength(TURN_EVENT_LIMIT);
    expect(reject(eventsReply(TURN_EVENT_LIMIT + 1)).join(' ')).toContain('at most 32');
  });

  it('rejects an empty headline', () => {
    const empty = replaceOnce(openedReply, '"tracking", "已开案并启动调查"', '"tracking", ""');
    expect(reject(empty).join(' ')).toContain('headline');
  });

  it('rejects a mode outside TURN_STATE_MODES', () => {
    const unknownMode = replaceOnce(openedReply, '"tracking"', '"bogus"');
    expect(reject(unknownMode).join(' ')).toContain('mode');
  });
});

describe('extractAssistantUi', () => {
  it('returns the parsed reply of a stored message', () => {
    const ui = extractAssistantUi(twoWorkbenchesReply);
    expect(ui).not.toBeNull();
    expect(ui).toEqual(accept(twoWorkbenchesReply).ui);
  });

  it('returns null for content that is not a valid reply', () => {
    expect(extractAssistantUi('这不是 OpenUI Lang。')).toBeNull();
    expect(extractAssistantUi(replaceOnce(openedReply, '"tracking"', '"bogus"'))).toBeNull();
  });
});

describe('corroborateEvents', () => {
  it('backs case_opened only by a successful open_case of that case', () => {
    const opened = eventOf('case_opened', CASE);
    expect(corroborateEvents([opened], [toolOf('open_case', true, [CASE])])).toEqual([true]);
    expect(corroborateEvents([opened], [toolOf('open_case', true, [OTHER_CASE])])).toEqual([false]);
    expect(corroborateEvents([opened], [toolOf('open_case', false, [CASE])])).toEqual([false]);
    expect(
      corroborateEvents([eventOf('case_opened')], [toolOf('open_case', true, [CASE])]),
    ).toEqual([false]);
    expect(corroborateEvents([opened], [])).toEqual([false]);
  });

  it('backs case_rerun and run_controlled by their own successful calls', () => {
    expect(
      corroborateEvents([eventOf('case_rerun', CASE)], [toolOf('rerun_case', true, [CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents([eventOf('case_rerun', CASE)], [toolOf('rerun_case', false, [CASE])]),
    ).toEqual([false]);
    expect(
      corroborateEvents([eventOf('run_controlled', CASE)], [toolOf('control_run', true, [CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents([eventOf('run_controlled', CASE)], [toolOf('control_run', false, [CASE])]),
    ).toEqual([false]);
  });

  it('backs wait_finished by any wait_for_case of the case, failed or not', () => {
    expect(
      corroborateEvents([eventOf('wait_finished', CASE)], [toolOf('wait_for_case', false, [CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents(
        [eventOf('wait_finished', CASE)],
        [toolOf('wait_for_case', true, [OTHER_CASE])],
      ),
    ).toEqual([false]);
  });

  it('backs cases_queried and stage_observed by a successful query tool', () => {
    expect(corroborateEvents([eventOf('cases_queried')], [toolOf('list_cases', true)])).toEqual([
      true,
    ]);
    expect(corroborateEvents([eventOf('cases_queried')], [toolOf('list_cases', false)])).toEqual([
      false,
    ]);
    expect(
      corroborateEvents([eventOf('cases_queried')], [toolOf('read_case', true, [OTHER_CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents([eventOf('stage_observed', CASE)], [toolOf('read_case', true, [CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents(
        [eventOf('stage_observed', CASE)],
        [toolOf('read_case', true, [OTHER_CASE])],
      ),
    ).toEqual([false]);
    expect(corroborateEvents([eventOf('stage_observed', CASE)], [])).toEqual([false]);
  });

  it('backs action_refused only by a failed tool and human_action_needed always', () => {
    expect(
      corroborateEvents([eventOf('action_refused', CASE)], [toolOf('open_case', false, [CASE])]),
    ).toEqual([true]);
    expect(
      corroborateEvents([eventOf('action_refused', CASE)], [toolOf('open_case', true, [CASE])]),
    ).toEqual([false]);
    expect(corroborateEvents([eventOf('human_action_needed', CASE)], [])).toEqual([true]);
  });

  it('returns one flag per event, in order', () => {
    const events = [
      eventOf('human_action_needed', CASE),
      eventOf('case_opened', OTHER_CASE),
      eventOf('action_refused', CASE),
    ];
    expect(corroborateEvents(events, [toolOf('open_case', false, [CASE])])).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe('synthesizeFallbackUi', () => {
  it('writes an idle reply when no tool ran', () => {
    const fallback = synthesizeFallbackUi(null, []);
    settle(fallback);
    expect(fallback.ui.state).toEqual({
      mode: 'idle',
      headline: '本回合没有执行案例操作',
      focusCaseId: null,
      focusTab: null,
      trackedCaseIds: [],
      nextStep: null,
    });
    expect(fallback.ui.events).toEqual([]);
    expect(fallback.content).toContain('助手的回复格式有误');
  });

  it('writes a tracking reply when a case opened', () => {
    const fallback = synthesizeFallbackUi('已为这起事故开案。', [
      toolOf('open_case', true, [CASE], { case: { caseId: CASE } }),
    ]);
    settle(fallback);
    expect(fallback.ui.state.mode).toBe('tracking');
    expect(fallback.ui.state.headline).toBe('已开案并启动调查');
    expect(fallback.ui.state.focusCaseId).toBe(CASE);
    expect(fallback.ui.events).toEqual([
      {
        kind: 'case_opened',
        summary: '已开案并启动调查',
        caseId: CASE,
        tab: 'process',
        detailCode: null,
      },
    ]);
    expect(fallback.content).toContain('已为这起事故开案。');
    expect(fallback.content).toContain('CaseSummaryBlock');
  });

  it('writes a blocked reply when a call was refused', () => {
    const fallback = synthesizeFallbackUi(null, [
      toolOf('open_case', false, [CASE], { refusal: { code: 'forbidden' } }),
    ]);
    settle(fallback);
    expect(fallback.ui.state.mode).toBe('blocked');
    expect(fallback.ui.state.nextStep).toBe('请查看工具记录的拒绝原因');
    expect(fallback.ui.events).toEqual([
      {
        kind: 'action_refused',
        summary: '开案被拒绝',
        caseId: CASE,
        tab: null,
        detailCode: 'forbidden',
      },
    ]);
  });

  it('writes a stage_observed reply when a case was read', () => {
    const fallback = synthesizeFallbackUi(null, [
      toolOf('read_case', true, [CASE], { stage: { stage: 'awaiting_answer' } }),
    ]);
    settle(fallback);
    expect(fallback.ui.state.mode).toBe('idle');
    expect(fallback.ui.state.headline).toBe('已读取案例现状');
    expect(fallback.ui.events).toEqual([
      {
        kind: 'stage_observed',
        summary: '读取了案例现状',
        caseId: CASE,
        tab: 'questions',
        detailCode: 'awaiting_answer',
      },
    ]);
  });

  it('keeps a turn with more than TURN_EVENT_LIMIT tool calls within the event limit', () => {
    const caseIdAt = (index: number): string =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const tools = Array.from({ length: TURN_EVENT_LIMIT + 8 }, (_, index) =>
      toolOf('open_case', true, [caseIdAt(index)]),
    );
    const fallback = synthesizeFallbackUi('很多案例', tools);
    settle(fallback);
    expect(fallback.ui.state.mode).toBe('tracking');
    expect(fallback.ui.events).toHaveLength(TURN_EVENT_LIMIT);
    expect(fallback.ui.state.trackedCaseIds).toHaveLength(10);
    const eventLines = fallback.content.split('\n').filter((line) => line.includes('= EventItem('));
    expect(eventLines).toHaveLength(TURN_EVENT_LIMIT);
  });
});

describe('repairPrompt', () => {
  it('lists every error and asks for one complete program', () => {
    const prompt = repairPrompt(['program: bad root', 'turn /events: too many']);
    expect(prompt).toContain('program: bad root');
    expect(prompt).toContain('turn /events: too many');
    expect(prompt).toContain('AgentTurn(state, events, blocks)');
    expect(prompt).toContain('no code fences');
  });
});
