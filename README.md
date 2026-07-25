# ProcureOS

One repo, two halves:

- **Frontend** — cinematic demo UI (Next.js/vinext on a Cloudflare Worker). `npm run dev`
- **Backend** — orchestration API (Fastify + SSE) in `src/`. `npm run api:dev` (port 8787)

HTTP + SSE contract: [API.md](API.md). Shared domain types: [src/types.ts](src/types.ts).

```bash
npm install
npm run dev       # frontend
npm run api:dev   # backend on :8787
npm run demo      # headless backend pipeline, fixtures only
npm test          # frontend tests
npm run api:test  # backend tests
```

> Frontend and backend are co-located but not yet wired together; the UI still
> replays its own fixtures. See
> [docs/superpowers/specs/2026-07-24-frontend-backend-merge-design.md](docs/superpowers/specs/2026-07-24-frontend-backend-merge-design.md).

---


An AI-native procurement agent. A user submits a purchasing request in natural language —

> "40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500"

— and the backend runs one orchestrated pipeline: parse → source real products → **verify every supplier is a real, operating business** → reject and re-source anything it can't verify → verify the delivery destination → quote pallet freight → compute landed cost against budget → enforce the org's approval policy → place one outbound call to confirm the delivery window → end at `APPROVED_READY_TO_PLACE`.

**The system never executes a checkout or payment.** It produces buy links and an approved order record, full stop.

This repo is backend-only. The HTTP + SSE contract for the separate frontend is documented in [API.md](API.md); the shared domain types live in [src/types.ts](src/types.ts).

## The four organs

| Organ | What it is | Where |
|---|---|---|
| **Intent** | Natural language → structured constraints (item, qty, deadline, address, budget in integer cents) | `orchestrator/parse.ts` |
| **Truth** | Evidence-based supplier & destination verification; the rejection-and-recovery loop (`VERIFYING → SOURCED`) | `domain/verification.ts`, `orchestrator/run.ts` |
| **Authority** | Server-side approval policy — who may approve this amount from this supplier | `domain/policy.ts`, `routes/approvals.ts` |
| **Reach** | Real-world adapters: product search, enrichment, place verification, freight, outbound calling | `adapters/*` |

## Setup in three commands

```bash
npm install
npm test
npm run demo     # full pipeline on fixtures — no network, no API keys, empty .env
```

Then `npm run dev` to serve the API on `:8787`. `npm run typecheck` and `npm run build` do what they say.

## How fixture mode works

Every external call goes through **one wrapper** (`adapters/step.ts`) with a hard timeout and a fixture fallback:

- `DEMO_MODE=fixture` (or a missing API key) → the adapter's live path is never attempted; the checked-in fixture in `fixtures/` is served (`telemetry.live=false, fell_back=false`).
- `DEMO_MODE=auto` with a key present → the live call runs against the vendor; on timeout, throw, or non-2xx it **falls back to the fixture and the run continues** (`fell_back=true`, error logged, never propagated). Point every `*_BASE_URL` at `http://127.0.0.1:1` and a full run still completes — there's a test for exactly that.
- Every event carries `AdapterTelemetry` so a client can render live-vs-cached per step.

Vendor response shapes are **not** authoritative: each adapter isolates vendor parsing in one `mapResponse()` marked `// TODO: verify against vendor docs`. The normalized internal type is the contract; the fixture is the source of truth for the demo.

### Capturing real fixtures

```bash
CHANNEL3_API_KEY=… VOYGR_API_KEY=… npm run capture
```

With `CAPTURE=1` (the script sets it), each configured adapter is hit once and its raw response is written into `fixtures/`. Adapters without keys are skipped and reported in a table — never a crash.

## Approval policy

All amounts are integer cents; the total is the **landed** cost (product + freight).

| Condition | Tier | Required roles |
|---|---|---|
| supplier verdict ≠ `VERIFIED` (any amount) | `CONTROLLER_ESCALATED` | controller |
| total < $1,000 | `SELF` | requester |
| $1,000 ≤ total ≤ $5,000 | `MANAGER` | manager |
| total > $5,000 | `MANAGER_AND_CONTROLLER` | manager + controller |

The escalation rule is checked first and wins. `ap_clerk` can read and prepare but **never** approve (there's a 4-million-case sweep test). A request whose supplier verdict is `BLOCKED` can never reach `APPROVED_READY_TO_PLACE`, no matter who approves — the route returns `409 SUPPLIER_BLOCKED`. Roles come from the server-side session only; an unauthorized attempt is recorded in the chain (`BLOCKED_BY_POLICY`) and rejected with `403 ROLE_NOT_PERMITTED`.

Seeded users (org: Northgate Restaurant Group): Dana Whitfield (requester), Marcus Rivera (manager), Priya Raman (controller), Alex Boone (ap_clerk — he exists to be denied).

## Verification rules

`evaluateSupplier(identity, place, now)` is pure and returns a verdict — one of `VERIFIED | NEEDS_CONFIRMATION | CONFLICTING | BLOCKED` (no confidence percentages anywhere) — plus a non-empty `evidence[]` of `{source, claim, value, observed_at, supports}`:

1. Place marked `CLOSED_PERMANENTLY` → `BLOCKED`
2. Disconnected phone **and** verification affirmatively stale (> 120 days) → `BLOCKED`
3. Identity says operating, place unconfirmed/stale → `CONFLICTING`
4. Place operational, identity unresolvable → `NEEDS_CONFIRMATION`
5. Place operational + identity resolved + verified within 120 days → `VERIFIED`
6. Anything else → `NEEDS_CONFIRMATION`

Only **affirmative** negative evidence can block. Missing data — no job postings, no press, no funding history, a null field — is never evidence of closure.

## The demo run

`npm run demo` (fixture mode, zero network) shows the whole product:

1. Channel3 returns 3 chair options; the cheapest (BulkChairs Depot) is evaluated and **BLOCKED** — disconnected phone + address unconfirmed for ~5 months — forcing the `VERIFYING → SOURCED` re-source edge.
2. SeatCraft Commercial verifies with positive evidence and is selected. The destination at 1234 Broadway verifies as operational.
3. Oway quotes 3 pallets at $740, arriving 2026-07-28 (inside the Thursday deadline); landed cost is **$5,700 against a $6,500 budget**, saving $540 vs retail parcel.
4. $5,700 → `MANAGER_AND_CONTROLLER`. Alex (ap_clerk) is denied with a recorded 403; Marcus takes the chain to `PARTIAL`; Priya's approval lands `APPROVED_READY_TO_PLACE`.
5. One outbound call confirms the delivery window (a second attempt gets `429 CALL_BUDGET_EXCEEDED`), and the compiled skill YAML is printed.

State is an in-memory store snapshotted to `.data/state.json` (swap-in point for SQLite is the single file `src/store/memory.ts`).

## What this does not do

- **No checkout, no payments, no card handling.** The end state is an approved order record with buy links.
- **No closure inference from missing signals.** Absence of evidence never produces `BLOCKED`.
- **No client-trusted authorization.** Roles live server-side; anything a client claims about its role is ignored.
- **No invented vendor contracts presented as authoritative.** Live paths exist behind env keys, but every vendor shape is quarantined in a `mapResponse()` with a verification TODO, and fixtures drive the demo.
