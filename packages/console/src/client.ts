// The browser-safe surface of the console package: types and plain constants.

export type {
  AgentLimits,
  Artefact,
  AutonomyCaseView,
  AutonomyCharterSummary,
  AutonomyDecision,
  AutonomyDecisionAction,
  AutonomyEnrollment,
  AutonomyStatus,
  AutonomySwitch,
  CaseOverview,
  EvidenceOverview,
  ExecutionApproval,
  NodeDependencies,
  Promotion,
  PromotionCheck,
  PromotionView,
  QuestionBody,
  RetentionReport,
  VerificationReport,
} from '@aftercare/contracts';
export { overviewStage } from './overview.ts';
export type * from './view-model.ts';
export { STAGES } from './view-model.ts';
