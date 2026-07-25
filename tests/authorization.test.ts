import { describe, expect, it } from 'vitest';
import type { ApprovalChain } from '../src/types.js';
import { api, buildTestApp, login, runCanonicalRequest } from './helpers.js';

describe('authorization — server-side only, never trust the client', () => {
  it('unauthenticated requests get 401', async () => {
    const app = await buildTestApp();
    const res = await api(app, { method: 'GET', url: '/api/requests' });
    expect(res.status).toBe(401);
    await app.close();
  });

  it('ap_clerk approval attempt returns 403 with machine-readable reason AND is recorded', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const alex = await login(app, 'alex@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const attempt = await api<{ error: { code: string; reason: string; details: { required_roles: string[]; your_role: string } } }>(
      app,
      {
        method: 'POST',
        url: `/api/requests/${requestId}/approvals`,
        token: alex,
        payload: { decision: 'APPROVED' },
      },
    );
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.reason).toBe('ROLE_NOT_PERMITTED');
    expect(attempt.body.error.details.your_role).toBe('ap_clerk');
    expect(attempt.body.error.details.required_roles).toEqual(['manager', 'controller']);

    // The denial is the audit trail: recorded as BLOCKED_BY_POLICY.
    const chain = await app.ctx.store.getApprovalChain(requestId);
    const recorded = chain?.decisions.find((d) => d.decision === 'BLOCKED_BY_POLICY');
    expect(recorded).toBeDefined();
    expect(recorded?.role).toBe('ap_clerk');
    expect(chain?.satisfied_roles).toEqual([]);
    await app.close();
  });

  it('a client-supplied role in the body is ignored — the session role decides', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const alex = await login(app, 'alex@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const attempt = await api<{ error: { reason: string } }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: alex,
      // Spoofed fields: the schema strips them, the server uses the session role.
      payload: { decision: 'APPROVED', role: 'controller', user_role: 'controller' },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.reason).toBe('ROLE_NOT_PERMITTED');
    await app.close();
  });

  it('full chain: manager PARTIAL -> controller APPROVED -> APPROVED_READY_TO_PLACE', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const marcus = await login(app, 'marcus@northgate.test');
    const priya = await login(app, 'priya@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const first = await api<{ chain: ApprovalChain }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: marcus,
      payload: { decision: 'APPROVED' },
    });
    expect(first.body.chain.status).toBe('PARTIAL');

    const second = await api<{ chain: ApprovalChain; request_state: string }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: priya,
      payload: { decision: 'APPROVED' },
    });
    expect(second.body.chain.status).toBe('APPROVED');
    expect(second.body.request_state).toBe('APPROVED_READY_TO_PLACE');
    await app.close();
  });

  it('idempotency: the same user approving twice does not double-satisfy', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const marcus = await login(app, 'marcus@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const first = await api<{ chain: ApprovalChain }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: marcus,
      payload: { decision: 'APPROVED' },
    });
    const second = await api<{ chain: ApprovalChain }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: marcus,
      payload: { decision: 'APPROVED' },
    });
    expect(second.status).toBe(200);
    expect(second.body.chain.satisfied_roles).toEqual(first.body.chain.satisfied_roles);
    expect(second.body.chain.status).toBe('PARTIAL');
    // No extra APPROVED decision rows either.
    expect(second.body.chain.decisions.filter((d) => d.decision === 'APPROVED').length).toBe(1);
    await app.close();
  });

  it('a denial by a permitted role blocks the request', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const marcus = await login(app, 'marcus@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const denial = await api<{ chain: ApprovalChain; request_state: string }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/approvals`,
      token: marcus,
      payload: { decision: 'DENIED', reason: 'wrong vendor' },
    });
    expect(denial.status).toBe(200);
    expect(denial.body.chain.status).toBe('DENIED');
    expect(denial.body.request_state).toBe('BLOCKED');
    await app.close();
  });

  it('second outbound call returns 429 CALL_BUDGET_EXCEEDED', async () => {
    const app = await buildTestApp();
    const dana = await login(app, 'dana@northgate.test');
    const { requestId } = await runCanonicalRequest(app, dana);

    const first = await api(app, { method: 'POST', url: `/api/requests/${requestId}/call`, token: dana, payload: {} });
    expect(first.status).toBe(201);
    const second = await api<{ error: { reason: string } }>(app, {
      method: 'POST',
      url: `/api/requests/${requestId}/call`,
      token: dana,
      payload: {},
    });
    expect(second.status).toBe(429);
    expect(second.body.error.reason).toBe('CALL_BUDGET_EXCEEDED');
    await app.close();
  });
});
