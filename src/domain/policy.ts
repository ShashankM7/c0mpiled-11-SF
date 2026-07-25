import type { ApprovalChain, Role, Verdict } from '../types.js';

/**
 * Approval policy — pure, zero I/O. Amounts are integer cents.
 *
 *   supplier_verdict !== VERIFIED (any amount)  -> CONTROLLER_ESCALATED [controller]
 *   total <  $1,000  (100_000)                  -> SELF                 [requester]
 *   $1,000 <= total <= $5,000 (500_000)         -> MANAGER              [manager]
 *   total >  $5,000                             -> MANAGER_AND_CONTROLLER [manager, controller]
 *
 * The escalation rule is checked first and wins. ap_clerk is never in any
 * required_roles set — it can read and prepare, never approve.
 */
export function requiredApproval(input: {
  total_cents: number;
  supplier_verdict: Verdict;
}): { tier: ApprovalChain['tier']; required_roles: Role[]; escalation_reason: string | null } {
  const { total_cents, supplier_verdict } = input;
  if (!Number.isInteger(total_cents) || total_cents < 0) {
    throw new Error(`total_cents must be a non-negative integer, got ${total_cents}`);
  }

  if (supplier_verdict !== 'VERIFIED') {
    return {
      tier: 'CONTROLLER_ESCALATED',
      required_roles: ['controller'],
      escalation_reason:
        `supplier verdict ${supplier_verdict} — purchases from suppliers that are not fully ` +
        `verified require controller approval regardless of amount`,
    };
  }
  if (total_cents < 100_000) {
    return { tier: 'SELF', required_roles: ['requester'], escalation_reason: null };
  }
  if (total_cents <= 500_000) {
    return { tier: 'MANAGER', required_roles: ['manager'], escalation_reason: null };
  }
  return {
    tier: 'MANAGER_AND_CONTROLLER',
    required_roles: ['manager', 'controller'],
    escalation_reason: null,
  };
}
