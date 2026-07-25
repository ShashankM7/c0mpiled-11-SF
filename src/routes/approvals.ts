import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalDecision, ProcurementRequest, RequestState, RunEventType, Supplier } from '../types.js';
import type { AppCtx } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { assertTransition } from '../domain/stateMachine.js';
import { authenticate } from './auth.js';

const DecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'DENIED']),
  reason: z.string().optional(),
  // NOTE: no role field. Authorization is server-side only; a client-supplied
  // role is ignored by schema stripping and never consulted.
});

async function emitToLatestRun(
  ctx: AppCtx,
  requestId: string,
  type: RunEventType,
  payload: unknown,
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
    telemetry: null,
  });
  ctx.bus.publish(event);
}

async function transition(
  ctx: AppCtx,
  request: ProcurementRequest,
  to: RequestState,
  cause: string,
  actor: string,
): Promise<void> {
  assertTransition(request.state, to);
  const from = request.state;
  request.state = to;
  request.updated_at = new Date().toISOString();
  await ctx.store.putRequest(request);
  await ctx.store.appendAudit({
    request_id: request.id,
    from,
    to,
    cause,
    actor,
    at: new Date().toISOString(),
  });
  await emitToLatestRun(ctx, request.id, 'state.changed', { from, to, cause });
}

async function selectedSupplier(ctx: AppCtx, request: ProcurementRequest): Promise<Supplier | null> {
  if (request.selected_option_id === null) return null;
  const options = await ctx.store.getOptions(request.id);
  const selected = options.find((o) => o.id === request.selected_option_id);
  if (selected === undefined) return null;
  const suppliers = await ctx.store.getSuppliers(request.id);
  return suppliers.find((s) => s.merchant_domain === selected.merchant_domain) ?? null;
}

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppCtx): void {
  /**
   * The security boundary. Role comes from the session user, server-side.
   * Order of checks (per spec): load -> idempotency -> SUPPLIER_BLOCKED 409 ->
   * state check -> role check 403 (recorded) -> record decision.
   */
  app.post('/api/requests/:id/approvals', async (req, reply) => {
    const user = await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const body = DecisionSchema.parse(req.body);

    const request = await ctx.store.getRequest(id);
    if (request === null) throw notFound('request');
    const chain = await ctx.store.getApprovalChain(id);
    if (chain === null) {
      throw new AppError(409, 'CONFLICT', 'no approval chain exists yet — run the request first', 'NO_APPROVAL_CHAIN');
    }

    // Idempotency: the same user approving twice does not double-satisfy.
    const priorApproval = chain.decisions.find(
      (d) => d.user_id === user.id && d.decision === 'APPROVED',
    );
    if (priorApproval !== undefined && body.decision === 'APPROVED') {
      return { chain, request_state: request.state, idempotent: true };
    }

    // Invariant: a BLOCKED supplier can never reach APPROVED_READY_TO_PLACE,
    // regardless of who approves.
    const supplier = await selectedSupplier(ctx, request);
    if (supplier !== null && supplier.verdict === 'BLOCKED') {
      throw new AppError(
        409,
        'CONFLICT',
        'the selected supplier is BLOCKED; this request cannot be approved',
        'SUPPLIER_BLOCKED',
      );
    }

    if (request.state !== 'AWAITING_APPROVAL') {
      throw new AppError(
        409,
        'CONFLICT',
        `request is in state ${request.state}, approvals only apply in AWAITING_APPROVAL`,
        'INVALID_STATE',
      );
    }

    // Server-side role gate. An unauthorized attempt is RECORDED (audit trail)
    // and rejected with a machine-readable reason.
    if (!chain.required_roles.includes(user.role)) {
      const denial: ApprovalDecision = {
        id: `dec_${randomUUID()}`,
        user_id: user.id,
        role: user.role,
        decision: 'BLOCKED_BY_POLICY',
        reason: `role ${user.role} is not in required_roles [${chain.required_roles.join(', ')}]`,
        at: new Date().toISOString(),
      };
      chain.decisions.push(denial);
      await ctx.store.putApprovalChain(chain);
      await emitToLatestRun(ctx, id, 'approval.recorded', { decision: denial, chain_status: chain.status });
      throw new AppError(403, 'FORBIDDEN', 'your role is not permitted to approve this request', 'ROLE_NOT_PERMITTED', {
        required_roles: chain.required_roles,
        your_role: user.role,
      });
    }

    const decision: ApprovalDecision = {
      id: `dec_${randomUUID()}`,
      user_id: user.id,
      role: user.role,
      decision: body.decision,
      reason: body.reason ?? null,
      at: new Date().toISOString(),
    };
    chain.decisions.push(decision);

    if (body.decision === 'DENIED') {
      chain.status = 'DENIED';
      await ctx.store.putApprovalChain(chain);
      await emitToLatestRun(ctx, id, 'approval.recorded', { decision, chain_status: chain.status });
      await transition(ctx, request, 'BLOCKED', `approval denied by ${user.role}`, user.id);
      return { chain, request_state: request.state };
    }

    if (!chain.satisfied_roles.includes(user.role)) chain.satisfied_roles.push(user.role);
    const fullySatisfied = chain.required_roles.every((role) => chain.satisfied_roles.includes(role));
    chain.status = fullySatisfied ? 'APPROVED' : 'PARTIAL';
    await ctx.store.putApprovalChain(chain);
    await emitToLatestRun(ctx, id, 'approval.recorded', { decision, chain_status: chain.status });

    if (fullySatisfied) {
      // The end state. The system never executes checkout or payment.
      await transition(ctx, request, 'APPROVED_READY_TO_PLACE', 'approval chain satisfied', user.id);
      const runs = await ctx.store.listRunsForRequest(id);
      const latest = runs[runs.length - 1];
      if (latest !== undefined) {
        latest.status = 'COMPLETED';
        latest.finished_at = new Date().toISOString();
        await ctx.store.putRun(latest);
      }
      await emitToLatestRun(ctx, id, 'run.completed', {
        final_state: 'APPROVED_READY_TO_PLACE',
        chain_status: chain.status,
      });
    }

    reply.code(200);
    return { chain, request_state: request.state };
  });
}
