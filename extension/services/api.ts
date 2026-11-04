/**
 * Backend API client. Used ONLY from extension pages and the background service
 * worker – content scripts never receive the token.
 */
import { loadConfig, saveConfig } from '@/services/config';
import type { ApiErrorBody, SseEvent } from '@/types/api';
import { readSse } from '@/utils/sse';

export class ApiError extends Error {
  code: string;
  status: number;
  hint?: string | null;
  details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
    this.details = body.details;
  }
}

export function describeError(e: unknown): { message: string; hint?: string | null; code?: string } {
  if (e instanceof ApiError) return { message: e.message, hint: e.hint, code: e.code };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

async function base(): Promise<{ url: string; token: string }> {
  const cfg = await loadConfig();
  return { url: cfg.backendUrl.replace(/\/$/, ''), token: cfg.token };
}

async function toApiError(resp: Response): Promise<ApiError> {
  let body: ApiErrorBody = { code: `HTTP_${resp.status}`, message: resp.statusText || 'Request failed' };
  try {
    const json = await resp.json();
    if (json?.error) body = json.error;
  } catch {
    /* not JSON */
  }
  if (resp.status === 401) body.hint ??= 'Open Settings → Connection and pair the extension with the backend.';
  return new ApiError(resp.status, body);
}

function networkError(url: string, e: unknown): ApiError {
  if (e instanceof DOMException && e.name === 'AbortError') throw e;
  return new ApiError(0, {
    code: 'BACKEND_UNREACHABLE',
    message: `Cannot reach the local backend at ${url}.`,
    hint: 'Start it with scripts\\start.ps1 (or check the backend URL in Settings → Connection).',
  });
}

export async function request<T>(path: string, init: RequestInit & { timeoutMs?: number; auth?: boolean } = {}): Promise<T> {
  const { url, token } = await base();
  const headers = new Headers(init.headers);
  if (init.auth !== false && token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const ctrl = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => ctrl.abort(), init.timeoutMs) : undefined;
  init.signal?.addEventListener('abort', () => ctrl.abort());
  let resp: Response;
  try {
    resp = await fetch(`${url}/api/v1${path}`, { ...init, headers, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted && init.timeoutMs && !init.signal?.aborted) {
      throw new ApiError(0, { code: 'TIMEOUT', message: `Request to ${path} timed out.`, hint: 'The backend may be busy loading a model.' });
    }
    throw networkError(url, e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!resp.ok) throw await toApiError(resp);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const api = {
  get: <T>(p: string, init?: RequestInit & { timeoutMs?: number }) => request<T>(p, { ...init, method: 'GET' }),
  post: <T>(p: string, body?: unknown, init?: RequestInit & { timeoutMs?: number }) =>
    request<T>(p, { ...init, method: 'POST', body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(p: string, body: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(p: string, body: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T = void>(p: string) => request<T>(p, { method: 'DELETE' }),
};

/** POST and iterate SSE events. Abort via ``signal`` (this cancels generation server-side). */
export async function* stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const { url, token } = await base();
  let resp: Response;
  try {
    resp = await fetch(`${url}/api/v1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw networkError(url, e);
  }
  if (!resp.ok) throw await toApiError(resp);
  if (!resp.body) throw new ApiError(0, { code: 'NO_STREAM', message: 'The response has no body to stream.' });
  for await (const ev of readSse(resp.body, signal)) {
    if (ev.event === 'error') throw new ApiError(502, ev.data as ApiErrorBody);
    yield ev;
  }
}

/** Ask the backend for the token (works only from the allow-listed extension origin). */
export async function pair(): Promise<string> {
  const data = await request<{ token: string }>('/auth/pair', { method: 'POST', auth: false, timeoutMs: 5000 });
  await saveConfig({ token: data.token });
  return data.token;
}

export async function health(timeoutMs = 3000): Promise<{ status: string; version: string; api_version: string }> {
  return request('/health', { auth: false, timeoutMs });
}
