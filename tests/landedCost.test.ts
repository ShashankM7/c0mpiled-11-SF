import { describe, expect, it } from 'vitest';
import { computeLandedCost } from '../src/domain/landedCost.js';

describe('computeLandedCost', () => {
  it('computes the canonical demo numbers exactly', () => {
    const result = computeLandedCost({
      product_cents: 496_000,
      freight_cents: 74_000,
      budget_cents: 650_000,
      retail_parcel_baseline_cents: 128_000,
    });
    expect(result.total_cents).toBe(570_000);
    expect(result.remaining_cents).toBe(80_000);
    expect(result.under_budget).toBe(true);
    expect(result.savings_vs_parcel_cents).toBe(54_000);
  });

  it('over budget flips under_budget and goes negative on remaining', () => {
    const result = computeLandedCost({
      product_cents: 640_000,
      freight_cents: 74_000,
      budget_cents: 650_000,
      retail_parcel_baseline_cents: null,
    });
    expect(result.under_budget).toBe(false);
    expect(result.remaining_cents).toBe(-64_000);
    expect(result.savings_vs_parcel_cents).toBeNull();
  });

  it('null budget: remaining null, no budget constraint', () => {
    const result = computeLandedCost({
      product_cents: 100,
      freight_cents: 50,
      budget_cents: null,
      retail_parcel_baseline_cents: null,
    });
    expect(result.total_cents).toBe(150);
    expect(result.remaining_cents).toBeNull();
    expect(result.under_budget).toBe(true);
  });

  it('exactly at budget counts as under_budget', () => {
    const result = computeLandedCost({
      product_cents: 500_000,
      freight_cents: 150_000,
      budget_cents: 650_000,
      retail_parcel_baseline_cents: null,
    });
    expect(result.under_budget).toBe(true);
    expect(result.remaining_cents).toBe(0);
  });

  it('rejects non-integer cents — no floats anywhere', () => {
    expect(() =>
      computeLandedCost({
        product_cents: 4960.5,
        freight_cents: 74_000,
        budget_cents: null,
        retail_parcel_baseline_cents: null,
      }),
    ).toThrow(/integer cents/);
  });
});
