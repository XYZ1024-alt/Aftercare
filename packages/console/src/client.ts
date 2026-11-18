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
  QuestionBody,
  RetentionReport,
  VerificationReport,
} from '@aftercare/contracts';
export type * from './view-model.ts';
export { STAGES } from './view-model.ts';
