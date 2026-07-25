import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig, setConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';

export const FIXED_NOW = '2026-07-25T17:00:00.000Z';
export const CANONICAL_TEXT =
  '40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500';

/** Fresh app: fixture mode, ephemeral store, no snapshot file. */
export async function buildTestApp(): Promise<FastifyInstance> {
  setConfig(loadConfig({ ...process.env, DEMO_MODE: 'fixture' }));
  return buildServer({ store: new MemoryStore(null) });
}

export async function api<T = unknown>(
  app: FastifyInstance,
  opts: InjectOptions & { token?: string },
): Promise<{ status: number; body: T; text: string }> {
  const { token, ...rest } = opts;
  const res = await app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const type = String(res.headers['content-type'] ?? '');
  const body = type.includes('json') ? (res.json() as T) : (res.body as unknown as T);
  return { status: res.statusCode, body, text: res.body };
}

export async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await api<{ token: string }>(app, {
    method: 'POST',
    url: '/api/auth/login',
    payload: { email },
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.token;
}

/** Create the canonical request as Dana and run it to AWAITING_APPROVAL. */
export async function runCanonicalRequest(
  app: FastifyInstance,
  danaToken: string,
): Promise<{ requestId: string; runId: string }> {
  const created = await api<{ id: string }>(app, {
    method: 'POST',
    url: '/api/requests',
    token: danaToken,
    payload: { raw_text: CANONICAL_TEXT },
  });
  const requestId = created.body.id;
  const started = await api<{ run_id: string }>(app, {
    method: 'POST',
    url: `/api/requests/${requestId}/run`,
    token: danaToken,
    payload: { now: FIXED_NOW },
  });
  await app.ctx.orchestrator.waitForRun(started.body.run_id);
  return { requestId, runId: started.body.run_id };
}
