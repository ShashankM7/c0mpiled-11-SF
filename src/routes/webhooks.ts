import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../context.js';
import { PHONELY_WEBHOOK_SECRET } from '../config.js';
import { AppError } from '../errors.js';
import { parseInbound } from '../adapters/phonely.js';
import { SEED_ORG, SEED_USERS } from '../seed.js';
import { newRequest } from './requests.js';

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  /** Inbound Phonely transcript -> creates a request and auto-starts a run. */
  app.post('/api/webhooks/phonely', async (req, reply) => {
    const secret = PHONELY_WEBHOOK_SECRET();
    if (secret !== null && req.headers['x-phonely-signature'] !== secret) {
      throw new AppError(401, 'UNAUTHORIZED', 'invalid webhook signature');
    }

    const inbound = await parseInbound(req.body);

    // Inbound calls arrive with no session; attribute them to the org's requester.
    const requester =
      (await ctx.store.listOrgUsers(SEED_ORG.id)).find((u) => u.role === 'requester') ??
      (SEED_USERS[0] as (typeof SEED_USERS)[number]);

    const request = newRequest({
      org_id: requester.org_id,
      requester_id: requester.id,
      raw_text: inbound.data.transcript,
    });
    await ctx.store.putRequest(request);
    const runId = await ctx.orchestrator.startRun(request.id, requester.id);

    reply.code(202);
    return {
      request_id: request.id,
      run_id: runId,
      from: inbound.data.from,
      telemetry: inbound.telemetry,
    };
  });
}
