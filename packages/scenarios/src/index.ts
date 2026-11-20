import type { Scenario } from './scenario.ts';
import { oversellAfterCorrectionScenario } from './scenarios/oversell-after-correction.ts';
import { priceAndStockImportsScenario } from './scenarios/price-and-stock-imports.ts';
import { priceRetryTwiceScenario } from './scenarios/price-retry-twice.ts';
import { priceTypoStockMovesScenario } from './scenarios/price-typo-stock-moves.ts';
import { priceYuanAsCentsScenario } from './scenarios/price-yuan-as-cents.ts';
import { seasonalMarkdownScenario } from './scenarios/seasonal-markdown.ts';
import { stocktakeRowShiftScenario } from './scenarios/stocktake-row-shift.ts';

export * from './catalog.ts';
export * from './runner.ts';
export * from './scenario.ts';

/** Every demo scenario, in round order (r01..r07). */
export const SCENARIOS = [
  priceYuanAsCentsScenario,
  priceRetryTwiceScenario,
  seasonalMarkdownScenario,
  stocktakeRowShiftScenario,
  oversellAfterCorrectionScenario,
  priceTypoStockMovesScenario,
  priceAndStockImportsScenario,
] as const satisfies readonly Scenario[];

/** The literal id of a declared scenario. */
export type ScenarioId = (typeof SCENARIOS)[number]['id'];

/** The scenarios indexed by id, built from SCENARIOS so the two cannot drift. */
export const SCENARIOS_BY_ID: Readonly<Record<string, Scenario>> = Object.fromEntries(
  SCENARIOS.map((scenario) => [scenario.id, scenario] as const),
);

/** Finds a scenario by id; undefined when the id is unknown. */
export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS_BY_ID[id];
}
