'use client';

import type { ActionResult, Refusal } from '@aftercare/console/client';

// The browser side of the console API. The session lives in an HttpOnly
// cookie the page cannot read; state-changing requests carry the
// anti-forgery token the session endpoint handed out.

export const CSRF_HEADER = 'x-aftercare-csrf';

const refusal = (code: string, message: string): Refusal => ({
  code,
  message,
  recovery: 'none',
  detail: {},
});

const UNREACHABLE = refusal(
  'network_error',
  '请求未收到响应，操作状态未知。重试将沿用同一请求键，不会重复执行。',
);

export function toSignIn(): void {
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

export async function refusalOf(response: Response): Promise<Refusal> {
  const body: { refusal?: Refusal } = await response.json().catch(() => ({}));
  return body.refusal ?? refusal(`http_${response.status}`, `请求失败（HTTP ${response.status}）`);
}

/** SWR fetcher. Throws an Error whose cause is the refusal. */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (response.ok) {
    return (await response.json()) as T;
  }
  const refused = await refusalOf(response);
  if (response.status === 401) {
    toSignIn();
  }
  throw new Error(refused.message, { cause: { ...refused, status: response.status } });
}

/** The refusal behind an error thrown by getJson, if it is one. */
export function refusalOfError(error: Error | undefined): (Refusal & { status: number }) | null {
  const cause = error?.cause;
  return typeof cause === 'object' && cause !== null && 'code' in cause && 'status' in cause
    ? (cause as Refusal & { status: number })
    : null;
}

export async function sendJson<T>(
  path: string,
  body: object,
  csrfToken: string | null,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<ActionResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken }),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, refusal: UNREACHABLE };
    }
    throw error;
  }
  const parsed: Partial<ActionResult<T>> = await response.json().catch(() => ({}));
  if (parsed.ok === true && 'value' in parsed) {
    return parsed as ActionResult<T>;
  }
  if (parsed.ok === false && parsed.refusal !== undefined) {
    if (response.status === 401 && parsed.refusal.recovery === 'sign_in') {
      toSignIn();
    }
    return { ok: false, refusal: parsed.refusal };
  }
  return response.ok
    ? ({ ok: true, value: parsed as T, replayed: false } satisfies ActionResult<T>)
    : {
        ok: false,
        refusal: refusal(`http_${response.status}`, `请求失败（HTTP ${response.status}）`),
      };
}

/** Downloads one artefact: an audited grant, then the bytes. */
export async function downloadFile(
  path: string,
  body: object,
  csrfToken: string,
): Promise<{ ok: true; notice: string | null } | { ok: false; refusal: Refusal }> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { ok: false, refusal: await refusalOf(response) };
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name ?? 'aftercare-artefact';
  link.click();
  URL.revokeObjectURL(url);
  return { ok: true, notice: response.headers.get('x-aftercare-notice') };
}
