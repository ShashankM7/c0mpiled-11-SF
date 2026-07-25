import { describe, expect, it } from 'vitest';
import { requiredApproval } from '../src/domain/policy.js';
import type { ApprovalChain, Verdict } from '../src/types.js';
import { api, buildTestApp, login, runCanonicalRequest } from './helpers.js';

describe('requiredApproval (pure)', () => {
  it('$5,700 + VERIFIED -> MANAGER_AND_CONTROLLER', () => {
    const result = requiredApproval({ total_cents: 570_000, supplier_verdict: 'VERIFIED' });
    expect(result.tier).toBe('MANAGER_AND_CONTROLLER');
    expect(result.required_roles).toEqual(['manager', 'controller']);
    expect(result.escalation_reason).toBeNull();
  });

  it('$4,999 + VERIFIED -> MANAGER', () => {
    const result = requiredApproval({ total_cents: 499_900, supplier_verdict: 'VERIFIED' });
    expect(result.tier).toBe('MANAGER');
    expect(result.required_roles).toEqual(['manager']);
  });

  it('$900 + VERIFIED -> SELF', () => {
    const result = requiredApproval({ total_cents: 90_000, supplier_verdict: 'VERIFIED' });
    expect(result.tier).toBe('SELF');
    expect(result.required_roles).toEqual(['requester']);
  });

  it('$400 + NEEDS_CONFIRMATION -> CONTROLLER_ESCALATED (small amount still escalates)', () => {
    const result = requiredApproval({ total_cents: 40_000, supplier_verdict: 'NEEDS_CONFIRMATION' });
    expect(result.tier).toBe('CONTROLLER_ESCALATED');
    expect(result.required_roles).toEqual(['controller']);
    expect(result.escalation_reason).toContain('NEEDS_CONFIRMATION');
  });

  it('escalation rule is checked first and wins at every amount', () => {
    for (const verdict of ['NEEDS_CONFIRMATION', 'CONFLICTING', 'BLOCKED'] as Verdict[]) {
      for (const total of [0, 50_000, 100_000, 500_000, 999_999]) {
        const result = requiredApproval({ total_cents: total, supplier_verdict: verdict });
        expect(result.tier).toBe('CONTROLLER_ESCALATED');
        expect(result.escalation_reason).not.toBeNull();
      }
    }
  });

  it('ap_clerk never appears in required_roles across 0–1,000,000 cents x all four verdicts', () => {
    const verdicts: Verdict[] = ['VERIFIED', 'NEEDS_CONFIRMATION', 'CONFLICTING', 'BLOCKED'];
    for (const verdict of verdicts) {
      for (let total = 0; total <= 1_000_000; total++) {
        const { required_roles } = requiredApproval({ total_cents: total, supplier_verdict: verdict });
        if (required_roles.includes('ap_clerk')) {
          throw new Error(`ap_clerk in required_roles at ${total} cents, verdict ${verdict}`);
        }
      }
    }
  });
});

describe('approval chain over HTTP (fixture run: $5,700 + VERIFIED)', () => {
  it('only manager approved -> status PARTIAL, never APPROVED', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const marcus = await login(app, 'marcus@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const result = await api<{ chain: ApprovalChain; request_state: string }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: marcus,
      payload: { decision: 'APPROVED' },
    });
    expect(result.status).toBe(200);
    expect(result.body.chain.status).toBe('PARTIAL');
    expect(result.body.chain.satisfied_roles).toEqual(['manager']);
    expect(result.body.request_state).toBe('AWAITING_APPROVAL');
    await app.close();
  });

  it('BLOCKED supplier cannot reach APPROVED even with all roles approving', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const marcus = await login(app, 'marcus@northgate.test');
    const priya = await login(app, 'priya@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    // Force the selected supplier's verdict to BLOCKED directly in the store.
    const request = await app.ctx.store.getRequest(requestId);
    const options = await app.ctx.store.getOptions(requestId);
    const selected = options.find((o) => o.id === request?.selected_option_id);
    const suppliers = await app.ctx.store.getSuppliers(requestId);
    const supplier = suppliers.find((s) => s.merchant_domain === selected?.merchant_domain);
    expect(supplier).toBeDefined();
    if (supplier !== undefined) {
      supplier.verdict = 'BLOCKED';
      await app.ctx.store.putSupplier(requestId, supplier);
    }

    for (const token of [marcus, priya]) {
      const result = await api<{ error: { reason: string } }>(app, {
        method: 'POST',
        url: `/api/requests/${requestId}/approvals`,
        token,
        payload: { decision: 'APPROVED' },
      });
      expect(result.status).toBe(409);
      expect(result.body.error.reason).toBe('SUPPLIER_BLOCKED');
    }

    const after = await app.ctx.store.getRequest(requestId);
    expect(after?.state).not.toBe('APPROVED_READY_TO_PLACE');
    await app.close();
  });
});
