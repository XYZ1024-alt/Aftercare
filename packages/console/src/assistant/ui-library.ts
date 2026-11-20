import { CASE_TAB_IDS, turnEventSchema, turnStateSchema } from '@aftercare/contracts';
import {
  action,
  createLibrary,
  defineAction,
  defineComponent,
  type Library,
  type PromptOptions,
} from '@openuidev/lang-core';
import { z } from 'zod';

// The single source of the OpenUI components of the console assistant. The
// server validates a reply against this spec, the browser renders it from the
// same spec, and the system prompt is generated from it: prompt, parser and
// renderers cannot drift apart. This module stays browser-safe on purpose — it
// imports the framework-agnostic core only, and a renderer per component
// arrives through createAssistantUiLibrary.

/** The root every reply of the assistant is wrapped in. */
export const ASSISTANT_UI_ROOT = 'AgentTurn';

/** Every component of the library, in dependency order. */
export const ASSISTANT_UI_COMPONENTS = [
  'AgentTurn',
  'AgentState',
  'EventItem',
  'NarrativeBlock',
  'CalloutBlock',
  'CaseWorkbenchBlock',
  'CaseSummaryBlock',
  'CaseListBlock',
  'ActionBar',
  'ActionButton',
] as const;
export type AssistantUiComponent = (typeof ASSISTANT_UI_COMPONENTS)[number];

const toneSchema = z.enum(['neutral', 'sky', 'mint', 'apricot', 'rose', 'violet']);
const buttonToneSchema = z.enum(['primary', 'secondary']);
const caseListFilterSchema = z.enum(['needs_attention', 'active', 'all']);

/** The action a button may carry besides @ToAssistant: open the panel of one case. */
export const openCasePanelAction = defineAction({
  name: 'OpenCasePanel',
  description:
    'Open the case panel of one case in the console, on the given tab, without sending anything to the assistant.',
  params: z.object({
    caseId: z.uuid(),
    tab: z.enum(CASE_TAB_IDS).optional(),
  }),
});

function defineAssistantUiComponents<C>(renderers: Readonly<Record<AssistantUiComponent, C>>) {
  // The state of this turn: the same fields turnStateSchema defines, optional
  // where the model may leave them out. Headline and mode are required; the
  // parser reports a missing one instead of guessing.
  const AgentState = defineComponent({
    name: 'AgentState',
    description:
      'The state of this turn as a snapshot: mode, a one-sentence headline, the focused case and tab, the cases being tracked, and the recommended next step. Every reply has exactly one AgentState, passed to AgentTurn as its first argument.',
    props: z.object({
      mode: turnStateSchema.shape.mode,
      headline: turnStateSchema.shape.headline,
      focusCaseId: turnStateSchema.shape.focusCaseId.optional(),
      focusTab: turnStateSchema.shape.focusTab.optional(),
      // unwrap keeps the field of turnStateSchema but prints "string[]" in the
      // prompt: the readonly wrapper would print "any" and invite a bad argument.
      trackedCaseIds: turnStateSchema.shape.trackedCaseIds.unwrap().optional(),
      nextStep: turnStateSchema.shape.nextStep.optional(),
    }),
    component: renderers.AgentState,
  });

  const EventItem = defineComponent({
    name: 'EventItem',
    description:
      'One milestone that really happened during this turn: a case opened, a stage observed, a run controlled, a wait finished, a person needed, an action refused. List them in the order they happened; never describe an intention or a plan as an event.',
    props: z.object({
      kind: turnEventSchema.shape.kind,
      summary: turnEventSchema.shape.summary,
      caseId: turnEventSchema.shape.caseId.optional(),
      tab: turnEventSchema.shape.tab.optional(),
      detailCode: turnEventSchema.shape.detailCode.optional(),
    }),
    component: renderers.EventItem,
  });

  const NarrativeBlock = defineComponent({
    name: 'NarrativeBlock',
    description:
      'The prose of the reply, in Markdown: what the assistant observed, concluded or proposes. Use it for every explanation the operator has to read.',
    props: z.object({
      markdown: z.string(),
      title: z.string().optional(),
    }),
    component: renderers.NarrativeBlock,
  });

  const CalloutBlock = defineComponent({
    name: 'CalloutBlock',
    description:
      'A highlighted note with a tone: a refusal (rose), a warning, or an important hint that must not be missed between the prose.',
    props: z.object({
      tone: toneSchema,
      title: z.string(),
      body: z.string(),
    }),
    component: renderers.CalloutBlock,
  });

  const CaseWorkbenchBlock = defineComponent({
    name: 'CaseWorkbenchBlock',
    description:
      'The live workbench of one case, with its stage, open questions, plan, controls, budgets and reports. Use it whenever a person has to act on the case or watch it closely, and set tab to the tab where they act.',
    props: z.object({
      caseId: z.uuid(),
      tab: z.enum(CASE_TAB_IDS).optional(),
      reason: z.string().optional(),
    }),
    component: renderers.CaseWorkbenchBlock,
  });

  const CaseSummaryBlock = defineComponent({
    name: 'CaseSummaryBlock',
    description:
      'A compact read-only summary of one case with a button that opens it in a drawer. Use it when the case only has to be mentioned and no live panel is needed.',
    props: z.object({
      caseId: z.uuid(),
      note: z.string().optional(),
      tab: z.enum(CASE_TAB_IDS).optional(),
    }),
    component: renderers.CaseSummaryBlock,
  });

  const CaseListBlock = defineComponent({
    name: 'CaseListBlock',
    description:
      'A table of several cases with their live stage and open questions. Use it when the turn lists or compares cases; caseIds must be the ids a listing tool returned in this turn.',
    props: z.object({
      title: z.string(),
      filter: caseListFilterSchema,
      caseIds: z.array(z.uuid()),
    }),
    component: renderers.CaseListBlock,
  });

  const ActionButton = defineComponent({
    name: 'ActionButton',
    description:
      'One button: a short label and exactly one action. @ToAssistant(message) sends a follow-up request; @OpenCasePanel(caseId, tab?) opens the case panel. tone is primary for the main suggestion and secondary otherwise.',
    props: z.object({
      label: z.string(),
      action: action(),
      tone: buttonToneSchema.optional(),
    }),
    component: renderers.ActionButton,
  });

  const ActionBar = defineComponent({
    name: 'ActionBar',
    description:
      'A horizontal row of buttons at the end of the reply. Pass one to three ActionButtons.',
    props: z.object({
      items: z.array(ActionButton.ref),
    }),
    component: renderers.ActionBar,
  });

  const AgentTurn = defineComponent({
    name: ASSISTANT_UI_ROOT,
    description:
      'The root of every reply: the state of the turn, the events of the turn in order, and the blocks the operator reads. Must be the first statement.',
    props: z.object({
      state: AgentState.ref,
      events: z.array(EventItem.ref),
      blocks: z.array(
        z.union([
          NarrativeBlock.ref,
          CalloutBlock.ref,
          CaseWorkbenchBlock.ref,
          CaseSummaryBlock.ref,
          CaseListBlock.ref,
          ActionBar.ref,
        ]),
      ),
    }),
    component: renderers.AgentTurn,
  });

  return {
    AgentTurn,
    AgentState,
    EventItem,
    NarrativeBlock,
    CalloutBlock,
    CaseWorkbenchBlock,
    CaseSummaryBlock,
    CaseListBlock,
    ActionBar,
    ActionButton,
  } as const;
}

const nullRenderers: Readonly<Record<AssistantUiComponent, null>> = {
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
};

// A renderer-less build of the same components: only its type is used, so the
// props type of each component is derived from the schemas themselves.
const createSpecComponents = () => defineAssistantUiComponents<null>(nullRenderers);
type SpecComponents = ReturnType<typeof createSpecComponents>;

export type AssistantUiProps = {
  readonly [K in AssistantUiComponent]: z.output<SpecComponents[K]['props']>;
};

const COMPONENT_GROUPS = [
  {
    name: 'Shell',
    components: ['AgentTurn', 'AgentState', 'EventItem'],
    notes: [
      '- Exactly one AgentTurn is the root of every reply, as the first statement: root = AgentTurn(state, events, blocks).',
      '- AgentState and EventItem are declared as their own statements and passed by name; the events list is in the order they happened.',
      '- Never write prose outside the program, and never add a second root or a second AgentState.',
    ],
  },
  {
    name: 'Narrative',
    components: ['NarrativeBlock', 'CalloutBlock'],
    notes: [
      '- NarrativeBlock carries every explanation; write the Markdown in Simplified Chinese.',
      '- CalloutBlock is for a refusal or a warning that must not be missed: use tone "rose" for a refusal and "apricot" for a caution.',
    ],
  },
  {
    name: 'Case',
    components: ['CaseWorkbenchBlock', 'CaseSummaryBlock', 'CaseListBlock'],
    notes: [
      '- Use CaseWorkbenchBlock when a person has to act on a case or watch it live; set tab to the tab where they act (questions, plan, execution, results, process).',
      '- Use CaseSummaryBlock when the case only needs to be mentioned; it is read-only and opens a drawer.',
      '- CaseListBlock lists several cases: pass the ids the listing tool returned, in its order.',
      '- Only ids that a tool returned in this turn; never invent, guess or shorten a case id.',
    ],
  },
  {
    name: 'Actions',
    components: ['ActionBar', 'ActionButton'],
    notes: [
      '- A button carries exactly one action: @ToAssistant(message) or @OpenCasePanel(caseId, tab).',
      '- Never use @OpenUrl, @Set, @Reset, @Run, Query or Mutation: they are rejected and the reply is discarded.',
      '- Keep labels short; use tone "primary" for at most one button per ActionBar.',
    ],
  },
];

/**
 * Builds the library for a renderer per component. Call it once at module
 * scope: a new library per render makes the Renderer parse from the start.
 */
export function createAssistantUiLibrary<C>(
  renderers: Readonly<Record<AssistantUiComponent, C>>,
): Library<C, typeof openCasePanelAction> {
  const components = defineAssistantUiComponents(renderers);
  return createLibrary<C, typeof openCasePanelAction>({
    root: ASSISTANT_UI_ROOT,
    components: Object.values(components),
    componentGroups: COMPONENT_GROUPS,
    actions: [openCasePanelAction],
  });
}

/** How the prompt explains the library to the model. */
export const ASSISTANT_UI_PROMPT_OPTIONS: PromptOptions = {
  preamble:
    'Your final reply is exactly one OpenUI Lang program whose first statement is root = AgentTurn(state, events, blocks), rendered as the GenUI blocks of this turn. Nothing outside that program is shown to the operator: no prose, no Markdown, no code fences, no explanation.',
  additionalRules: [
    'All user-visible text in the program is Simplified Chinese (简体中文); component names, prop names and action names stay unchanged.',
    'Never write a URL, a markdown link or an HTML link. Point the operator to a case tab instead.',
    'state.mode is the posture of this turn: idle (nothing is pending), tracking (an investigation or execution runs in the background), waiting_human (a person must act on the page), blocked (a refusal, a failed call or missing information stopped the turn), completed (the request of this turn is answered). Mode is a posture of the conversation, never a verdict on a case.',
    'Report only what happened in this turn. Events describe what a tool did or what a tool result showed; never write an event for a step you intend to take next, and never invent a case id or a stage.',
    'Describe the stage of a case only from the tool results of this turn. Say a case is sealed or verified only when read_case returned verified_sealed or partially_resolved; applied_unverified is applied but not verified; result_stale no longer holds.',
    'When a person has to act, add a CaseWorkbenchBlock for that case and set its tab to where they act: questions for business questions, plan for an execution approval, execution for verification results and controls, results for reports and artefacts, process for the course of the run.',
    'Buttons carry only @ToAssistant(message) or @OpenCasePanel(caseId, tab); every other step is rejected.',
    'Mapping of the usual turns: an incident just opened (tracking) is NarrativeBlock + CaseWorkbenchBlock(caseId, "process") + optionally ActionBar; stopped on a business question (waiting_human) is NarrativeBlock + CaseWorkbenchBlock(caseId, "questions", "请确认以下业务问题"); stopped on an execution approval (waiting_human) is NarrativeBlock + CaseWorkbenchBlock(caseId, "plan", "请审核修复计划并决定是否批准"); a sealed, partially resolved or stale report (completed or waiting_human) is NarrativeBlock + CaseWorkbenchBlock(caseId, "results", "可在此查看报告或下载产物"); a pause, resume, cancel or budget change (tracking or waiting_human) is NarrativeBlock + CaseWorkbenchBlock(caseId, "process", "可在此控制运行或调整预算"); listing cases (idle or waiting_human) is NarrativeBlock + CaseListBlock(title, filter, caseIds); an out-of-scope request or a refused call (blocked) is CalloutBlock("rose", "操作未执行", reason and where a person acts) plus CaseWorkbenchBlock(caseId, tab) when a case is involved.',
  ],
  examples: [
    [
      'root = AgentTurn(state, [opened], [narrative, workbench, actions])',
      'state = AgentState("tracking", "已开案并启动调查", "3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "process", ["3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f"], "调查进展会在这里实时更新")',
      'opened = EventItem("case_opened", "已开案并启动调查", "3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "process", null)',
      'narrative = NarrativeBlock("已为这起事故开案，调查在后台进行。")',
      'workbench = CaseWorkbenchBlock("3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "process", "调查进展会在这里更新")',
      'actions = ActionBar([ask])',
      'ask = ActionButton("查看最新进展", @ToAssistant("这个案例现在进展如何？"), "primary")',
    ].join('\n'),
    [
      'root = AgentTurn(state, [observed, needed], [narrative, workbench])',
      'state = AgentState("waiting_human", "等待业务问题确认", "3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "questions", ["3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f"], "请在业务问题页签回答后让我继续")',
      'observed = EventItem("stage_observed", "调查停在业务问题确认", "3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "questions", "awaiting_answer")',
      'needed = EventItem("human_action_needed", "需要你确认事故涉及的范围", "3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "questions", null)',
      'narrative = NarrativeBlock("调查需要你确认事故涉及的对象范围。")',
      'workbench = CaseWorkbenchBlock("3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "questions", "请确认以下业务问题")',
    ].join('\n'),
    [
      'root = AgentTurn(state, [queried], [narrative, list])',
      'state = AgentState("idle", "已列出待处理案例", null, null, [], null)',
      'queried = EventItem("cases_queried", "查询了待处理案例", null, null, null)',
      'narrative = NarrativeBlock("目前有 2 个案例需要你处理。")',
      'list = CaseListBlock("待处理案例", "needs_attention", ["3f1d2f7e-5c5a-4d3b-9f0e-1a2b3c4d5e6f", "0b6a3c2d-7e4f-4a1b-8c9d-2e3f4a5b6c7d"])',
    ].join('\n'),
  ],
  toolCalls: false,
  bindings: false,
  editMode: false,
  inlineMode: false,
  builtinFunctions: false,
};
