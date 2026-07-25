/**
 * npm run capture — with CAPTURE=1, hit each configured live adapter once and
 * write the raw responses into fixtures/. Adapters with missing keys are
 * skipped (never a crash). Prints a table of captured vs skipped.
 */
process.env['CAPTURE'] = '1';

const { getConfig, resetConfig } = await import('../src/config.js');
resetConfig();
const cfg = getConfig();

const { searchProducts } = await import('../src/adapters/channel3.js');
const { enrichCompany } = await import('../src/adapters/crustdata.js');
const { verifyPlace } = await import('../src/adapters/voygr.js');
const { quoteFreight } = await import('../src/adapters/oway.js');
const { placeCall } = await import('../src/adapters/callwright.js');

interface Row {
  adapter: string;
  status: 'captured' | 'skipped (no key)' | 'failed (fixture served)';
  detail: string;
}

const rows: Row[] = [];

async function attempt(
  adapter: keyof typeof cfg.adapters,
  fn: () => Promise<{ telemetry: { live: boolean; fell_back: boolean; error: string | null } }>,
): Promise<void> {
  if (!cfg.adapters[adapter].enabled) {
    rows.push({ adapter, status: 'skipped (no key)', detail: `set ${adapter.toUpperCase()}_API_KEY to capture` });
    return;
  }
  const { telemetry } = await fn();
  rows.push(
    telemetry.live
      ? { adapter, status: 'captured', detail: `fixtures/${adapter}.*.json refreshed` }
      : { adapter, status: 'failed (fixture served)', detail: telemetry.error ?? 'unknown error' },
  );
}

await attempt('channel3', () => searchProducts({ query: 'stackable commercial chairs', quantity: 40 }));
await attempt('crustdata', () => enrichCompany({ name: 'SeatCraft Commercial', domain: 'seatcraft-commercial.com' }));
await attempt('voygr', () => verifyPlace({ address: '1234 Broadway, Oakland, CA 94612' }));
await attempt('oway', () => quoteFreight({ dest_zip: '94612', pallets: 3, ready_date: new Date().toISOString().slice(0, 10) }));

if (cfg.demoCallNumber !== null) {
  await attempt('callwright', () =>
    placeCall({ to: cfg.demoCallNumber as string, purpose: 'CONFIRM_DELIVERY_WINDOW', context: 'Capture run: confirm a delivery window.' }),
  );
} else {
  rows.push({ adapter: 'callwright', status: 'skipped (no key)', detail: 'set DEMO_CALL_NUMBER (and CALLWRIGHT_API_KEY) — calls only go to the consenting number' });
}
rows.push({ adapter: 'phonely', status: 'skipped (no key)', detail: 'inbound webhook — captured from real webhook traffic, not polled' });

console.log('\ncapture results:');
const pad = (s: string, n: number): string => s.padEnd(n);
console.log(`  ${pad('adapter', 12)} ${pad('status', 26)} detail`);
for (const row of rows) {
  console.log(`  ${pad(row.adapter, 12)} ${pad(row.status, 26)} ${row.detail}`);
}
console.log('');
