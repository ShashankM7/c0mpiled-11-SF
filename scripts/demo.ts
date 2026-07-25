/**
 * npm run demo — headless full run against fixtures. No network, no API keys.
 *
 * Creates the canonical request, runs the pipeline, prints the event
 * transcript, exercises the approval sequence (Alex denied 403, Marcus
 * PARTIAL, Priya APPROVED), places the one outbound call, prints the final
 * aggregate and the compiled skill YAML. Exits non-zero if any expected
 * outcome is missing — this is how the backend is verified before any
 * frontend exists.
 */
process.env['DEMO_MODE'] = 'fixture';

const { resetConfig } = await import('../src/config.js');
resetConfig();
const { buildServer } = await import('../src/server.js');
const { MemoryStore } = await import('../src/store/memory.js');

import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ApprovalChain, LandedCost, RunEvent } from '../src/types.js';

// Fixed clock so the transcript is deterministic and matches the fixtures.
const NOW = '2026-07-25T17:00:00.000Z';
const RAW_TEXT =
  '40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500';

const failures: string[] = [];
function expect(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ FAILED: ${label}`);
  }
}

function cents(value: number | null): string {
  if (value === null) return 'n/a';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${remainder}`;
}

async function api<T>(
  app: FastifyInstance,
  opts: InjectOptions & { token?: string },
): Promise<{ status: number; body: T }> {
  const { token, ...rest } = opts;
  const res = await app.inject({
    ...rest,
    headers: { ...(rest.headers ?? {}), ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
  });
  const type = res.headers['content-type'] ?? '';
  const body = String(type).includes('json') ? (res.json() as T) : (res.body as unknown as T);
  return { status: res.statusCode, body };
}

async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await api<{ token: string }>(app, {
    method: 'POST',
    url: '/api/auth/login',
    payload: { email },
  });
  return res.body.token;
}

const app = await buildServer({ store: new MemoryStore(null) });

console.log('\n══ ProcureOS demo — fixture mode, zero network ═══════════════════════\n');

const health = await api<{ demo_mode: string; adapters: Record<string, string> }>(app, {
  method: 'GET',
  url: '/api/health',
});
console.log(`health: demo_mode=${health.body.demo_mode} adapters=${JSON.stringify(health.body.adapters)}\n`);

const dana = await login(app, 'dana@northgate.test');
const marcus = await login(app, 'marcus@northgate.test');
const priya = await login(app, 'priya@northgate.test');
const alex = await login(app, 'alex@northgate.test');

const created = await api<{ id: string }>(app, {
  method: 'POST',
  url: '/api/requests',
  token: dana,
  payload: { raw_text: RAW_TEXT },
});
const requestId = created.body.id;
console.log(`request created by Dana: ${requestId}`);
console.log(`  "${RAW_TEXT}"\n`);

const started = await api<{ run_id: string }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/run`,
  token: dana,
  payload: { now: NOW },
});
const runId = started.body.run_id;
await app.ctx.orchestrator.waitForRun(runId);

const runView = await api<{ run: { status: string }; events: RunEvent[] }>(app, {
  method: 'GET',
  url: `/api/runs/${runId}`,
  token: dana,
});

console.log('── event transcript ──────────────────────────────────────────────────');
for (const event of runView.body.events) {
  const t = event.telemetry;
  const source = t === null ? '' : ` [${t.adapter}: ${t.live ? 'live' : 'fixture'}${t.fell_back ? ', fell back' : ''}, ${t.duration_ms}ms]`;
  const payload = event.payload as Record<string, unknown>;
  let detail = '';
  if (event.type === 'state.changed') detail = ` ${String(payload['from'])} -> ${String(payload['to'])}`;
  if (event.type === 'supplier.evaluated') {
    const s = payload['supplier'] as { merchant_name: string; verdict: string; evidence: unknown[] };
    detail = ` ${s.merchant_name}: ${s.verdict} (${s.evidence.length} evidence rows)`;
  }
  if (event.type === 'supplier.rejected') detail = ` ${String(payload['merchant_name'])}`;
  if (event.type === 'destination.verified') {
    const d = payload['destination'] as { verdict: string; resolved_address: string };
    detail = ` ${d.resolved_address}: ${d.verdict}`;
  }
  if (event.type === 'freight.quoted') {
    const q = payload['quote'] as { pallets: number; cost_cents: number; estimated_delivery: string; meets_deadline: boolean };
    detail = ` ${q.pallets} pallets, ${cents(q.cost_cents)}, ETA ${q.estimated_delivery}, meets deadline: ${q.meets_deadline}`;
  }
  if (event.type === 'cost.computed') {
    const lc = payload['landed_cost'] as LandedCost;
    detail = ` total ${cents(lc.total_cents)} vs budget ${cents(lc.budget_cents)}`;
  }
  if (event.type === 'approval.required') detail = ` tier ${String(payload['tier'])}`;
  console.log(`  ${String(event.seq).padStart(2)} ${event.type}${detail}${source}`);
}
console.log('');

const aggregate = await api<{
  request: { state: string; rejected_supplier_ids: string[] };
  suppliers: Array<{ merchant_name: string; verdict: string; evidence: unknown[] }>;
  landed_cost: LandedCost;
  approval_chain: ApprovalChain;
}>(app, { method: 'GET', url: `/api/requests/${requestId}`, token: dana });

const agg = aggregate.body;
const rejectedCount = agg.request.rejected_supplier_ids.length;
const verified = agg.suppliers.find((s) => s.verdict === 'VERIFIED');
const blocked = agg.suppliers.find((s) => s.verdict === 'BLOCKED');

console.log('── pipeline outcome ──────────────────────────────────────────────────');
expect(rejectedCount === 1, `exactly one supplier rejected (${blocked?.merchant_name ?? '??'}) with ${blocked?.evidence.length ?? 0} evidence rows`);
expect(verified !== undefined, `replacement supplier verified: ${verified?.merchant_name ?? '??'}`);
expect(agg.landed_cost.total_cents === 570_000, `landed total ${cents(agg.landed_cost.total_cents)} (product ${cents(agg.landed_cost.product_cents)} + freight ${cents(agg.landed_cost.freight_cents)})`);
expect(agg.landed_cost.under_budget, `under budget ${cents(agg.landed_cost.budget_cents)} with ${cents(agg.landed_cost.remaining_cents)} remaining`);
expect(agg.landed_cost.savings_vs_parcel_cents === 54_000, `saves ${cents(agg.landed_cost.savings_vs_parcel_cents)} vs retail parcel shipping`);
expect(agg.approval_chain.tier === 'MANAGER_AND_CONTROLLER', `approval tier ${agg.approval_chain.tier}`);
expect(agg.request.state === 'AWAITING_APPROVAL', `state ${agg.request.state}`);
console.log('');

console.log('── approval sequence ─────────────────────────────────────────────────');

const alexAttempt = await api<{ error: { reason: string; details: { your_role: string } } }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/approvals`,
  token: alex,
  payload: { decision: 'APPROVED' },
});
expect(
  alexAttempt.status === 403 && alexAttempt.body.error.reason === 'ROLE_NOT_PERMITTED',
  `Alex (ap_clerk) denied: 403 ${alexAttempt.body.error.reason} — attempt recorded in the chain`,
);

const marcusAttempt = await api<{ chain: ApprovalChain }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/approvals`,
  token: marcus,
  payload: { decision: 'APPROVED' },
});
expect(
  marcusAttempt.status === 200 && marcusAttempt.body.chain.status === 'PARTIAL',
  `Marcus (manager) approved: chain ${marcusAttempt.body.chain.status}`,
);

const priyaAttempt = await api<{ chain: ApprovalChain; request_state: string }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/approvals`,
  token: priya,
  payload: { decision: 'APPROVED' },
});
expect(
  priyaAttempt.status === 200 &&
    priyaAttempt.body.chain.status === 'APPROVED' &&
    priyaAttempt.body.request_state === 'APPROVED_READY_TO_PLACE',
  `Priya (controller) approved: chain ${priyaAttempt.body.chain.status}, state ${priyaAttempt.body.request_state}`,
);
console.log('');

console.log('── outbound call ─────────────────────────────────────────────────────');
const call = await api<{ to_number: string; confirmed_window: string; succeeded: boolean }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/call`,
  token: dana,
  payload: {},
});
expect(call.status === 201 && call.body.succeeded, `call placed to ${call.body.to_number}: window "${call.body.confirmed_window}"`);

const secondCall = await api<{ error: { reason: string } }>(app, {
  method: 'POST',
  url: `/api/requests/${requestId}/call`,
  token: dana,
  payload: {},
});
expect(
  secondCall.status === 429 && secondCall.body.error.reason === 'CALL_BUDGET_EXCEEDED',
  `second call rejected: 429 ${secondCall.body.error.reason}`,
);
console.log('');

const finalAggregate = await api<{ request: { state: string }; audit_log: Array<{ from: string; to: string }> }>(
  app,
  { method: 'GET', url: `/api/requests/${requestId}`, token: dana },
);
const resourceEdge = finalAggregate.body.audit_log.some((a) => a.from === 'VERIFYING' && a.to === 'SOURCED');
expect(resourceEdge, 'audit log contains the VERIFYING -> SOURCED re-source edge');
expect(finalAggregate.body.request.state === 'APPROVED_READY_TO_PLACE', 'final state APPROVED_READY_TO_PLACE (no checkout, no payment)');
console.log('');

console.log('── compiled skill ────────────────────────────────────────────────────');
const skill = await api<string>(app, { method: 'GET', url: `/api/requests/${requestId}/skill`, token: dana });
console.log(skill.body);

await app.close();

if (failures.length > 0) {
  console.error(`\n✗ demo failed: ${failures.length} expectation(s) not met`);
  process.exit(1);
}
console.log('✅ demo complete — full run on fixtures with zero network access\n');
