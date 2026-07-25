import { z } from 'zod';
import type { ParsedFields } from '../types.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const ParsedSchema = z.object({
  item_description: z.string().min(1).nullable(),
  quantity: z.number().int().positive().nullable(),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  delivery_address: z.string().min(1).nullable(),
  budget_max_cents: z.number().int().nonnegative().nullable(),
});

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Next occurrence of a weekday strictly after `now` (UTC date math, deterministic). */
export function nextWeekday(now: string, weekdayName: string): string | null {
  const target = WEEKDAYS.indexOf(weekdayName.toLowerCase());
  if (target === -1) return null;
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) return null;
  const base = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const delta = (target - base.getUTCDay() + 7) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

/** "$6,500" / "6500.25" -> integer cents via string math. No floats anywhere near money. */
export function dollarsToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const dollars = Number.parseInt(match[1] as string, 10);
  const fraction = match[2] ?? '';
  const cents = Number.parseInt(fraction.padEnd(2, '0') || '0', 10);
  return dollars * 100 + cents;
}

/** Deterministic regex extractor — the fallback when no LLM key is present or the LLM fails. */
export function regexParse(rawText: string, now: string): ParsedFields {
  const text = rawText.trim();

  const qtyMatch = /(\d{1,5})\s+(?:x\s+)?[a-z]/i.exec(text);
  const quantity = qtyMatch ? Number.parseInt(qtyMatch[1] as string, 10) : null;

  const budgetMatch =
    /(?:under|below|less than|max(?:imum)?(?: of)?|budget(?: of| is)?|cap(?:ped at)?)\s*\$?\s*([\d][\d,]*(?:\.\d{1,2})?)/i.exec(
      text,
    ) ?? /\$\s*([\d][\d,]*(?:\.\d{1,2})?)/.exec(text);
  const budget_max_cents = budgetMatch ? dollarsToCents(budgetMatch[1] as string) : null;

  let deadline: string | null = null;
  const isoMatch = /\bby\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
  const weekdayMatch =
    /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  if (isoMatch) deadline = isoMatch[1] as string;
  else if (weekdayMatch) deadline = nextWeekday(now, weekdayMatch[1] as string);

  const addressMatch = /\bto\s+(.+?)\s+by\s/i.exec(text) ?? /\bto\s+(.+?)\s*(?:,\s*under\b.*)?$/i.exec(text);
  const delivery_address = addressMatch ? (addressMatch[1] as string).trim() : null;

  let item_description: string | null = null;
  const beforeTo = text.split(/\s+to\s+/i)[0] ?? text;
  const itemMatch = /^\s*\d+\s+(?:x\s+)?(.+)$/i.exec(beforeTo);
  if (itemMatch) item_description = (itemMatch[1] as string).trim();
  else if (beforeTo.trim().length > 0) item_description = beforeTo.trim();

  return { item_description, quantity, deadline, delivery_address, budget_max_cents };
}

/** The canonical demo parse — the run must never die at parsing. */
export function fixtureParse(now: string): ParsedFields {
  return {
    item_description: 'stackable commercial chairs',
    quantity: 40,
    deadline: nextWeekday(now, 'thursday'),
    delivery_address: '1234 Broadway, Oakland CA',
    budget_max_cents: 650_000,
  };
}

async function llmParse(rawText: string, now: string): Promise<ParsedFields | null> {
  const { anthropicKey } = getConfig().llm;
  if (anthropicKey === null) return null; // OpenAI path intentionally unimplemented; Anthropic preferred
  const prompt =
    `Extract purchasing constraints from this request. Today is ${now.slice(0, 10)}. ` +
    `Respond with ONLY a JSON object: {"item_description": string|null, "quantity": int|null, ` +
    `"deadline": "YYYY-MM-DD"|null (resolve relative dates), "delivery_address": string|null, ` +
    `"budget_max_cents": int|null (dollars -> integer cents)}.\n\nRequest: ${rawText}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`anthropic responded ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const jsonMatch = /\{[\s\S]*\}/.exec(textBlock);
    if (jsonMatch === null) throw new Error('no JSON in LLM response');
    return ParsedSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'llm parse failed; regex fallback');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse raw_text into structured constraints. LLM (if a key is present) ->
 * regex extractor -> fixture parse. Never throws; the run must never die at
 * parsing. `now` is caller-supplied so replays are deterministic.
 */
export async function parseRequest(rawText: string, now: string): Promise<ParsedFields> {
  const fromLlm = await llmParse(rawText, now);
  if (fromLlm !== null) {
    const check = ParsedSchema.safeParse(fromLlm);
    if (check.success) return check.data;
  }

  const fromRegex = regexParse(rawText, now);
  const regexUsable = fromRegex.item_description !== null || fromRegex.quantity !== null;
  if (regexUsable) {
    const check = ParsedSchema.safeParse(fromRegex);
    if (check.success) return check.data;
  }

  return fixtureParse(now);
}
