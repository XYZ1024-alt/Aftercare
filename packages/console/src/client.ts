// The browser-safe surface of the console package: types and plain constants.

export type {
  AgentLimits,
  Artefact,
  AssistantUiMeta,
  AutonomyCaseView,
  AutonomyCharterSummary,
  AutonomyDecision,
  AutonomyDecisionAction,
  AutonomyEnrollment,
  AutonomyStatus,
  AutonomySwitch,
  CaseOverview,
  CaseTabId,
  EvidenceOverview,
  ExecutionApproval,
  NodeDependencies,
  Promotion,
  PromotionCheck,
  PromotionView,
  QuestionBody,
  RetentionReport,
  SentinelFinding,
  SentinelFindingView,
  SentinelMatchedOperation,
  SentinelState,
  SentinelStatus,
  TurnEvent,
  TurnEventKind,
  TurnState,
  TurnStateMode,
  VerificationReport,
} from '@aftercare/contracts';
export {
  CASE_TAB_IDS,
  TURN_EVENT_KINDS,
  TURN_EVENT_LIMIT,
  TURN_STATE_MODES,
} from '@aftercare/contracts';
export type { AssistantUiComponent, AssistantUiProps } from './assistant/ui-library.ts';
export {
  ASSISTANT_UI_COMPONENTS,
  ASSISTANT_UI_PROMPT_OPTIONS,
  ASSISTANT_UI_ROOT,
  createAssistantUiLibrary,
  openCasePanelAction,
} from './assistant/ui-library.ts';
export type { AssistantUi } from './assistant/ui-parser.ts';
export { extractAssistantUi } from './assistant/ui-parser.ts';
export { overviewStage } from './overview.ts';
export type * from './view-model.ts';
export { STAGES } from './view-model.ts';
