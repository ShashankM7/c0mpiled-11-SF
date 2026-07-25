import assert from "node:assert/strict";
import test from "node:test";
import {
  LAST_DEMO_STEP,
  activeProcureState,
  approvalPolicy,
  canonicalRequest,
  demoReducer,
  freightQuote,
  initialDemoState,
  landedCost,
  runStep,
} from "../lib/procure-demo.ts";

test("approval policy respects spend boundaries", () => {
  assert.deepEqual(approvalPolicy(99_999, "VERIFIED").requiredRoles, [
    "requester",
  ]);
  assert.deepEqual(approvalPolicy(100_000, "VERIFIED").requiredRoles, [
    "manager",
  ]);
  assert.deepEqual(approvalPolicy(500_000, "VERIFIED").requiredRoles, [
    "manager",
  ]);
  assert.deepEqual(approvalPolicy(500_001, "VERIFIED").requiredRoles, [
    "manager",
    "controller",
  ]);
});

test("supplier uncertainty adds authority while blocked remains a hard stop", () => {
  assert.deepEqual(
    approvalPolicy(250_000, "NEEDS_CONFIRMATION").requiredRoles,
    ["manager", "controller"],
  );
  assert.deepEqual(
    approvalPolicy(600_000, "CONFLICTING").requiredRoles,
    ["manager", "controller"],
  );
  assert.equal(approvalPolicy(600_000, "BLOCKED").blocked, true);
  assert.match(
    approvalPolicy(600_000, "BLOCKED").reason,
    /never reach approved-ready/i,
  );
});

test("ten-step replay preserves the sole rejection loop and readiness gate", () => {
  const states = Array.from({ length: LAST_DEMO_STEP }, (_, index) =>
    activeProcureState(index + 1),
  );
  assert.deepEqual(states, [
    "PARSED",
    "SOURCED",
    "VERIFYING",
    "SOURCED",
    "VERIFYING",
    "QUOTED",
    "AWAITING_APPROVAL",
    "AWAITING_APPROVAL",
    "AWAITING_APPROVAL",
    "APPROVED_READY",
  ]);
  assert.equal(activeProcureState(0), null);
});

test("playback starts, pauses, advances once, and replays with a new run id", () => {
  const started = demoReducer(initialDemoState, { type: "START" });
  assert.deepEqual(started, {
    launched: true,
    playing: true,
    step: 1,
    runId: 1,
  });

  const paused = demoReducer(started, { type: "PAUSE" });
  assert.equal(paused.playing, false);
  const advanced = demoReducer(paused, { type: "NEXT" });
  assert.equal(advanced.step, 2);
  assert.equal(advanced.playing, false);

  const replayed = demoReducer(advanced, { type: "REPLAY" });
  assert.equal(replayed.step, 1);
  assert.equal(replayed.playing, true);
  assert.equal(replayed.runId, 2);
});

test("canonical landed-cost arithmetic is exact integer-cent math", () => {
  assert.equal(40 * 12_400, 496_000);
  assert.equal(freightQuote.cost_cents, 74_000);
  assert.equal(
    landedCost.product_cents + landedCost.freight_cents,
    landedCost.total_cents,
  );
  assert.equal(landedCost.total_cents, 570_000);
  assert.equal(
    canonicalRequest.budget_max_cents - landedCost.total_cents,
    80_000,
  );
  assert.equal(landedCost.parcel_savings_cents, 31_000);
  assert.equal(landedCost.under_budget, true);
});

test("fixture mode is immediate and never invokes a live adapter", async () => {
  let called = false;
  const result = await runStep(
    async () => {
      called = true;
      return "live";
    },
    "fixture",
  );

  assert.equal(called, false);
  assert.equal(result.data, "fixture");
  assert.equal(result.source, "fixture");
  assert.equal(result.fallback_reason, "fixture_mode");
});

test("runStep returns live results and falls back on errors", async () => {
  const live = await runStep(async () => "live", "fixture", { mode: "live" });
  assert.equal(live.data, "live");
  assert.equal(live.source, "live");

  const fallback = await runStep(
    async () => {
      throw new Error("integration down");
    },
    "fixture",
    { mode: "live" },
  );
  assert.equal(fallback.data, "fixture");
  assert.equal(fallback.fallback_reason, "error");
});

test("runStep aborts a timed-out live adapter and returns its fixture", async () => {
  let aborted = false;
  const result = await runStep(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve("late");
        });
      }),
    "fixture",
    { mode: "live", timeoutMs: 8 },
  );

  assert.equal(aborted, true);
  assert.equal(result.data, "fixture");
  assert.equal(result.source, "fixture");
  assert.equal(result.fallback_reason, "timeout");
});

