import { describe, expect, it } from 'vitest';
import { evaluateDestination, evaluateSupplier } from '../src/domain/verification.js';
import type { PlaceInfo, Supplier } from '../src/types.js';

const NOW = '2026-07-25T17:00:00.000Z';

const identity = (over: Partial<NonNullable<Supplier['identity']>> = {}): Supplier['identity'] => ({
  legal_name: 'SeatCraft Commercial Furnishings LLC',
  employee_count: 85,
  founded_year: 2009,
  last_activity_signal: 'press release 2026-06-30',
  ...over,
});

const place = (over: Partial<PlaceInfo> = {}): PlaceInfo => ({
  place_id: 'vg_plc_1',
  formatted_address: '480 Hegenberger Rd, Oakland, CA',
  business_status: 'OPERATIONAL',
  phone: '+15105550177',
  phone_status: 'ACTIVE',
  hours_known: true,
  last_verified_at: '2026-07-20T00:00:00Z',
  ...over,
});

describe('evaluateSupplier', () => {
  it('rule 1: CLOSED_PERMANENTLY -> BLOCKED (affirmative negative evidence)', () => {
    const result = evaluateSupplier(identity(), place({ business_status: 'CLOSED_PERMANENTLY' }), NOW);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.some((e) => e.supports === 'negative')).toBe(true);
  });

  it('rule 2: disconnected phone + stale (>120d) verification -> BLOCKED with two negative rows', () => {
    const result = evaluateSupplier(
      identity({ last_activity_signal: null }),
      place({
        business_status: 'UNKNOWN',
        phone_status: 'DISCONNECTED',
        last_verified_at: '2026-02-20T00:00:00Z',
      }),
      NOW,
    );
    expect(result.verdict).toBe('BLOCKED');
    expect(result.evidence.filter((e) => e.supports === 'negative').length).toBeGreaterThanOrEqual(2);
  });

  it('rule 2 does NOT fire when the stale signal is merely missing (null last_verified_at)', () => {
    const result = evaluateSupplier(
      null,
      place({ business_status: 'UNKNOWN', phone_status: 'DISCONNECTED', last_verified_at: null }),
      NOW,
    );
    expect(result.verdict).not.toBe('BLOCKED');
  });

  it('rule 3: identity says operating + place unconfirmed/stale -> CONFLICTING', () => {
    const result = evaluateSupplier(
      identity(),
      place({ business_status: 'UNKNOWN', last_verified_at: null, phone_status: 'UNKNOWN' }),
      NOW,
    );
    expect(result.verdict).toBe('CONFLICTING');
  });

  it('rule 4: operational place, unresolvable identity -> NEEDS_CONFIRMATION, never BLOCKED', () => {
    // The spec's required case: no identity signals, operational recently-verified place.
    const result = evaluateSupplier(null, place(), NOW);
    expect(result.verdict).toBe('NEEDS_CONFIRMATION');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('rule 5: operational + identity resolved + fresh verification -> VERIFIED', () => {
    const result = evaluateSupplier(identity(), place(), NOW);
    expect(result.verdict).toBe('VERIFIED');
    expect(result.evidence.some((e) => e.supports === 'positive')).toBe(true);
  });

  it('missing data alone never yields BLOCKED (no signals at all)', () => {
    const result = evaluateSupplier(null, null, NOW);
    expect(result.verdict).toBe('NEEDS_CONFIRMATION');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('no job postings / no press / no funding is not evidence of closure', () => {
    // Identity resolves but has zero activity signals; place is fine.
    const result = evaluateSupplier(identity({ last_activity_signal: null }), place(), NOW);
    expect(result.verdict).toBe('VERIFIED');
  });

  it('every verdict carries non-empty evidence', () => {
    const cases: Array<[Supplier['identity'], PlaceInfo | null]> = [
      [identity(), place()],
      [null, place()],
      [identity(), null],
      [null, null],
      [identity(), place({ business_status: 'CLOSED_PERMANENTLY' })],
    ];
    for (const [i, p] of cases) {
      expect(evaluateSupplier(i, p, NOW).evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('evaluateDestination', () => {
  it('operational + fresh + phone -> VERIFIED', () => {
    const result = evaluateDestination(place(), NOW);
    expect(result.verdict).toBe('VERIFIED');
  });

  it('CLOSED_PERMANENTLY -> BLOCKED', () => {
    const result = evaluateDestination(place({ business_status: 'CLOSED_PERMANENTLY' }), NOW);
    expect(result.verdict).toBe('BLOCKED');
  });

  it('unresolvable place -> NEEDS_CONFIRMATION, not BLOCKED', () => {
    const result = evaluateDestination(null, NOW);
    expect(result.verdict).toBe('NEEDS_CONFIRMATION');
  });
});
