import { describe, expect, it } from 'vitest';
import type { LandedCost, ApprovalChain, RunEvent, FreightQuote, ProductOption, Supplier } from '../src/types.js';
import { api, buildTestApp, login, runCanonicalRequest } from './helpers.js';

interface Aggregate {
  request: {
    state: string;
    quantity: number;
    budget_max_cents: number;
    deadline: string;
    rejected_supplier_ids: string[];
    selected_option_id: string;
  };
  options: ProductOption[];
  suppliers: Supplier[];
  destination_check: { verdict: string; receiving_phone: string | null };
  freight_quote: FreightQuote;
  landed_cost: LandedCost;
  approval_chain: ApprovalChain;
  audit_log: Array<{ from: string; to: string }>;
}

describe('the default fixture run', () => {
  it('produces the canonical demo outcome end to end', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const { requestId, runId } = await runCanonicalRequest(app, dana);

    const { body: agg } = await api<Aggregate>(app, {
      method: 'GET',
      url: `/api/requests/${requestId}`,
      token: dana,
    });

    // Parse: 40 chairs, $6,500 budget in cents, Thursday resolved from the fixed clock.
    expect(agg.request.quantity).toBe(40);
    expect(agg.request.budget_max_cents).toBe(650_000);
    expect(agg.request.deadline).toBe('2026-07-30');

    // Exactly one rejection; the selected supplier is VERIFIED with evidence.
    expect(agg.request.rejected_supplier_ids.length).toBe(1);
    const blocked = agg.suppliers.find((s) => s.verdict === 'BLOCKED');
    expect(blocked?.merchant_name).toBe('BulkChairs Depot');
    expect(blocked?.evidence.filter((e) => e.supports === 'negative').length).toBeGreaterThanOrEqual(2);
    const selected = agg.options.find((o) => o.id === agg.request.selected_option_id);
    expect(selected?.merchant_name).toBe('SeatCraft Commercial');
    const selectedSupplier = agg.suppliers.find((s) => s.merchant_domain === selected?.merchant_domain);
    expect(selectedSupplier?.verdict).toBe('VERIFIED');
    expect(selectedSupplier?.evidence.length).toBeGreaterThan(0);

    // Destination verified with a receiving phone.
    expect(agg.destination_check.verdict).toBe('VERIFIED');
    expect(agg.destination_check.receiving_phone).toBe('+15105550123');

    // Freight: 3 pallets (40 chairs / 16 per pallet), inside the deadline.
    expect(agg.freight_quote.pallets).toBe(3);
    expect(agg.freight_quote.cost_cents).toBe(74_000);
    expect(agg.freight_quote.meets_deadline).toBe(true);

    // Landed cost: exactly $5,700 against $6,500.
    expect(agg.landed_cost.product_cents).toBe(496_000);
    expect(agg.landed_cost.total_cents).toBe(570_000);
    expect(agg.landed_cost.under_budget).toBe(true);
    expect(agg.landed_cost.savings_vs_parcel_cents).toBe(54_000);

    // Policy: > $5,000 with VERIFIED supplier -> MANAGER_AND_CONTROLLER.
    expect(agg.approval_chain.tier).toBe('MANAGER_AND_CONTROLLER');
    expect(agg.approval_chain.required_roles).toEqual(['manager', 'controller']);
    expect(agg.request.state).toBe('AWAITING_APPROVAL');

    // THE critical edge, asserted in the audit log: VERIFYING -> SOURCED.
    expect(agg.audit_log.some((a) => a.from === 'VERIFYING' && a.to === 'SOURCED')).toBe(true);

    // Labels: A cheapest, C fastest, selected B best landed value.
    const labels = new Map(agg.options.map((o) => [o.merchant_name, o.label]));
    expect(labels.get('BulkChairs Depot')).toBe('LOWEST_PRICE');
    expect(labels.get('Rapid Restaurant Supply')).toBe('FASTEST');
    expect(labels.get('SeatCraft Commercial')).toBe('BEST_LANDED_VALUE');

    // Event log: monotonic seq from 1, exactly one supplier.rejected, telemetry says fixture.
    const { body: runView } = await api<{ run: { status: string }; events: RunEvent[] }>(app, {
      method: 'GET',
      url: `/api/runs/${runId}`,
      token: dana,
    });
    expect(runView.run.status).toBe('AWAITING_APPROVAL');
    runView.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    expect(runView.events.filter((e) => e.type === 'supplier.rejected').length).toBe(1);
    const types = runView.events.map((e) => e.type);
    for (const required of [
      'run.started', 'request.parsed', 'sourcing.started', 'sourcing.completed',
      'supplier.evaluated', 'supplier.rejected', 'destination.verified', 'freight.quoted',
      'options.relabeled', 'cost.computed', 'approval.required', 'state.changed',
    ]) {
      expect(types).toContain(required);
    }
    const withTelemetry = runView.events.filter((e) => e.telemetry !== null);
    expect(withTelemetry.length).toBeGreaterThan(0);
    for (const e of withTelemetry) {
      expect(e.telemetry?.live).toBe(false);
      expect(e.telemetry?.fell_back).toBe(false);
    }

    // Event replay contract: ?after_seq= only returns later events.
    const afterSeq = 5;
    const replay = await app.ctx.store.listEvents(runId, afterSeq);
    expect(replay.every((e) => e.seq > afterSeq)).toBe(true);

    await app.close();
  });

  it('fixture edits that break the demo fail CI: totals pinned', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);
    const { body: agg } = await api<Aggregate>(app, {
      method: 'GET',
      url: `/api/requests/${requestId}`,
      token: dana,
    });
    // One rejection, VERIFIED selection, total 570000, tier MANAGER_AND_CONTROLLER.
    expect({
      rejections: agg.request.rejected_supplier_ids.length,
      selected_verdict: agg.suppliers.find(
        (s) => s.merchant_domain === agg.options.find((o) => o.id === agg.request.selected_option_id)?.merchant_domain,
      )?.verdict,
      total_cents: agg.landed_cost.total_cents,
      tier: agg.approval_chain.tier,
    }).toEqual({
      rejections: 1,
      selected_verdict: 'VERIFIED',
      total_cents: 570_000,
      tier: 'MANAGER_AND_CONTROLLER',
    });
    await app.close();
  });

  it('dead vendor URLs: run still completes via fixture fallback with fell_back telemetry', async () => {
    // Keys present + every base URL pointed at a dead port => live paths are
    // attempted, fail fast, and fall back. The run must still complete.
    const { loadConfig, setConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const { MemoryStore } = await import('../src/store/memory.js');
    const dead = 'http://127.0.0.1:1';
    setConfig(
      loadConfig({
        DEMO_MODE: 'auto',
        ADAPTER_TIMEOUT_MS: '1500',
        CHANNEL3_API_KEY: 'x', CHANNEL3_BASE_URL: dead,
        CRUSTDATA_API_KEY: 'x', CRUSTDATA_BASE_URL: dead,
        VOYGR_API_KEY: 'x', VOYGR_BASE_URL: dead,
        OWAY_API_KEY: 'x', OWAY_BASE_URL: dead,
        CALLWRIGHT_API_KEY: 'x', CALLWRIGHT_BASE_URL: dead,
      }),
    );
    const app = await buildServer({ store: new MemoryStore(null) });
    try {
      const dana = await login(app, 'dana@northgate.test');
      const { requestId, runId } = await runCanonicalRequest(app, dana);
      const { body: agg } = await api<Aggregate>(app, {
        method: 'GET',
        url: `/api/requests/${requestId}`,
        token: dana,
      });
      expect(agg.request.state).toBe('AWAITING_APPROVAL');
      expect(agg.landed_cost.total_cents).toBe(570_000);
      const { body: runView } = await api<{ events: RunEvent[] }>(app, {
        method: 'GET',
        url: `/api/runs/${runId}`,
        token: dana,
      });
      const telemetries = runView.events.filter((e) => e.telemetry !== null).map((e) => e.telemetry);
      expect(telemetries.length).toBeGreaterThan(0);
      for (const t of telemetries) {
        expect(t?.live).toBe(false);
        expect(t?.fell_back).toBe(true);
        expect(t?.error).not.toBeNull();
      }
    } finally {
      await app.close();
      setConfig(loadConfig({ ...process.env, DEMO_MODE: 'fixture' }));
    }
  });

  it('phonely webhook creates a request and auto-starts a run', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const hook = await api<{ request_id: string; run_id: string }>(app, {
      method: 'POST',
      url: '/api/webhooks/phonely',
      payload: {
        call: {
          from: '+15105550123',
          transcript: '40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500',
        },
      },
    });
    expect(hook.status).toBe(202);
    await app.ctx.orchestrator.waitForRun(hook.body.run_id);
    const { body: agg } = await api<Aggregate>(app, {
      method: 'GET',
      url: `/api/requests/${hook.body.request_id}`,
      token: dana,
    });
    expect(agg.request.state).toBe('AWAITING_APPROVAL');
    await app.close();
  });
});
