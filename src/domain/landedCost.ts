import type { LandedCost } from '../types.js';

function assertIntCents(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be integer cents, got ${value}`);
  }
}

/** Pure landed-cost math. All inputs and outputs are integer cents. */
export function computeLandedCost(input: {
  product_cents: number;
  freight_cents: number;
  budget_cents: number | null;
  retail_parcel_baseline_cents: number | null;
}): LandedCost {
  const { product_cents, freight_cents, budget_cents, retail_parcel_baseline_cents } = input;
  assertIntCents('product_cents', product_cents);
  assertIntCents('freight_cents', freight_cents);
  if (budget_cents !== null) assertIntCents('budget_cents', budget_cents);
  if (retail_parcel_baseline_cents !== null) {
    assertIntCents('retail_parcel_baseline_cents', retail_parcel_baseline_cents);
  }

  const total_cents = product_cents + freight_cents;
  return {
    product_cents,
    freight_cents,
    total_cents,
    budget_cents,
    remaining_cents: budget_cents === null ? null : budget_cents - total_cents,
    under_budget: budget_cents === null ? true : total_cents <= budget_cents,
    savings_vs_parcel_cents:
      retail_parcel_baseline_cents === null ? null : retail_parcel_baseline_cents - freight_cents,
  };
}
