import { z } from 'zod';
import type { ModelConfig } from './config.ts';

// The context window and the highest output of the model come from models.dev,
// the public model catalogue: a chat-completions service reports neither, so
// the Runtime cannot size a request without them. Guessing them would either
// cut an answer short or overflow the context. This file is the only place that
// knows a field of the catalogue document; everything outside sees ModelLimits.
//
// Outbound traffic: one anonymous GET of the public catalogue, revalidated with
// an ETag. It carries no prompt, no tool result, no case data and no
// credential.

export interface ModelLimits {
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly providerId: string;
  readonly modelId: string;
}

export type ModelLimitsOutcome =
  | { readonly ok: true; readonly limits: ModelLimits }
  | {
      readonly ok: false;
      readonly reason: 'unreachable' | 'not_found' | 'ambiguous' | 'malformed';
      readonly message: string;
    };

export interface ModelCatalog {
  readonly limits: () => Promise<ModelLimitsOutcome>;
}

export interface ModelsDevCatalogOptions {
  readonly fetch?: typeof fetch;
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 3_600_000;

/**
 * The shape of one catalogue entry, kept loose on purpose: the document also
 * carries embedding and image models whose output limit is 0, and one of those
 * must not invalidate the whole catalogue. Positivity is enforced on the
 * selected entry alone (strictLimitSchema below).
 */
const limitShapeSchema = z.object({
  context: z.number(),
  output: z.number(),
});

const modelEntrySchema = z.object({
  limit: limitShapeSchema.optional(),
});

const providerEntrySchema = z.object({
  /** The base URL of the provider: it pairs the catalogue with AFTERCARE_MODEL_BASE_URL. */
  api: z.string().min(1).max(2_000).optional(),
  models: z.record(z.string(), modelEntrySchema),
});

const catalogDocumentSchema = z.record(z.string(), providerEntrySchema);

/** What the Runtime needs of the selected entry: a context and an output that can be used. */
const strictLimitSchema = z.object({
  context: z.number().int().positive(),
  output: z.number().int().positive(),
});

type CatalogDocument = z.output<typeof catalogDocumentSchema>;
type CatalogLimit = z.output<typeof limitShapeSchema>;

interface CachedCatalog {
  readonly limits: ModelLimits;
  readonly etag: string | null;
  readonly fetchedAt: number;
}

type CatalogRead =
  | { readonly ok: true; readonly value: CatalogDocument }
  | { readonly ok: false; readonly message: string };

type FailureReason = 'unreachable' | 'not_found' | 'ambiguous' | 'malformed';

function failure(reason: FailureReason, message: string): ModelLimitsOutcome {
  return { ok: false, reason, message };
}

function briefError(error: z.ZodError): string {
  const text = z.prettifyError(error);
  return text.length > 800 ? `${text.slice(0, 800)}...` : text;
}

/** The host of a URL, or null when the value is not one: only a host identifies a deployment. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function readCatalog(body: string): CatalogRead {
  let parsed: z.ZodSafeParseResult<CatalogDocument>;
  try {
    parsed = catalogDocumentSchema.safeParse(JSON.parse(body));
  } catch (error) {
    return {
      ok: false,
      message: `the body is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!parsed.success) {
    return {
      ok: false,
      message: `the catalogue has an unexpected shape (${briefError(parsed.error)})`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** The selected entry is the only one whose limits are required to be usable numbers. */
function strictLimits(
  url: string,
  providerId: string,
  modelId: string,
  limit: CatalogLimit | undefined,
): ModelLimitsOutcome {
  const parsed = strictLimitSchema.safeParse(limit);
  if (!parsed.success) {
    return failure(
      'malformed',
      `${url} has no positive limit.context and limit.output for model "${modelId}" of provider "${providerId}"`,
    );
  }
  return {
    ok: true,
    limits: {
      contextTokens: parsed.data.context,
      outputTokens: parsed.data.output,
      providerId,
      modelId,
    },
  };
}

/**
 * Picks the catalogue entry of the configured model: an explicit provider wins,
 * otherwise the provider whose api host is the host of the model base URL,
 * otherwise the one provider that lists the model at all.
 */
function selectLimits(document: CatalogDocument, config: ModelConfig): ModelLimitsOutcome {
  const url = config.catalog.url;
  const modelId = config.catalog.modelId;
  const explicitProviderId = config.catalog.providerId;

  if (explicitProviderId !== null) {
    const provider = document[explicitProviderId];
    if (provider === undefined) {
      return failure('not_found', `${url} has no provider "${explicitProviderId}"`);
    }
    const entry = provider.models[modelId];
    if (entry === undefined) {
      return failure(
        'not_found',
        `${url} has no model "${modelId}" in provider "${explicitProviderId}"`,
      );
    }
    return strictLimits(url, explicitProviderId, modelId, entry.limit);
  }

  const baseHost = hostOf(config.baseUrl);
  if (baseHost !== null) {
    for (const [providerId, provider] of Object.entries(document)) {
      if (provider.api === undefined || hostOf(provider.api) !== baseHost) {
        continue;
      }
      const entry = provider.models[modelId];
      if (entry !== undefined) {
        return strictLimits(url, providerId, modelId, entry.limit);
      }
    }
  }

  let unique: { readonly providerId: string; readonly limit: CatalogLimit | undefined } | null =
    null;
  const providerIds: string[] = [];
  for (const [providerId, provider] of Object.entries(document)) {
    const entry = provider.models[modelId];
    if (entry === undefined) {
      continue;
    }
    providerIds.push(providerId);
    if (unique === null) {
      unique = { providerId, limit: entry.limit };
    }
  }
  if (unique === null) {
    return failure('not_found', `${url} has no model "${modelId}"`);
  }
  if (providerIds.length > 1) {
    return failure(
      'ambiguous',
      `${url} lists model "${modelId}" under ${providerIds.length} providers (${providerIds.sort().join(', ')}); set AFTERCARE_MODEL_CATALOG_PROVIDER to choose one`,
    );
  }
  return strictLimits(url, unique.providerId, modelId, unique.limit);
}

export function createModelsDevCatalog(
  config: ModelConfig,
  options: ModelsDevCatalogOptions = {},
): ModelCatalog {
  const request = options.fetch ?? globalThis.fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const url = config.catalog.url;
  let cached: CachedCatalog | null = null;
  let inFlight: Promise<ModelLimitsOutcome> | null = null;

  async function refresh(): Promise<ModelLimitsOutcome> {
    const headers = new Headers({ accept: 'application/json' });
    if (cached !== null && cached.etag !== null) {
      headers.set('if-none-match', cached.etag);
    }
    let response: Response;
    try {
      response = await request(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      return failure(
        'unreachable',
        `the catalogue request to ${url} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    // The catalogue is unchanged: the copy of the last successful read stays valid.
    if (response.status === 304) {
      if (cached === null) {
        return failure('malformed', `${url} answered 304 Not Modified although nothing was cached`);
      }
      cached = { ...cached, fetchedAt: Date.now() };
      return { ok: true, limits: cached.limits };
    }
    if (!response.ok) {
      return failure('unreachable', `${url} answered HTTP ${response.status}`);
    }

    const etag = response.headers.get('etag');
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      return failure(
        'unreachable',
        `the body of ${url} could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const document = readCatalog(body);
    if (!document.ok) {
      return failure('malformed', `${url}: ${document.message}`);
    }
    const selected = selectLimits(document.value, config);
    if (!selected.ok) {
      return selected;
    }
    cached = { limits: selected.limits, etag, fetchedAt: Date.now() };
    return selected;
  }

  return {
    limits: () => {
      if (cached !== null && Date.now() - cached.fetchedAt < ttlMs) {
        return Promise.resolve<ModelLimitsOutcome>({ ok: true, limits: cached.limits });
      }
      if (inFlight !== null) {
        return inFlight;
      }
      // One request at a time: a slow catalogue must not be fetched once per caller.
      const pending: Promise<ModelLimitsOutcome> = refresh().then((outcome) => {
        inFlight = null;
        if (outcome.ok || cached === null) {
          return outcome;
        }
        // The refresh failed but an older read is still usable: limits change rarely.
        return { ok: true, limits: cached.limits } satisfies ModelLimitsOutcome;
      });
      inFlight = pending;
      return pending;
    },
  };
}
