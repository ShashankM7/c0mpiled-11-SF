import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallOutcome } from '../types.js';
import { getConfig } from '../config.js';
import { readFixture, step, type StepResult } from './step.js';

/** Hard per-run outbound call budget. A second call returns 429 CALL_BUDGET_EXCEEDED. */
export const MAX_CALLS_PER_RUN = 1;

export interface PlaceCallInput {
  to: string;
  purpose: CallOutcome['purpose'];
  context: string;
}

const RawSchema = z.object({
  call: z.object({
    status: z.string(),
    confirmed_window: z.string().nullable(),
    summary: z.string(),
    recording_url: z.string().nullable(),
  }),
});

// TODO: verify against vendor docs — shape inferred; fixture is the demo's
// source of truth, CallOutcome is the internal contract.
function mapResponse(raw: unknown, input: PlaceCallInput): CallOutcome {
  const parsed = RawSchema.parse(raw);
  return {
    id: randomUUID(),
    request_id: '', // assigned by the caller
    to_number: input.to,
    purpose: input.purpose,
    confirmed_window: parsed.call.confirmed_window,
    summary: parsed.call.summary,
    recording_url: parsed.call.recording_url,
    succeeded: parsed.call.status === 'completed',
  };
}

/** One outbound call to confirm the delivery window. */
export async function placeCall(input: PlaceCallInput): Promise<StepResult<CallOutcome>> {
  const cfg = getConfig();
  const adapter = cfg.adapters.callwright;
  let raw: unknown = null;
  return step({
    adapter: 'callwright',
    enabled: adapter.enabled,
    // An outbound call rings a real phone; give it more headroom than data APIs.
    timeoutMs: Math.max(cfg.adapterTimeoutMs, 30_000),
    live: async () => {
      const res = await fetch(`${adapter.baseUrl ?? 'https://api.callwright.ai'}/v1/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adapter.key ?? ''}` },
        body: JSON.stringify({ to: input.to, purpose: input.purpose, context: input.context }),
      });
      if (!res.ok) throw new Error(`callwright responded ${res.status}`);
      raw = await res.json();
      return mapResponse(raw, input);
    },
    fixture: async () => mapResponse(await readFixture('callwright.outcome.json'), input),
    capture: { slug: 'outcome', getRaw: () => raw },
  });
}
