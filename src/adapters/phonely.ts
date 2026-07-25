import { z } from 'zod';
import { readFixture, step, type StepResult } from './step.js';

export interface InboundCall {
  transcript: string;
  from: string;
}

const RawSchema = z.object({
  call: z.object({
    from: z.string(),
    transcript: z.string(),
  }),
});

// TODO: verify against vendor docs — webhook payload shape inferred; the
// fixture transcript is the demo's source of truth.
function mapResponse(raw: unknown): InboundCall {
  const parsed = RawSchema.parse(raw);
  return { transcript: parsed.call.transcript, from: parsed.call.from };
}

/**
 * Inbound call webhook payload -> transcript. Malformed payloads fall back to
 * the fixture transcript so the webhook can never crash a run.
 */
export async function parseInbound(payload: unknown): Promise<StepResult<InboundCall>> {
  return step({
    adapter: 'phonely',
    // "live" here is parsing the caller-supplied payload; a malformed payload
    // falls back to the fixture with fell_back: true.
    enabled: payload !== null && payload !== undefined,
    live: async () => mapResponse(payload),
    fixture: async () => mapResponse(await readFixture('phonely.transcript.json')),
  });
}
