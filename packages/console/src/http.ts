import { createHash } from 'node:crypto';
import type { OperatorSession } from '@aftercare/contracts';
import type { JsonObject, JsonValue } from '@aftercare/domain';
import { z } from 'zod';
import { type ConsoleActions, createActions, refuse } from './actions.ts';
import { adminView, readiness } from './admin.ts';
import {
  assistantModelOf,
  assistantTurnRequestSchema,
  deleteAssistantConversation,
  listAssistantConversations,
  readAssistantConversation,
  startAssistantTurn,
} from './assistant/index.ts';
import { charterSummaryJson } from './autonomy/charter.ts';
import { SIGNATURE_HEADER, signatureMatches } from './autonomy/signature.ts';
import { startAutonomousRun } from './autonomy/start.ts';
import { type ConsoleContext, identityOf } from './context.ts';
import {
  createIdentityService,
  csrfTokenMatches,
  csrfTokenOf,
  type IdentityService,
} from './identity.ts';
import {
  caseView,
  environmentView,
  evidenceDetail,
  FEED_START,
  listEvidence,
  readFeed,
} from './reads.ts';
import { planRetention } from './retention.ts';
import { RETENTION_SETTING_KINDS } from './settings.ts';
import { verificationDocument, verifyRecords } from './verification.ts';
import type {
  ActionResult,
  AssistantStreamEvent,
  FeedCursor,
  Refusal,
  SessionView,
} from './view-model.ts';

// The HTTP surface of the console: one function from a Request to a Response.
// The Next.js application mounts it under /api; tests call it directly.
//
// Every request but sign-in and the health probes needs a session. Who acts
// is the principal of that session and nothing else: no header, query or body
// field names an actor, and a request from localhost is treated like any
// other. State-changing requests additionally need the Origin of this
// console and the anti-forgery token of the session. What the principal may
// do is decided by the entries the request ends in, not here.

export const CSRF_HEADER = 'x-aftercare-csrf';
const MAX_BODY_BYTES = 262_144;
const STREAM_MAX_MS = 10 * 60_000;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_REAUTHENTICATE_MS = 15_000;
const STREAM_LIMIT = 64;

const uuid = z.uuid();
const bodySchema = z.record(z.string(), z.json());
const intakeSchema = z.strictObject({
  dedupeKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/),
  description: z.string().trim().min(1).max(4000),
  source: z
    .string()
    .regex(/^[a-z][a-z0-9_.:-]{0,62}$/)
    .default('webhook'),
});
/** How long a first intake request is given to open its case before a repeat takes over. */
const INTAKE_TAKEOVER_MS = 60_000;
const cursorSchema = z.strictObject({
  caseRevision: z.string().regex(/^\d{1,19}$/),
  agentRunId: z.uuid().nullable(),
  agentSeq: z.string().regex(/^\d{1,19}$/),
});

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_authorized: 403,
  forbidden_origin: 403,
  csrf_rejected: 403,
  reference_rejected: 404,
  not_found: 404,
  too_many_streams: 429,
  database_unavailable: 503,
  model_limits_unavailable: 503,
  internal_error: 500,
};
const statusOf = (code: string): number => STATUS_BY_CODE[code] ?? 409;

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function json(status: number, body: JsonValue, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const refusal = (value: Refusal): Response =>
  json(statusOf(value.code), { ok: false, refusal: { ...value } });
const refused = (code: string, message: string, recovery: Refusal['recovery'] = 'none') =>
  refusal({ ...refuse(code, message), recovery });
const result = <T extends JsonValue>(outcome: ActionResult<T>): Response =>
  outcome.ok
    ? json(200, { ok: true, value: outcome.value, replayed: outcome.replayed })
    : refusal(outcome.refusal);

/**
 * A stored document as a JSON response. The assistant store returns documents
 * it parsed with the contract schemas; they are JSON already, so they are
 * serialized as they are instead of being described again in this file.
 */
function jsonDocument(status: number, document: object): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

export const encodeCursor = (cursor: FeedCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

function decodeCursor(text: string | null): FeedCursor | null {
  if (text === null || text === '') {
    return FEED_START;
  }
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

const DATABASE_DOWN = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  '53300',
]);

function databaseUnavailable(error: Error): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 6; depth += 1) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : null;
    if (
      (code !== null && DATABASE_DOWN.has(code)) ||
      /Connection terminated|timeout exceeded when trying to connect/.test(current.message)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export interface HttpApi {
  readonly handle: (request: Request) => Promise<Response>;
  /** Number of event streams this process has open. */
  readonly openStreams: () => number;
}

interface Authenticated {
  readonly token: string;
  readonly session: OperatorSession;
}

export function createHttpApi(
  context: ConsoleContext,
  env: NodeJS.ProcessEnv,
  options: { readonly takeoverSeconds?: number; readonly streamPollMs?: number } = {},
): HttpApi {
  const { settings, logger, metrics } = context;
  const identity: IdentityService = createIdentityService(
    context.environment.operations,
    settings.sessionTtlSeconds,
  );
  const cookieName = settings.secureCookies ? '__Host-aftercare_session' : 'aftercare_session';
  const pollMs = options.streamPollMs ?? 1_000;
  // The model of this deployment is chosen once; null means the assistant cannot answer.
  const assistantModel = assistantModelOf(context, env);
  let streams = 0;

  const cookie = (token: string, maxAge: number): string =>
    [
      `${cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(settings.secureCookies ? ['Secure'] : []),
    ].join('; ');

  function tokenOf(request: Request): string | null {
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === cookieName && value.length > 0) {
        return value.join('=');
      }
    }
    return null;
  }

  async function authenticate(request: Request): Promise<Authenticated | null> {
    const token = tokenOf(request);
    if (token === null || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
      return null;
    }
    const session = await identity.authenticate(token);
    return session === null ? null : { token, session };
  }

  const sameOrigin = (request: Request): boolean =>
    request.headers.get('origin') === settings.origin;

  async function readBody(request: Request): Promise<JsonObject | null> {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return null;
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return null;
    }
    try {
      const parsed = bodySchema.safeParse(JSON.parse(text === '' ? '{}' : text));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  /** The console actions of one session. The takeover option is the one the case routes of this process use. */
  const actionsOf = (session: OperatorSession): ConsoleActions =>
    createActions(context, session, {
      ...(options.takeoverSeconds === undefined
        ? {}
        : { takeoverSeconds: options.takeoverSeconds }),
    });

  const sessionView = ({ token, session }: Authenticated): SessionView => ({
    session: {
      principal: session.principal,
      displayName: session.displayName,
      capabilities: session.capabilities,
      expiresAt: session.expiresAt,
    },
    csrfToken: csrfTokenOf(token),
    displayName: settings.displayName,
    modelMode: settings.modelMode,
  });

  function eventStream(
    request: Request,
    caseId: string,
    token: string,
    start: FeedCursor,
  ): Response {
    const encoder = new TextEncoder();
    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    const release = () => {
      if (closed) return false;
      closed = true;
      clearTimeout(timer);
      streams -= 1;
      metrics.gauge('console.event_streams.open', -1);
      return true;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams += 1;
        metrics.gauge('console.event_streams.open', 1);
        metrics.count('console.event_streams.opened');
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const close = () => {
          if (release()) controller.close();
        };
        request.signal.addEventListener('abort', close, { once: true });
        const opened = Date.now();
        let cursor = start;
        let lastSent = opened;
        let lastAuthenticated = opened;
        send('retry: 2000\n\n');
        const tick = async (): Promise<void> => {
          if (closed) return;
          let delivered = 0;
          try {
            const now = Date.now();
            if (now - lastAuthenticated >= STREAM_REAUTHENTICATE_MS) {
              // A session that ended (signed out, expired, account disabled) ends its streams.
              if ((await identity.authenticate(token)) === null) {
                send('event: unauthorized\ndata: {}\n\n');
                close();
                return;
              }
              lastAuthenticated = now;
            }
            const page = await readFeed(context, caseId, cursor);
            if (page === null) {
              send('event: failure\ndata: {"code":"not_found"}\n\n');
              close();
              return;
            }
            if (page.kind === 'resync') {
              // The cursor cannot be continued (events removed, another run): the client reloads the state.
              metrics.count('console.event_streams.resync');
              cursor = page.cursor;
              send(
                `event: resync\nid: ${encodeCursor(cursor)}\ndata: ${JSON.stringify({ reason: page.reason })}\n\n`,
              );
              lastSent = now;
            } else {
              for (const item of page.items) {
                cursor =
                  item.origin === 'agent'
                    ? { ...cursor, agentRunId: item.agentRunId, agentSeq: item.seq }
                    : { ...cursor, caseRevision: item.seq };
                send(`event: item\nid: ${encodeCursor(cursor)}\ndata: ${JSON.stringify(item)}\n\n`);
                delivered += 1;
              }
              cursor = page.cursor;
              if (delivered > 0) lastSent = now;
            }
            if (now - lastSent >= STREAM_HEARTBEAT_MS) {
              send(': keep-alive\n\n');
              lastSent = now;
            }
            if (now - opened >= STREAM_MAX_MS) {
              // Bounded lifetime: the client reconnects with the id of the last event it saw.
              close();
              return;
            }
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            logger.error('console.event_stream_failed', { caseId }, failure);
            metrics.count('console.event_streams.failed');
            send(
              `event: failure\ndata: ${JSON.stringify({ code: databaseUnavailable(failure) ? 'database_unavailable' : 'stream_failed' })}\n\n`,
            );
            close();
            return;
          }
          timer = setTimeout(() => void tick(), delivered > 0 ? Math.min(pollMs, 250) : pollMs);
        };
        void tick();
      },
      cancel() {
        release();
      },
    });
    return new Response(stream, {
      headers: {
        ...BASE_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  async function caseAction(
    actions: ConsoleActions,
    caseId: string,
    action: string,
    body: JsonObject,
  ): Promise<Response> {
    switch (action) {
      case 'runs':
        return result(await actions.startRun(caseId, body));
      case 'answer':
        return result(await actions.answer(caseId, body));
      case 'approve':
        return result(await actions.approve(caseId, body));
      case 'decline-approval':
        return result(await actions.declineApproval(caseId, body));
      case 'revoke-approval':
        return result(await actions.revokeApproval(caseId, body));
      case 'revoke-confirmation':
        return result(await actions.revokeConfirmation(caseId, body));
      case 'control':
        return result(await actions.control(caseId, body));
      case 'budget':
        return result(await actions.amendBudget(caseId, body));
      case 'artefacts':
        return result(await actions.produceArtefact(caseId, body));
      case 'revoke-artefact':
        return result(await actions.revokeArtefact(caseId, body));
      case 'undo':
        return result(await actions.prepareUndo(caseId, body));
      default:
        return refused('not_found', 'no such action');
    }
  }

  async function admin(
    auth: Authenticated,
    method: string,
    action: string | undefined,
    request: Request,
  ) {
    const { operations } = context.environment;
    // The administration entry is for holders of administer_local; the entries behind it check again.
    if (!(await operations.hasCapability(auth.session.principal, 'administer_local'))) {
      return refused(
        'not_authorized',
        'the local administration entry needs the administer_local capability',
      );
    }
    if (method === 'GET' && action === undefined) {
      return json(200, (await adminView(context, auth.session)) as unknown as JsonValue);
    }
    if (method !== 'POST') {
      return refused('not_found', 'no such administration request');
    }
    const body = await readBody(request);
    if (body === null) {
      return refused('invalid_request', 'the request body is not a JSON object');
    }
    switch (action) {
      case 'autonomy':
        return result(await createActions(context, auth.session).setAutonomy(body));
      case 'verify':
        return json(200, {
          ok: true,
          value: verificationDocument(await verifyRecords(context, env)),
          replayed: false,
        });
      case 'retention': {
        const parsed = z
          .strictObject({
            apply: z.boolean().default(false),
            kinds: z.array(z.enum(RETENTION_SETTING_KINDS)).min(1).optional(),
          })
          .safeParse(body);
        if (!parsed.success) return refused('invalid_request', z.prettifyError(parsed.error));
        const done = await planRetention(context, identityOf(auth.session), {
          apply: parsed.data.apply,
          ...(parsed.data.kinds === undefined ? {} : { kinds: parsed.data.kinds }),
        });
        return done.ok
          ? json(200, { ok: true, value: done.value as unknown as JsonValue, replayed: false })
          : refused(done.rejection.code, done.rejection.message);
      }
      case 'release-hold': {
        // The hold is lifted only on a verification made now, by this request.
        const verification = await verifyRecords(context, env);
        if (!verification.ok) {
          return refusal({
            ...refuse(
              'verification_failed',
              'the stored records do not match their digests; the hold stays',
            ),
            detail: verificationDocument(verification),
          });
        }
        const released = await operations.releaseRestoreHold(
          identityOf(auth.session),
          verificationDocument(verification),
        );
        return released.ok
          ? json(200, { ok: true, value: released.value as unknown as JsonValue, replayed: false })
          : refused(released.rejection.code, released.rejection.message);
      }
      default:
        return refused('not_found', 'no such administration request');
    }
  }

  /**
   * The stored conversations of the console assistant. A conversation belongs
   * to the principal of the session and to nobody else: another principal's
   * conversation is answered like one that does not exist.
   */
  async function assistantRoutes(
    auth: Authenticated,
    method: string,
    conversationId: string | undefined,
    third: string | undefined,
    request: Request,
  ): Promise<Response> {
    if (conversationId === undefined) {
      return method === 'GET'
        ? jsonDocument(200, await listAssistantConversations(context, auth.session))
        : refused('not_found', 'no such request');
    }
    if (!uuid.safeParse(conversationId).success) {
      return refused('not_found', 'no such conversation');
    }
    if (third !== undefined) {
      return third === 'turns' && method === 'POST'
        ? assistantTurn(auth, conversationId, request)
        : refused('not_found', 'no such request');
    }
    if (method === 'GET') {
      const conversation = await readAssistantConversation(context, auth.session, conversationId);
      return conversation === null
        ? refused('not_found', 'no such conversation')
        : jsonDocument(200, conversation);
    }
    if (method === 'DELETE') {
      const removed = await deleteAssistantConversation(context, auth.session, conversationId);
      return removed.ok
        ? json(200, {
            ok: true,
            value: { conversationId: removed.value.conversationId },
            replayed: false,
          })
        : refusal({ ...refuse(removed.rejection.code, removed.rejection.message) });
    }
    return refused('not_found', 'no such request');
  }

  /**
   * One turn of a stored conversation. Everything decided before the stream is
   * a normal refusal; after it, every event is one NDJSON line and the last
   * line is always `done`. The browser stopping the stream aborts the turn, so
   * no further model request is made. The turn releases its conversation in
   * the finally of the stream it hands out, whatever its outcome.
   */
  async function assistantTurn(
    auth: Authenticated,
    conversationId: string,
    request: Request,
  ): Promise<Response> {
    // Narrowed once: the stream continues after this function returned.
    const model = assistantModel;
    if (model === null) {
      return refused(
        'model_unavailable',
        'no model is configured for this deployment; the assistant cannot answer',
      );
    }
    const body = await readBody(request);
    if (body === null) {
      return refused('invalid_request', 'the request body is not a JSON object');
    }
    const parsed = assistantTurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      return refused('invalid_request', z.prettifyError(parsed.error));
    }
    if (settings.modelMode === 'live' && !parsed.data.acknowledgeDataEgress) {
      return refused(
        'egress_not_acknowledged',
        'case content will be sent to the configured model service; this has to be acknowledged before the assistant sees it',
      );
    }
    // A turn sizes its context window and its output by the limits of the model
    // the catalog resolved. There is no built-in fallback: a turn whose limits
    // are unknown is refused before its stream starts, not run on made-up ones.
    const limits = await model.catalog.limits();
    if (!limits.ok) {
      logger.warn('console.assistant_limits_unavailable', {
        principal: auth.session.principal,
        conversationId,
        reason: limits.reason,
        message: limits.message,
      });
      metrics.count('console.assistant.limits_unavailable');
      return refused('model_limits_unavailable', limits.message);
    }
    const abort = new AbortController();
    if (request.signal.aborted) {
      abort.abort();
    } else {
      request.signal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    const started = await startAssistantTurn({
      context,
      env,
      model: model.adapter,
      limits: limits.limits,
      session: auth.session,
      actions: actionsOf(auth.session),
      conversationId,
      content: parsed.data.content,
      acknowledgeDataEgress: parsed.data.acknowledgeDataEgress,
      signal: abort.signal,
    });
    if (!started.ok) {
      return refusal({ ...refuse(started.rejection.code, started.rejection.message) });
    }
    const { turnId, events } = started.value;
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: AssistantStreamEvent) => {
          if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          for await (const event of events) send(event);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          // What failed is in the server log; the stream says only that it did.
          logger.error(
            'console.assistant_failed',
            { principal: auth.session.principal, conversationId, turnId },
            failure,
          );
          metrics.count('console.assistant.failed');
          send({
            type: 'refusal',
            refusal: refuse('internal_error', 'the assistant failed; see the server log'),
          });
          send({ type: 'done' });
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        ...BASE_HEADERS,
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  /**
   * A signed request from an alerting system to open a case under the
   * charter. It has no session: the HMAC over the raw body with the intake
   * secret is its authentication, and the sender's dedupe key makes a repeat
   * find the case the first one opened.
   */
  async function intake(request: Request): Promise<Response> {
    const secret = context.settings.autonomy.intakeSecret;
    if (secret === null) {
      return refused('not_found', 'no such resource');
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return refused('invalid_request', 'the request body is too large');
    }
    if (!signatureMatches(secret, raw, request.headers.get(SIGNATURE_HEADER))) {
      metrics.count('console.intake.unsigned');
      logger.warn('console.intake_refused', { reason: 'signature' });
      return refused('unauthenticated', 'the intake request is not signed with the intake secret');
    }
    let document: JsonValue;
    try {
      document = z.json().parse(JSON.parse(raw));
    } catch (error) {
      return refused(
        'invalid_request',
        `the body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = intakeSchema.safeParse(document);
    if (!parsed.success) {
      return refused('invalid_request', z.prettifyError(parsed.error));
    }
    const { dedupeKey, description, source } = parsed.data;
    const admitted = await context.autonomy.admitIntake({
      dedupeKey,
      source,
      description,
      payloadDigest: createHash('sha256').update(raw).digest('hex'),
    });
    if (!admitted.ok) {
      return refused(admitted.rejection.code, admitted.rejection.message);
    }
    const { outcome, intake: record } = admitted.value;
    if (outcome === 'key_reused') {
      return refused('request_key_reused', 'this dedupe key was used for another request');
    }
    const [enrolled] = await context.autonomy.enrollmentsOfIntake(record.intakeId);
    if (enrolled !== undefined) {
      return json(202, {
        ok: true,
        value: {
          outcome: 'duplicate',
          intakeId: record.intakeId,
          caseId: enrolled.caseId,
          agentRunId: enrolled.agentRunId,
        },
        replayed: true,
      });
    }
    if (
      outcome === 'duplicate' &&
      Date.now() - Date.parse(record.receivedAt) < INTAKE_TAKEOVER_MS
    ) {
      return refused(
        'request_in_progress',
        'the first request with this key is still opening its case',
      );
    }
    const started = await startAutonomousRun(context, {
      trigger: 'intake',
      requestedBy: `intake:${source}`,
      description,
      intakeId: record.intakeId,
    });
    if (!started.ok) {
      return refusal(started.refusal);
    }
    logger.info('console.intake_started', {
      intakeId: record.intakeId,
      caseId: started.value.caseId,
      source,
    });
    return json(202, {
      ok: true,
      value: {
        outcome: 'started',
        intakeId: record.intakeId,
        caseId: started.value.caseId,
        agentRunId: started.value.agentRunId,
      },
      replayed: false,
    });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const { method } = request;
    if (segments[0] !== 'api') {
      return refused('not_found', 'not an API path');
    }
    const [, area, first, second, third, fourth] = segments;

    if (area === 'health' && method === 'GET') {
      if (first === 'live') {
        // Liveness: this process answers. It says nothing about the database or the model.
        return json(200, { status: 'live' });
      }
      if (first === 'ready') {
        const health = await readiness(context);
        return json(health.status === 'not_ready' ? 503 : 200, { ...health });
      }
    }

    if (area === 'intake' && first === undefined && method === 'POST') {
      return intake(request);
    }

    if (area === 'session' && first === undefined) {
      if (method === 'POST') {
        if (!sameOrigin(request))
          return refused('forbidden_origin', 'the request does not come from this console');
        const parsed = z
          .strictObject({
            principal: z.string().min(1).max(200),
            password: z.string().min(1).max(1000),
          })
          .safeParse(await readBody(request));
        if (!parsed.success)
          return refused('invalid_request', 'a principal and a password are required');
        const signedIn = await identity.signIn(parsed.data.principal, parsed.data.password);
        if (signedIn === null) {
          metrics.count('console.sign_in.refused');
          logger.warn('console.sign_in_refused', { principal: parsed.data.principal });
          return refused('unauthenticated', 'the principal or the password is not right');
        }
        logger.info('console.signed_in', { principal: signedIn.session.principal });
        return json(200, sessionView(signedIn) as unknown as JsonValue, {
          'set-cookie': cookie(signedIn.token, settings.sessionTtlSeconds),
        });
      }
      const auth = await authenticate(request);
      if (auth === null)
        return refusal({ ...refuse('unauthenticated', 'no session'), recovery: 'sign_in' });
      if (method === 'GET') return json(200, sessionView(auth) as unknown as JsonValue);
      if (method === 'DELETE') {
        if (
          !sameOrigin(request) ||
          !csrfTokenMatches(auth.token, request.headers.get(CSRF_HEADER))
        ) {
          return refused('csrf_rejected', 'the request does not carry the token of this session');
        }
        await identity.signOut(auth.token);
        return json(200, { ok: true }, { 'set-cookie': cookie('', 0) });
      }
    }

    const auth = await authenticate(request);
    if (auth === null) {
      return refusal({ ...refuse('unauthenticated', 'sign in first'), recovery: 'sign_in' });
    }
    if (method !== 'GET') {
      if (!sameOrigin(request)) {
        metrics.count('console.refusals.forbidden_origin');
        return refused('forbidden_origin', 'the request does not come from this console');
      }
      if (!csrfTokenMatches(auth.token, request.headers.get(CSRF_HEADER))) {
        metrics.count('console.refusals.csrf_rejected');
        return refused('csrf_rejected', 'the request does not carry the token of this session');
      }
    }
    // An account that holds no capability for this environment sees nothing of it.
    if (auth.session.capabilities.length === 0) {
      return refused('not_authorized', 'this account holds no capability for this environment');
    }

    if (area === 'admin') {
      return admin(auth, method, first, request);
    }
    if (area === 'assistant' && first === 'conversations' && fourth === undefined) {
      return assistantRoutes(auth, method, second, third, request);
    }
    if (area === 'autonomy' && first === undefined && method === 'GET') {
      const [autonomySwitch, charters, sentinelState, recentFindings] = await Promise.all([
        context.autonomy.readSwitch(),
        context.autonomy.chartersInForce(),
        context.autonomy.readSentinelState(),
        context.autonomy.recentSentinelFindings(20),
      ]);
      return json(200, {
        switch: autonomySwitch,
        charters: charters.map(charterSummaryJson),
        sentinel: {
          state: sentinelState,
          recentFindings,
        },
      });
    }
    if (area === 'environment' && method === 'GET') {
      return json(200, (await environmentView(context, env)) as unknown as JsonValue);
    }
    if (area !== 'cases') {
      return refused('not_found', 'no such resource');
    }
    const actions = actionsOf(auth.session);
    if (first === undefined) {
      if (method === 'GET') {
        return json(
          200,
          (await context.environment.operations.listCases(200)) as unknown as JsonValue,
        );
      }
      if (method === 'POST') {
        const body = await readBody(request);
        return body === null
          ? refused('invalid_request', 'the request body is not a JSON object')
          : result(await actions.submitIncident(body));
      }
      return refused('not_found', 'no such request');
    }
    if (!uuid.safeParse(first).success) {
      return refused('not_found', 'no such case');
    }
    const caseId = first;
    if (method === 'GET') {
      if (second === undefined) {
        const view = await caseView(context, auth.session, caseId);
        return view === null
          ? refused('not_found', 'no such case')
          : json(200, view as unknown as JsonValue);
      }
      if (second === 'feed' || second === 'events') {
        const cursor = decodeCursor(
          request.headers.get('last-event-id') ?? url.searchParams.get('cursor'),
        );
        if (cursor === null)
          return refused('invalid_request', 'the cursor is not one this console issued');
        if (second === 'feed') {
          const page = await readFeed(context, caseId, cursor);
          return page === null
            ? refused('not_found', 'no such case')
            : json(200, { ...page, cursorId: encodeCursor(page.cursor) } as unknown as JsonValue);
        }
        if ((await context.environment.caseStore.readCaseState(caseId)) === null) {
          return refused('not_found', 'no such case');
        }
        if (streams >= STREAM_LIMIT) {
          return refused(
            'too_many_streams',
            'too many event streams are open; poll the feed instead',
          );
        }
        return eventStream(request, caseId, auth.token, cursor);
      }
      if (second === 'evidence') {
        if (third === undefined) {
          const filter = z
            .strictObject({
              object: z
                .string()
                .regex(/^(product|order)\/[a-z0-9][a-z0-9_-]{0,62}$/)
                .optional(),
              operationId: z.uuid().optional(),
              batchId: z.uuid().optional(),
            })
            .safeParse(Object.fromEntries(url.searchParams));
          if (!filter.success) return refused('invalid_request', z.prettifyError(filter.error));
          const { object, operationId, batchId } = filter.data;
          return json(
            200,
            (await listEvidence(context, caseId, {
              ...(object === undefined ? {} : { object }),
              ...(operationId === undefined ? {} : { operationId }),
              ...(batchId === undefined ? {} : { batchId }),
            })) as unknown as JsonValue,
          );
        }
        if (!uuid.safeParse(third).success) return refused('not_found', 'no such evidence');
        // Looked up by case AND id: an evidence record of another case does not exist here.
        const detail = await evidenceDetail(context, caseId, third);
        return detail === null
          ? refused('not_found', 'no such evidence in this case')
          : json(200, detail as unknown as JsonValue);
      }
      if (second === 'nodes' && third !== undefined && uuid.safeParse(third).success) {
        // What one conclusion or input rests on, and what rests on it. Looked up within the case only.
        const dependencies = await context.environment.caseStore.readDependencies(caseId, third);
        return dependencies === null
          ? refused('not_found', 'no such record in this case')
          : json(200, dependencies as unknown as JsonValue);
      }
      return refused('not_found', 'no such resource');
    }
    if (method !== 'POST' || second === undefined) {
      return refused('not_found', 'no such request');
    }
    const body = await readBody(request);
    if (body === null) {
      return refused('invalid_request', 'the request body is not a JSON object');
    }
    if (second === 'artefacts' && third !== undefined) {
      if (fourth !== 'download' || !uuid.safeParse(third).success)
        return refused('not_found', 'no such request');
      const obtained = await actions.obtainArtefact(caseId, third, body.historical === true);
      if (!obtained.ok) return refusal(obtained.refusal);
      const { grant, content } = obtained.value;
      return new Response(new Uint8Array(content), {
        headers: {
          ...BASE_HEADERS,
          'content-type': 'application/octet-stream',
          'content-length': content.length.toString(),
          'content-disposition': `attachment; filename="${grant.fileName}"`,
          'x-aftercare-content-digest': grant.contentDigest,
          'x-aftercare-currency': grant.currency,
          'x-aftercare-notice': grant.notice,
        },
      });
    }
    if (third !== undefined) {
      return refused('not_found', 'no such request');
    }
    return caseAction(actions, caseId, second, body);
  }

  return {
    openStreams: () => streams,
    handle: async (request) => {
      try {
        return await route(request);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const unavailable = databaseUnavailable(failure);
        metrics.count(
          unavailable ? 'console.errors.database_unavailable' : 'console.errors.internal',
        );
        logger.error(
          'console.request_failed',
          { method: request.method, path: new URL(request.url).pathname },
          failure,
        );
        // What failed is in the server log. The client learns the class of the failure, nothing of its content.
        return unavailable
          ? refused(
              'database_unavailable',
              'the database does not answer; nothing was changed by this request unless it says so after a reload',
            )
          : refused('internal_error', 'the request failed; see the server log');
      }
    },
  };
}
