import { z } from 'zod';

/**
 * Model configuration from the environment. These are the MODEL credentials;
 * they are separate from every database credential of the system and are
 * read by the server process only. The API key is held by the adapter and is
 * never written to the database, a log line, a prompt, a tool result or a page.
 */
const modelEnvironmentSchema = z.object({
  /** e.g. https://api.example.com/v1 — the adapter appends /chat/completions. */
  AFTERCARE_MODEL_BASE_URL: z.url({ protocol: /^https?$/ }),
  AFTERCARE_MODEL_API_KEY: z.string().min(1),
  AFTERCARE_MODEL_NAME: z.string().min(1).max(200),
  AFTERCARE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  /** Services disagree on the name of the output limit. */
  AFTERCARE_MODEL_MAX_TOKENS_PARAM: z
    .enum(['max_tokens', 'max_completion_tokens'])
    .default('max_tokens'),
  /**
   * omit: say nothing about parallel tool calls (not every service knows the
   * parameter). disable: send parallel_tool_calls=false. Either way the
   * Runtime executes several requests of one answer strictly one by one.
   */
  AFTERCARE_MODEL_PARALLEL_TOOL_CALLS: z.enum(['omit', 'disable']).default('omit'),
  /** Unset: the parameter is not sent (some models refuse it). */
  AFTERCARE_MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  /** Price per million tokens, as a decimal string. Without both, cost is reported as unknown. */
  AFTERCARE_MODEL_PRICE_INPUT_PER_MTOK: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,6})?$/)
    .optional(),
  AFTERCARE_MODEL_PRICE_OUTPUT_PER_MTOK: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,6})?$/)
    .optional(),
  AFTERCARE_MODEL_PRICE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  /**
   * The public models.dev catalogue. The context window and the output limit
   * are read from the models.dev entry of this model, because the
   * chat-completions service reports neither.
   */
  AFTERCARE_MODELS_DEV_URL: z.url({ protocol: /^https?$/ }).default('https://models.dev/api.json'),
  /** models.dev provider id, when the host of the base URL does not identify it. */
  AFTERCARE_MODEL_CATALOG_PROVIDER: z.string().min(1).max(100).optional(),
  /** models.dev model id, when it differs from AFTERCARE_MODEL_NAME. */
  AFTERCARE_MODEL_CATALOG_MODEL: z.string().min(1).max(200).optional(),
});

export interface ModelPricing {
  readonly inputPerMillionTokens: string;
  readonly outputPerMillionTokens: string;
  readonly currency: string;
}

export interface ModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokensParameter: 'max_tokens' | 'max_completion_tokens';
  readonly parallelToolCalls: 'omit' | 'disable';
  readonly temperature: number | null;
  readonly pricing: ModelPricing | null;
  /**
   * The models.dev entry of this model. It supplies the context window and the
   * output limit, which the chat-completions service does not report.
   */
  readonly catalog: {
    readonly url: string;
    readonly providerId: string | null;
    readonly modelId: string;
  };
}

export const MODEL_ENVIRONMENT_VARIABLES = [
  'AFTERCARE_MODEL_BASE_URL',
  'AFTERCARE_MODEL_API_KEY',
  'AFTERCARE_MODEL_NAME',
] as const;

/** Whether the three required model variables are present at all. Says nothing about their validity. */
export function modelConfigured(env: NodeJS.ProcessEnv): boolean {
  return MODEL_ENVIRONMENT_VARIABLES.every((name) => (env[name] ?? '') !== '');
}

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const parsed = modelEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    // Issues name variables and constraints; z.prettifyError never echoes a value.
    throw new Error(`invalid Aftercare model environment:\n${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  const input = data.AFTERCARE_MODEL_PRICE_INPUT_PER_MTOK;
  const output = data.AFTERCARE_MODEL_PRICE_OUTPUT_PER_MTOK;
  return {
    baseUrl: data.AFTERCARE_MODEL_BASE_URL.replace(/\/+$/, ''),
    apiKey: data.AFTERCARE_MODEL_API_KEY,
    model: data.AFTERCARE_MODEL_NAME,
    timeoutMs: data.AFTERCARE_MODEL_TIMEOUT_MS,
    maxTokensParameter: data.AFTERCARE_MODEL_MAX_TOKENS_PARAM,
    parallelToolCalls: data.AFTERCARE_MODEL_PARALLEL_TOOL_CALLS,
    temperature: data.AFTERCARE_MODEL_TEMPERATURE ?? null,
    pricing:
      input === undefined || output === undefined
        ? null
        : {
            inputPerMillionTokens: input,
            outputPerMillionTokens: output,
            currency: data.AFTERCARE_MODEL_PRICE_CURRENCY,
          },
    catalog: {
      url: data.AFTERCARE_MODELS_DEV_URL,
      providerId: data.AFTERCARE_MODEL_CATALOG_PROVIDER ?? null,
      modelId: data.AFTERCARE_MODEL_CATALOG_MODEL ?? data.AFTERCARE_MODEL_NAME,
    },
  };
}
