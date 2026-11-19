import type { JsonValue } from '@aftercare/domain';
import { describe, expect, it } from 'vitest';
import {
  createModelsDevCatalog,
  type ModelConfig,
  type ModelLimits,
  type ModelLimitsOutcome,
  readModelConfig,
} from '../src/index.ts';

// Unit tests of the models.dev adapter. No network: the transport is injected
// and every request it would send is captured exactly.

const CATALOG_URL = 'https://models.dev/api.json';
const SECRET = 'sk-test-0123456789-secret';
const ETAG = '"catalogue-1"';

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: SECRET,
  model: 'deepseek-flash',
  timeoutMs: 5_000,
  maxTokensParameter: 'max_tokens',
  parallelToolCalls: 'omit',
  temperature: null,
  pricing: null,
  catalog: { url: CATALOG_URL, providerId: null, modelId: 'deepseek-flash' },
};

/** The catalogue shape of models.dev: providers keyed by id, models keyed by id. */
const CATALOG = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-flash': { id: 'deepseek-flash', limit: { context: 1_048_576, output: 393_216 } },
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'https://openrouter.ai/api/v1',
    models: {
      'deepseek-flash': { id: 'deepseek-flash', limit: { context: 65_536, output: 8_192 } },
    },
  },
  together: {
    id: 'together',
    name: 'Together',
    api: 'https://api.together.xyz/v1',
    models: {
      'unique-model': { id: 'unique-model', limit: { context: 32_768, output: 4_096 } },
    },
  },
};

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal | null;
}

function transport(
  answer: (request: CapturedRequest, index: number) => Response | Promise<Response>,
) {
  const captured: CapturedRequest[] = [];
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal ?? null,
    };
    captured.push(request);
    return answer(request, captured.length - 1);
  }) as typeof fetch;
  return { send, captured };
}

const catalogResponse = (document: JsonValue, etag: string = ETAG) =>
  new Response(JSON.stringify(document), {
    status: 200,
    headers: { 'content-type': 'application/json', etag },
  });

function failureOf(outcome: ModelLimitsOutcome): Extract<ModelLimitsOutcome, { ok: false }> {
  if (outcome.ok) {
    throw new Error('expected a failed model limits outcome');
  }
  return outcome;
}

function limitsOf(outcome: ModelLimitsOutcome): ModelLimits {
  if (!outcome.ok) {
    throw new Error(`expected model limits, got ${outcome.reason}: ${outcome.message}`);
  }
  return outcome.limits;
}

function deferred() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const configWith = (catalog: Partial<ModelConfig['catalog']>, baseUrl?: string): ModelConfig => ({
  ...CONFIG,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  catalog: { ...CONFIG.catalog, ...catalog },
});

describe('the models.dev catalogue adapter', () => {
  it('reads the limits of the provider whose api host matches the model base URL', async () => {
    const { send, captured } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(CONFIG, { fetch: send }).limits();

    expect(outcome).toEqual({
      ok: true,
      limits: {
        contextTokens: 1_048_576,
        outputTokens: 393_216,
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(CATALOG_URL);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.headers.accept).toBe('application/json');
    expect(captured[0]?.headers['if-none-match']).toBeUndefined();
    expect(captured[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
  });

  it('honours an explicit provider id before the host of the base URL', async () => {
    const { send } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(configWith({ providerId: 'openrouter' }), {
      fetch: send,
    }).limits();

    expect(outcome).toEqual({
      ok: true,
      limits: {
        contextTokens: 65_536,
        outputTokens: 8_192,
        providerId: 'openrouter',
        modelId: 'deepseek-flash',
      },
    });
  });

  it('refuses an explicit provider that the catalogue does not carry', async () => {
    const { send } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(configWith({ providerId: 'absent' }), {
      fetch: send,
    }).limits();

    expect(failureOf(outcome).reason).toBe('not_found');
    expect(failureOf(outcome).message).toContain('absent');
  });

  it('falls back to the only provider that lists the model', async () => {
    const { send } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(
      configWith({ modelId: 'unique-model' }, 'https://proxy.example.test/v1'),
      { fetch: send },
    ).limits();

    expect(outcome).toEqual({
      ok: true,
      limits: {
        contextTokens: 32_768,
        outputTokens: 4_096,
        providerId: 'together',
        modelId: 'unique-model',
      },
    });
  });

  it('refuses an ambiguous model and names the providers and the variable that disambiguates it', async () => {
    const { send } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(configWith({}, 'https://proxy.example.test/v1'), {
      fetch: send,
    }).limits();

    const failure = failureOf(outcome);
    expect(failure.reason).toBe('ambiguous');
    expect(failure.message).toContain('deepseek');
    expect(failure.message).toContain('openrouter');
    expect(failure.message).toContain('AFTERCARE_MODEL_CATALOG_PROVIDER');
    expect(failure.message).toContain(CATALOG_URL);
  });

  it('refuses a model the catalogue does not list', async () => {
    const { send } = transport(() => catalogResponse(CATALOG));

    const outcome = await createModelsDevCatalog(configWith({ modelId: 'absent-model' }), {
      fetch: send,
    }).limits();

    const failure = failureOf(outcome);
    expect(failure.reason).toBe('not_found');
    expect(failure.message).toContain('absent-model');
    expect(failure.message).toContain(CATALOG_URL);
  });

  it('reports a body that is not JSON, a wrong shape or an unusable limit as malformed', async () => {
    const notJson = transport(
      () =>
        new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const wrongShape = transport(() => catalogResponse({ deepseek: { models: 'not-an-object' } }));
    const zeroOutput = transport(() =>
      catalogResponse({
        deepseek: {
          api: 'https://api.deepseek.com',
          models: { 'deepseek-flash': { limit: { context: 4_096, output: 0 } } },
        },
      }),
    );

    const notJsonOutcome = await createModelsDevCatalog(CONFIG, { fetch: notJson.send }).limits();
    const wrongShapeOutcome = await createModelsDevCatalog(CONFIG, {
      fetch: wrongShape.send,
    }).limits();
    const zeroOutputOutcome = await createModelsDevCatalog(CONFIG, {
      fetch: zeroOutput.send,
    }).limits();

    for (const outcome of [notJsonOutcome, wrongShapeOutcome, zeroOutputOutcome]) {
      const failure = failureOf(outcome);
      expect(failure.reason).toBe('malformed');
      expect(failure.message).toContain(CATALOG_URL);
    }
    expect(failureOf(notJsonOutcome).message).toContain('JSON');
  });

  it('reports an HTTP failure as unreachable before any catalogue was read', async () => {
    const { send } = transport(() => new Response('service unavailable', { status: 503 }));

    const outcome = await createModelsDevCatalog(CONFIG, { fetch: send }).limits();

    const failure = failureOf(outcome);
    expect(failure.reason).toBe('unreachable');
    expect(failure.message).toContain(CATALOG_URL);
    expect(failure.message).toContain('503');
  });

  it('revalidates with the stored etag and keeps the cached limits on 304', async () => {
    const { send, captured } = transport((_request, index) =>
      index === 0 ? catalogResponse(CATALOG) : new Response(null, { status: 304 }),
    );
    const catalog = createModelsDevCatalog(CONFIG, { fetch: send, ttlMs: 0 });

    const first = await catalog.limits();
    const second = await catalog.limits();

    expect(limitsOf(second)).toEqual(limitsOf(first));
    expect(captured).toHaveLength(2);
    expect(captured[1]?.headers['if-none-match']).toBe(ETAG);
  });

  it('does not request the catalogue again within the TTL', async () => {
    const { send, captured } = transport(() => catalogResponse(CATALOG));
    const catalog = createModelsDevCatalog(CONFIG, { fetch: send, ttlMs: 60_000 });

    const first = await catalog.limits();
    const second = await catalog.limits();

    expect(limitsOf(second)).toEqual(limitsOf(first));
    expect(captured).toHaveLength(1);
  });

  it('shares one request between concurrent calls', async () => {
    const gate = deferred();
    const { send, captured } = transport(() => gate.promise);
    const catalog = createModelsDevCatalog(CONFIG, { fetch: send });

    const first = catalog.limits();
    const second = catalog.limits();
    expect(captured).toHaveLength(1);

    gate.resolve(catalogResponse(CATALOG));

    expect(limitsOf(await first)).toEqual(limitsOf(await second));
    expect(captured).toHaveLength(1);
  });

  it('keeps the last good limits when a later refresh fails', async () => {
    const { send, captured } = transport((_request, index) => {
      if (index === 0) {
        return catalogResponse(CATALOG);
      }
      throw new Error('the catalogue endpoint reset the connection');
    });
    const catalog = createModelsDevCatalog(CONFIG, { fetch: send, ttlMs: 0 });

    const first = await catalog.limits();
    const second = await catalog.limits();

    expect(limitsOf(second)).toEqual(limitsOf(first));
    expect(captured).toHaveLength(2);
  });

  it('does not cache a failed first read', async () => {
    const { send, captured } = transport((_request, index) => {
      if (index === 0) {
        throw new Error('connection refused');
      }
      return catalogResponse(CATALOG);
    });
    const catalog = createModelsDevCatalog(CONFIG, { fetch: send });

    expect(failureOf(await catalog.limits()).reason).toBe('unreachable');
    expect(limitsOf(await catalog.limits())).toMatchObject({ providerId: 'deepseek' });
    expect(captured).toHaveLength(2);
  });
});

describe('the catalogue part of the model configuration', () => {
  const env = {
    AFTERCARE_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
    AFTERCARE_MODEL_API_KEY: SECRET,
    AFTERCARE_MODEL_NAME: 'deepseek-flash',
  };

  it('defaults to the public catalogue and to the configured model name', () => {
    expect(readModelConfig(env).catalog).toEqual({
      url: 'https://models.dev/api.json',
      providerId: null,
      modelId: 'deepseek-flash',
    });
  });

  it('takes an explicit catalogue URL, provider and model id', () => {
    expect(
      readModelConfig({
        ...env,
        AFTERCARE_MODELS_DEV_URL: 'https://mirror.example.test/api.json',
        AFTERCARE_MODEL_CATALOG_PROVIDER: 'openrouter',
        AFTERCARE_MODEL_CATALOG_MODEL: 'deepseek/deepseek-flash',
      }).catalog,
    ).toEqual({
      url: 'https://mirror.example.test/api.json',
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-flash',
    });
  });
});
