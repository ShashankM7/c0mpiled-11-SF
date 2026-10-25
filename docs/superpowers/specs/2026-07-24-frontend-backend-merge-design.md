# ProcureOS — Merging the Frontend and Backend Into One Repo

**Date:** 2026-07-24
**Status:** Approved design, ready for implementation planning

## Problem

ProcureOS exists as two halves that have never met.

The **frontend** lives on the local `claude` branch: a cinematic Next.js/vinext
app served by a Cloudflare Worker and deployed to ChatGPT Apps hosting. It makes
zero network calls. The entire run is a hardcoded scripted replay — static
consts in `lib/procure-demo.ts` revealed by a step counter that a timer advances
through `STEP_DELAYS_MS`.

The **backend** lives on `origin/main`: Fastify with a real orchestrator,
Server-Sent Events, vendor adapters, server-side RBAC, and tests. Its README
says outright that the repo is backend-only and that the HTTP + SSE contract for
a separate frontend lives in `API.md`.

Both descend from root commit `cf93fc1`, which contained only a README. Their
trees are disjoint except for five files. Nothing connects them.

## Goal

One repository where a single command brings up both halves on localhost and
the frontend drives the real backend — while the scripted replay survives as a
fallback that cannot fail.

**Localhost is the target environment.** Public deployment is explicitly out of
scope for this spec; see [Deferred](#deferred).

## Key insight

Every element the demo renders is gated on `machine.step >= N` for a monotonic
counter from 1 to 10, against static fixture consts. The UI is a pure function
of `(step, data)`.

Live integration therefore needs only two things:

1. Advance that same step counter from real events, on the same cadence.
2. Replace the static consts with live data **of the same shape**.

No component restructuring. No new rendering path.

## Architecture

### Repository layout

```
c0mpiled-11-SF/
  package.json               npm workspaces + concurrently; dev/test/build both halves
  README.md                  merged product README linking both apps
  docs/superpowers/specs/
  apps/
    api/                     origin/main, moved verbatim
      src/ fixtures/ scripts/ tests/
      package.json tsconfig.json tsconfig.build.json .env.example API.md
    web/                     local frontend, moved verbatim
      app/ lib/ public/ worker/ build/ db/ drizzle/ examples/ tests/
      package.json vite.config.ts next.config.ts tsconfig.json
      postcss.config.mjs eslint.config.mjs drizzle.config.ts
      .openai/hosting.json
```

`.openai/hosting.json` must move with the frontend: `vite.config.ts` imports it
by relative path (`./.openai/hosting.json`) and reads `d1`/`r2` out of it to
build the Cloudflare binding config. The two files are already coupled and stay
adjacent.

Root `package.json` declares `workspaces: ["apps/*"]` and owns only
orchestration scripts. Neither app's own scripts change meaning.

| Root script | Behavior |
|---|---|
| `npm run dev` | `concurrently` runs `apps/api` (`tsx watch`, port 8787) and `apps/web` (`vinext dev`) |
| `npm test` | both suites in sequence — api `vitest run`, web `node --test` |
| `npm run build` | both builds |
| `npm run dev:api` / `dev:web` | each half alone |

`concurrently` is the single new root devDependency.

### One shape, not two

The frontend's fixture types are **renamed onto the backend's contract**, and
`apps/api/src/types.ts` becomes the single source of truth. `apps/web` imports
it through a TypeScript path alias with `import type` only, so the reference is
erased at build time and creates no runtime or bundling coupling between a
Node/Fastify package and a Workers bundle.

Divergences to reconcile, all in the frontend's favor of the backend's names:

| Frontend today | Backend contract |
|---|---|
| `ProductOption.label: "BEST_LANDED"` | `"BEST_LANDED_VALUE"` |
| state `"APPROVED_READY"` | `"APPROVED_READY_TO_PLACE"` |
| (no draft state) | adds `"DRAFT"` |
| `FreightQuote.dest_zip` | `destination_zip` |
| `FreightQuote.delivery_date` | `estimated_delivery` (plus `meets_deadline`, `retail_parcel_baseline_cents`) |
| `LandedCost.parcel_savings_cents` | `savings_vs_parcel_cents` |
| `ApprovalChain.approvals[]` with `user` | `decisions[]` with `user_id`, `role`, `decision`, `reason`, `at` |
| `Approval.decision: "APPROVED" \| "DENIED"` | adds `"BLOCKED_BY_POLICY"` |
| `CallOutcome.to` / `confirmed_slot` | `to_number` / `confirmed_window` |
| `Evidence.source: "CrustData" \| "VOYGR"` | `"crustdata"` \| `"voygr"`, plus `observed_at` and `supports` |
| `Supplier` with nested `crustdata` / `voygr` objects | flat `Supplier` carrying `verdict` + `evidence[]` |
| `Request.item` | `item_description` |

The alternative — a translation layer mapping backend names to the frontend's —
was rejected. It leaves two shapes alive forever, and it means the fixture path
never exercises the code the live path uses. Renaming makes fixture and live
render through byte-identical component code, which is the only thing that makes
the fallback trustworthy.

The existing fixture consts are rewritten into backend shapes. They are static
data; this is mechanical.

### New modules in `apps/web`

**`lib/api-client.ts`** — one function per endpoint in `API.md`: `login`,
`createRequest`, `startRun`, `getAggregate`, `approve`, `placeCall`, `getSkill`,
`health`. Holds a token per seeded user, since the approval sequence needs three
identities (Alex, Marcus, Priya). Every call is same-origin `/api/*`.

**`lib/event-pacer.ts`** — decouples event arrival from step advancement. Real
SSE events in fixture mode arrive in single-digit milliseconds; released
unpaced, the entire run would flash past in under a second and read as broken.
The pacer accepts events into a queue and releases them on the existing
`STEP_DELAYS_MS` cadence:

- Events arriving faster than the cadence queue and wait their turn.
- A step whose event has not yet arrived holds on the current stage in its
  `--active` visual state rather than advancing to a stage with no data.

**`lib/live-source.ts`** — maps the backend's 18 event types onto the 10 demo
steps and accumulates a data snapshot in the shared shapes.

| Step | Triggering event(s) |
|---|---|
| 1 | `request.parsed` |
| 2 | `sourcing.completed`, `options.relabeled` |
| 3 | `supplier.evaluated` — first, verdict `BLOCKED` (BulkChairs Depot) |
| 4 | `supplier.rejected` + `state.changed` (`VERIFYING` → `SOURCED`) |
| 5 | `supplier.evaluated` — second, verdict `VERIFIED`; `destination.verified` |
| 6 | `freight.quoted`, `cost.computed` |
| 7 | `approval.required`; `approval.recorded` for ap_clerk (`BLOCKED_BY_POLICY`) |
| 8 | `approval.recorded` — manager, chain `PARTIAL` |
| 9 | `approval.recorded` — controller, chain `APPROVED` |
| 10 | `call.completed` |

`run.completed` does **not** advance a step. The backend emits it the moment the
chain fully approves — before the outbound call is placed — so it arrives at
step 9's boundary. It sets the request's final state
(`APPROVED_READY_TO_PLACE`) on the snapshot and nothing more.

A step advances when the **last** event listed for it has arrived. Event types
not listed in the table (`run.started`, `sourcing.started`, `call.started`, and
`state.changed` transitions other than the re-sourcing edge) update the data
snapshot and telemetry but never advance the step counter.

Steps 7 through 9 are driven by the frontend: the run reaches
`AWAITING_APPROVAL` and stops, then the client posts the three approval attempts
in order (Alex is expected to receive `403 ROLE_NOT_PERMITTED` — that denial is
part of the demo, not an error). Step 10 posts the single outbound call.

`run.blocked` and `run.failed` are terminal and route to the fallback below.

**`worker/index.ts`** (edit) — requests to `/api/*` are forwarded to
`env.API_BASE_URL`, preserving method, headers, and body. The upstream response
body is passed through as a stream (`new Response(upstream.body, …)`) so SSE is
never buffered. `API_BASE_URL` is added to `localBindingConfig.vars` in
`vite.config.ts`, defaulting to `http://127.0.0.1:8787`.

This is why the frontend calls same-origin `/api/*` rather than an absolute
backend URL: no CORS, no mixed content, and one env var to repoint. The worker
runs in dev as well as production — `@cloudflare/vite-plugin` is configured with
`main: "./worker/index.ts"` — so the same proxy path serves `npm run dev`.

If workerd's outbound fetch to a loopback address proves unreliable under
Miniflare, the documented fallback is a Vite `server.proxy` entry for `/api`.
This must be verified during implementation before the rest of the wiring is
built on it.

### Mode selection and fallback

On load, the app probes `GET /api/health` with a short timeout. Reachable →
live. Unreachable → scripted replay. `?mode=fixture` and `?mode=live` force
either. The existing `?autoplay=1` continues to work in both.

If a live run fails, stalls, or emits `run.blocked` / `run.failed`, a banner
appears and the scripted replay resumes **from the current step**.

For that resume to be coherent rather than a jump cut, the two data sets must
agree. **Today they do not.** The frontend's fixtures use anonymized placeholder
vendors (`Bayline Contract · Demo`, `Westbridge Seating · Demo`,
`demo.invalid`, `#fixture` buy links) while the backend's fixtures use the
canonical run (`BulkChairs Depot`, `SeatCraft Commercial`,
`Rapid Restaurant Supply`, 1234 Broadway). Several numbers differ too — third
option `12_900` vs `13_900`, parcel savings `31_000` vs `54_000`, transit 2 days
vs 3, zip `94607` vs `94612`, delivery `2026-07-30` vs `2026-07-28`. Only the
landed-cost arithmetic already matches (`496_000 + 74_000 = 570_000`, remaining
`80_000`).

Making the two agree is therefore explicit implementation work, not a property
that holds for free: the frontend's fixture consts are **replaced** with the
backend's canonical fixture values as part of the type-unification work. Note
that this drops the deliberate "clearly labeled fixture data" anonymization in
favor of the backend's realistic names; the existing on-screen fixture-mode
disclaimer stays and carries that message instead.

## Testing

Both existing suites keep running unchanged in their new locations — `apps/api`
on vitest, `apps/web` on `node --test`. Root `npm test` runs both.

New coverage:

- Worker proxy: `/api/*` routes upstream, non-API paths still reach the app
  handler, and an SSE response streams through without buffering.
- Event pacer: ordering preserved when events arrive faster than the cadence;
  no premature step advance when an event is late.
- Live source: fed the backend's own `fixtures/` JSON, produces the expected
  step progression and data snapshot.
- Mode selection: unreachable health probe falls back to scripted; mid-run
  failure resumes the scripted replay at the current step.
- Type unification: the frontend's fixture consts satisfy the backend's
  `src/types.ts` (a compile-time assertion, so drift breaks the build).

## Git strategy

1. Merge `origin/main` into `claude`. Only five files conflict:

   | File | Resolution |
   |---|---|
   | `package.json` | becomes the workspaces manifest; both originals move into their apps |
   | `package-lock.json` | regenerated once from the workspace root |
   | `tsconfig.json` | each app keeps its own; root gets a minimal one for path aliases |
   | `README.md` | merged product README linking `apps/api/API.md` and both quickstarts |
   | `.gitignore` | union of both, plus `.data/` from the backend |

2. Restructure into `apps/*` as follow-up commits on `claude`.
3. Wire the integration.
4. PR into `main`.

Both histories are preserved.

## Non-goals

- **No checkout or payment.** The backend's terminal state remains an approved
  order record with buy links. Nothing here changes that.
- **No changes to backend domain logic.** Verification rules, approval policy,
  and landed-cost arithmetic are already tested and stay as they are.
- **No visual redesign.** The cinematic frontend's layout, CSS, and choreography
  are preserved; only its data source and type names change.
- **No live vendor API keys.** Fixture mode is the demo path end to end.

## Deferred

- **Public deployment.** `API_BASE_URL` points at a public backend and the
  ChatGPT Apps deploy runs from `apps/web` rather than the repo root. Whether
  that tooling tolerates a non-root project directory is unverified; if it does
  not, the fallback is the alternate layout (frontend at root, backend under
  `backend/`). This must be checked before any deploy attempt, but it does not
  block localhost work.
- **Persistent storage.** The backend snapshots to `.data/state.json`; the
  documented SQLite swap-in point is the single file `src/store/memory.ts`.
- **Inbound Phonely webhook in the UI.** The endpoint exists and creates a
  request with an auto-started run; the frontend has no view for it.
