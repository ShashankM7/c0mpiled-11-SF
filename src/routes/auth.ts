import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../types.js';
import type { AppCtx } from '../context.js';
import { getConfig } from '../config.js';
import { AppError } from '../errors.js';

/* ---- token helpers: base64url(payload).hmac — issued by our own login ---- */

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(userId: string): string {
  const payload = b64url(JSON.stringify({ user_id: userId }));
  return `${payload}.${sign(payload, getConfig().authSecret)}`;
}

export function verifyToken(token: string): string | null {
  const [payload, signature] = token.split('.');
  if (payload === undefined || signature === undefined) return null;
  const expected = sign(payload, getConfig().authSecret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      user_id?: string;
    };
    return typeof parsed.user_id === 'string' ? parsed.user_id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the session user. The role ALWAYS comes from the server-side user
 * record — never from anything the client sent. Accepts a Bearer header or a
 * ?token= query param (the latter for EventSource, which cannot set headers).
 */
export async function authenticate(ctx: AppCtx, req: FastifyRequest): Promise<User> {
  const header = req.headers.authorization;
  const query = req.query as Record<string, unknown>;
  const raw =
    header !== undefined && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : typeof query['token'] === 'string'
        ? (query['token'] as string)
        : null;
  if (raw === null) throw new AppError(401, 'UNAUTHORIZED', 'missing bearer token');
  const userId = verifyToken(raw);
  if (userId === null) throw new AppError(401, 'UNAUTHORIZED', 'invalid token');
  const user = await ctx.identity.getUser(userId);
  if (user === null) throw new AppError(401, 'UNAUTHORIZED', 'unknown user');
  return user;
}

const LoginSchema = z.object({ email: z.string().email() });

export function registerAuthRoutes(app: FastifyInstance, ctx: AppCtx): void {
  // Dev-simple login: email only, no password. Real provider slots in behind
  // the IdentityProvider interface without touching this route.
  app.post('/api/auth/login', async (req) => {
    const body = LoginSchema.parse(req.body);
    const user = await ctx.identity.authenticate(body.email);
    if (user === null) throw new AppError(401, 'UNAUTHORIZED', `no user with email ${body.email}`);
    return { token: issueToken(user.id), user };
  });

  app.get('/api/me', async (req) => {
    const user = await authenticate(ctx, req);
    const org = await ctx.store.getOrg(user.org_id);
    return { user, org };
  });

  app.get('/api/org/users', async (req) => {
    const user = await authenticate(ctx, req);
    const users = await ctx.identity.listOrgUsers(user.org_id);
    return { users };
  });
}
