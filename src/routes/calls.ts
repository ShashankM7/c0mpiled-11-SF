import type { FastifyInstance } from 'fastify';
import type { RunEventType } from '../types.js';
import type { AppCtx } from '../context.js';
import { getConfig } from '../config.js';
import { AppError, notFound } from '../errors.js';
import { MAX_CALLS_PER_RUN, placeCall } from '../adapters/callwright.js';
import { authenticate } from './auth.js';

async function emitToLatestRun(
  ctx: AppCtx,
  requestId: string,
  type: RunEventType,
  payload: unknown,
  telemetry: Parameters<AppCtx['store']['appendEvent']>[0]['telemetry'] = null,
): Promise<void> {
  const runs = await ctx.store.listRunsForRequest(requestId);
  const latest = runs[runs.length - 1];
  if (latest === undefined) return;
  const event = await ctx.store.appendEvent({
    run_id: latest.id,
    request_id: requestId,
    type,
    at: new Date().toISOString(),
    payload,
    telemetry,
  });
  ctx.bus.publish(event);
}

export function registerCallRoutes(app: FastifyInstance, ctx: AppCtx): void {
  /** Trigger the single outbound delivery-window confirmation call. */
  app.post('/api/requests/:id/call', async (req, reply) => {
    const user = await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const request = await ctx.store.getRequest(id);
    if (request === null) throw notFound('request');

    if (!['QUOTED', 'AWAITING_APPROVAL', 'APPROVED_READY_TO_PLACE'].includes(request.state)) {
      throw new AppError(
        409,
        'CONFLICT',
        `calls can only be placed after quoting; request is ${request.state}`,
        'INVALID_STATE',
      );
    }

    // Hard call budget: one outbound call per run, no exceptions.
    const existing = await ctx.store.listCallOutcomes(id);
    if (existing.length >= MAX_CALLS_PER_RUN) {
      throw new AppError(
        429,
        'TOO_MANY_REQUESTS',
        `call budget of ${MAX_CALLS_PER_RUN} per run already used`,
        'CALL_BUDGET_EXCEEDED',
      );
    }

    const destination = await ctx.store.getDestinationCheck(id);
    const to = getConfig().demoCallNumber ?? destination?.receiving_phone ?? null;
    if (to === null) {
      throw new AppError(409, 'CONFLICT', 'no destination phone on record and no DEMO_CALL_NUMBER set', 'NO_PHONE');
    }

    await emitToLatestRun(ctx, id, 'call.started', {
      to_number: to,
      purpose: 'CONFIRM_DELIVERY_WINDOW',
      actor: user.id,
    });

    const result = await placeCall({
      to,
      purpose: 'CONFIRM_DELIVERY_WINDOW',
      context:
        `Confirm a pallet delivery window at ${request.delivery_address ?? 'the destination'} ` +
        `for ${request.quantity ?? 'several'} chairs arriving by ${request.deadline ?? 'the agreed date'}.`,
    });
    const outcome = { ...result.data, request_id: id };
    await ctx.store.putCallOutcome(outcome);
    await emitToLatestRun(ctx, id, 'call.completed', { outcome }, result.telemetry);

    reply.code(201);
    return outcome;
  });
}
