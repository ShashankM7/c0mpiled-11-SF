import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProcurementRequest } from '../types.js';
import type { AppCtx } from '../context.js';
import { getConfig } from '../config.js';
import { AppError, notFound } from '../errors.js';
import { authenticate } from './auth.js';

const CreateSchema = z.object({
  raw_text: z.string().min(1),
  delivery_address: z.string().min(1).optional(),
  budget_max_cents: z.number().int().nonnegative().optional(),
});

const RunBodySchema = z
  .object({
    // Optional replay clock: pure domain functions never read the wall clock,
    // so a caller-supplied now makes runs deterministic.
    now: z.string().datetime({ offset: true }).optional(),
  })
  .nullish();

export function newRequest(input: {
  org_id: string;
  requester_id: string;
  raw_text: string;
  delivery_address?: string | undefined;
  budget_max_cents?: number | undefined;
}): ProcurementRequest {
  const at = new Date().toISOString();
  return {
    id: `req_${randomUUID()}`,
    org_id: input.org_id,
    requester_id: input.requester_id,
    raw_text: input.raw_text,
    item_description: null,
    quantity: null,
    deadline: null,
    delivery_address: input.delivery_address ?? null,
    budget_max_cents: input.budget_max_cents ?? null,
    state: 'DRAFT',
    selected_option_id: null,
    rejected_supplier_ids: [],
    created_at: at,
    updated_at: at,
  };
}

/** Everything a frontend needs to render the whole request page, in one call. */
export async function loadAggregate(ctx: AppCtx, requestId: string): Promise<Record<string, unknown>> {
  const request = await ctx.store.getRequest(requestId);
  if (request === null) throw notFound('request');
  const runs = await ctx.store.listRunsForRequest(requestId);
  return {
    request,
    options: await ctx.store.getOptions(requestId),
    suppliers: await ctx.store.getSuppliers(requestId),
    destination_check: await ctx.store.getDestinationCheck(requestId),
    freight_quote: await ctx.store.getFreightQuote(requestId),
    landed_cost: await ctx.store.getLandedCost(requestId),
    approval_chain: await ctx.store.getApprovalChain(requestId),
    call_outcomes: await ctx.store.listCallOutcomes(requestId),
    audit_log: await ctx.store.listAudit(requestId),
    runs,
    latest_run_id: runs.length > 0 ? (runs[runs.length - 1] as { id: string }).id : null,
  };
}

function skillYaml(input: {
  runId: string;
  request: ProcurementRequest;
  unitsPerPallet: number;
}): string {
  const { runId, request, unitsPerPallet } = input;
  const budgetDollars =
    request.budget_max_cents === null ? 'null' : String(Math.floor(request.budget_max_cents / 100));
  return [
    `skill: furnish_restaurant_seating`,
    `version: 1`,
    `learned_from: ${runId}`,
    `inputs:`,
    `  units: ${request.quantity ?? 'null'}`,
    `  location: "${request.delivery_address ?? ''}"`,
    `  deadline: "${request.deadline ?? ''}"`,
    `  budget_max: ${budgetDollars}`,
    `constraints:`,
    `  units_per_pallet: ${unitsPerPallet}`,
    `  supplier_must_be_verified: true`,
    `approval:`,
    `  required_above: 5000`,
    `  escalate_if_unverified: true`,
    `  roles: [manager, controller]`,
    `actions: [parse_request, search_products, verify_suppliers, verify_destination,`,
    `          quote_freight, compute_landed_cost, enforce_approval, confirm_delivery_window]`,
    ``,
  ].join('\n');
}

export function registerRequestRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post('/api/requests', async (req, reply) => {
    const user = await authenticate(ctx, req);
    const body = CreateSchema.parse(req.body);
    const request = newRequest({
      org_id: user.org_id,
      requester_id: user.id,
      raw_text: body.raw_text,
      delivery_address: body.delivery_address,
      budget_max_cents: body.budget_max_cents,
    });
    await ctx.store.putRequest(request);
    reply.code(201);
    return request;
  });

  app.get('/api/requests', async (req) => {
    const user = await authenticate(ctx, req);
    return { requests: await ctx.store.listRequests(user.org_id) };
  });

  app.get('/api/requests/:id', async (req) => {
    await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    return loadAggregate(ctx, id);
  });

  app.post('/api/requests/:id/run', async (req, reply) => {
    const user = await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const body = RunBodySchema.parse(req.body ?? null);
    const request = await ctx.store.getRequest(id);
    if (request === null) throw notFound('request');
    if (request.state !== 'DRAFT') {
      throw new AppError(409, 'CONFLICT', `request is in state ${request.state}, expected DRAFT`, 'INVALID_STATE');
    }
    const runId = await ctx.orchestrator.startRun(id, user.id, body?.now);
    reply.code(202);
    return { run_id: runId };
  });

  app.get('/api/requests/:id/skill', async (req, reply) => {
    await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const request = await ctx.store.getRequest(id);
    if (request === null) throw notFound('request');
    if (request.state !== 'APPROVED_READY_TO_PLACE') {
      throw new AppError(
        409,
        'CONFLICT',
        `skill is compiled from a completed run; request is ${request.state}`,
        'RUN_NOT_COMPLETED',
      );
    }
    const runs = await ctx.store.listRunsForRequest(id);
    const latest = runs[runs.length - 1];
    reply.header('content-type', 'text/yaml; charset=utf-8');
    return skillYaml({
      runId: latest?.id ?? 'unknown',
      request,
      unitsPerPallet: getConfig().unitsPerPallet,
    });
  });
}
