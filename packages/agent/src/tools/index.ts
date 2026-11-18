import { analysisTool } from './analysis.ts';
import { controlTools } from './control.ts';
import { evidenceTools } from './evidence.ts';
import { hypothesisTools } from './hypotheses.ts';
import { questionTools } from './questions.ts';
import { createToolRegistry, type ToolRegistry } from './registry.ts';
import { repairTools } from './repair.ts';
import { stateTools } from './state.ts';

export * from './registry.ts';

/**
 * Every tool an Agent run has. What is NOT here cannot be done by a model:
 * no SQL, shell or host code execution, no database connection — a program
 * of the model runs only in the run_analysis sandbox, over the read-only
 * evidence queries; no confirmation, approval, publication or seal; no
 * policy, permission or checker change; no write to the source business
 * data, no payment, no notification, no export and no undo (those stay with
 * the entries of stages five and six).
 */
export function createAgentToolRegistry(): ToolRegistry {
  const state = stateTools();
  const evidence = evidenceTools();
  return createToolRegistry([
    ...state,
    ...evidence,
    analysisTool([...state, ...evidence]),
    ...hypothesisTools(),
    ...questionTools(),
    ...repairTools(),
    ...controlTools(),
  ]);
}
