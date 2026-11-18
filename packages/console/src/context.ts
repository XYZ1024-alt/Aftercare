import {
  type AgentEnvironment,
  createOpenAiCompatibleAdapter,
  type ModelPricing,
  openAgentEnvironment,
  readModelConfig,
} from '@aftercare/agent';
import {
  CONSOLE_IDENTITY_SOURCE,
  type IdentityContext,
  type OperatorSession,
} from '@aftercare/contracts';
import { type ArtefactService, createArtefactService } from '@aftercare/verify';
import { createLogger, type Logger, secretsOf } from './log.ts';
import { createProcessMetrics, type ProcessMetrics } from './metrics.ts';
import { type ConsoleSettings, readConsoleSettings } from './settings.ts';
import type { ModelStatusView } from './view-model.ts';

/**
 * What every part of the console works with: the stores of the runtime
 * role, the trusted agent service, the artefact service and the deployment
 * settings. It holds no business-writer, authority-admin or migrator
 * connection: the console cannot write source business data, grant a
 * capability or change the schema.
 */
export interface ConsoleContext {
  readonly settings: ConsoleSettings;
  readonly environment: AgentEnvironment;
  readonly artefacts: ArtefactService;
  readonly logger: Logger;
  readonly metrics: ProcessMetrics;
  readonly model: ModelStatusView;
  readonly pricing: ModelPricing | null;
}

export const identityOf = (session: OperatorSession): IdentityContext => ({
  principal: session.principal,
  source: CONSOLE_IDENTITY_SOURCE,
});

/** What may be shown about the model configuration: never the key, never the full URL. */
function describeModel(env: NodeJS.ProcessEnv, settings: ConsoleSettings) {
  if (settings.modelMode !== 'live') {
    return {
      status: {
        mode: settings.modelMode,
        provider: settings.modelMode === 'scripted_test' ? 'scripted-test-double' : null,
        model: settings.modelMode === 'scripted_test' ? 'protocol-driver' : null,
        endpointHost: null,
        timeoutMs: null,
        pricingConfigured: false,
      } satisfies ModelStatusView,
      pricing: null,
    };
  }
  const config = readModelConfig(env);
  const description = createOpenAiCompatibleAdapter(config).describe();
  return {
    status: {
      mode: 'live',
      provider: description.provider,
      model: description.model,
      endpointHost: description.endpointHost,
      timeoutMs: description.timeoutMs,
      pricingConfigured: config.pricing !== null,
    } satisfies ModelStatusView,
    pricing: config.pricing,
  };
}

export function openConsoleContext(
  env: NodeJS.ProcessEnv,
  component: string,
  overrides: { readonly logger?: Logger } = {},
): ConsoleContext {
  const settings = readConsoleSettings(env);
  const environment = openAgentEnvironment(env, settings.target, {
    ...(settings.snapshotLimits === null ? {} : { snapshotLimits: settings.snapshotLimits }),
  });
  const model = describeModel(env, settings);
  return {
    settings,
    environment,
    artefacts: createArtefactService({
      commands: environment.commands,
      caseStore: environment.caseStore,
      store: environment.store,
      directory: settings.artefactDirectory,
    }),
    logger: overrides.logger ?? createLogger(component, { secrets: secretsOf(env) }),
    metrics: createProcessMetrics(),
    model: model.status,
    pricing: model.pricing,
  };
}
