import type { RequestState } from '../types.js';

/**
 * Legal request-state transitions. VERIFYING -> SOURCED is the critical edge:
 * a rejected supplier sends the request back to sourcing for the next
 * candidate. Illegal transitions throw.
 */
export const LEGAL_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  DRAFT: ['PARSED', 'FAILED'],
  PARSED: ['SOURCING', 'FAILED'],
  SOURCING: ['SOURCED', 'FAILED'],
  SOURCED: ['VERIFYING'],
  VERIFYING: ['SOURCED', 'QUOTED', 'BLOCKED'],
  QUOTED: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['APPROVED_READY_TO_PLACE', 'AWAITING_APPROVAL', 'BLOCKED'],
  APPROVED_READY_TO_PLACE: [],
  BLOCKED: [],
  FAILED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RequestState,
    public readonly to: RequestState,
  ) {
    super(`illegal state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: RequestState, to: RequestState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
