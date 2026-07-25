# ProcureOS Backend — HTTP + SSE Contract

Base URL (dev): `http://localhost:8787`

- All responses are JSON except `GET /api/requests/:id/skill` (`text/yaml`) and the SSE stream.
- All errors: `{ "error": { "code", "message", "reason?", "details?" } }` with correct status codes.
- All money is **integer cents**; field names end in `_cents`. No floats anywhere.
- Auth is a bearer token issued by `POST /api/auth/login`. Pass `Authorization: Bearer <token>`, or `?token=<token>` for `EventSource` (which cannot set headers).
- Authorization is **server-side only**. The approval route derives the role from the session; any role a client sends in a body is ignored.
- CORS is wide open (`origin: true`) — connect the frontend from any origin.

## Shared TypeScript types

Import the domain types straight from this repo — `src/types.ts` is the frontend contract:

```ts
import type {
  ProcurementRequest, ProductOption, Supplier, DestinationCheck,
  FreightQuote, LandedCost, ApprovalChain, ApprovalDecision, CallOutcome,
  Evidence, Verdict, Role, RequestState, RunEvent, RunEventType,
  AdapterTelemetry, RunRecord, AuditEntry, User, Org,
} from '<path-to-backend>/src/types.js';
```

All examples below are copied from an actual fixture run.

---

## Endpoints

### `GET /api/health`

```bash
curl http://localhost:8787/api/health
```

```json
{
  "ok": true,
  "demo_mode": "fixture",
  "adapters": {
    "channel3": "fixture",
    "crustdata": "fixture",
    "voygr": "fixture",
    "oway": "fixture",
    "callwright": "fixture",
    "phonely": "fixture"
  }
}
```

### `POST /api/auth/login`

Dev-simple login: email only, no password. Users are seeded (see `GET /api/org/users`).

```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"dana@northgate.test"}'
```

```json
{
  "token": "eyJ1c2VyX2lkIjoidXNyX2RhbmEifQ.pbzS8Sy39hrelUmH0UewsMnv_fwHf6Y1ebm7Sg9ZF5M",
  "user": {
    "id": "usr_dana",
    "org_id": "org_northgate",
    "name": "Dana Whitfield",
    "email": "dana@northgate.test",
    "role": "requester"
  }
}
```

### `GET /api/me`

```bash
curl http://localhost:8787/api/me -H "authorization: Bearer $TOKEN"
```

```json
{
  "user": { "id": "usr_dana", "org_id": "org_northgate", "name": "Dana Whitfield", "email": "dana@northgate.test", "role": "requester" },
  "org": { "id": "org_northgate", "name": "Northgate Restaurant Group" }
}
```

### `GET /api/org/users`

The four seeded users — the frontend needs this for role switching.

```bash
curl http://localhost:8787/api/org/users -H "authorization: Bearer $TOKEN"
```

```json
{
  "users": [
    { "id": "usr_dana",   "org_id": "org_northgate", "name": "Dana Whitfield", "email": "dana@northgate.test",   "role": "requester" },
    { "id": "usr_marcus", "org_id": "org_northgate", "name": "Marcus Rivera",  "email": "marcus@northgate.test", "role": "manager" },
    { "id": "usr_priya",  "org_id": "org_northgate", "name": "Priya Raman",    "email": "priya@northgate.test",  "role": "controller" },
    { "id": "usr_alex",   "org_id": "org_northgate", "name": "Alex Boone",     "email": "alex@northgate.test",   "role": "ap_clerk" }
  ]
}
```

### `POST /api/requests` → 201

`delivery_address` and `budget_max_cents` are optional; explicit values win over parsed values.

```bash
curl -X POST http://localhost:8787/api/requests \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"raw_text":"40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500"}'
```

```json
{
  "id": "req_7c868b9c-46c2-46c5-9aa8-fb7188747b76",
  "org_id": "org_northgate",
  "requester_id": "usr_dana",
  "raw_text": "40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500",
  "item_description": null,
  "quantity": null,
  "deadline": null,
  "delivery_address": null,
  "budget_max_cents": null,
  "state": "DRAFT",
  "selected_option_id": null,
  "rejected_supplier_ids": [],
  "created_at": "2026-07-25T04:39:41.037Z",
  "updated_at": "2026-07-25T04:39:41.037Z"
}
```

### `GET /api/requests`

```bash
curl http://localhost:8787/api/requests -H "authorization: Bearer $TOKEN"
```

Returns `{ "requests": ProcurementRequest[] }` for the caller's org.

### `POST /api/requests/:id/run` → 202

Starts the orchestrated pipeline asynchronously. Body optional: `{ "now": "2026-07-25T17:00:00.000Z" }` pins the clock for deterministic replays (relative deadlines like "Thursday" resolve against it). Request must be in `DRAFT` (else `409 INVALID_STATE`).

```bash
curl -X POST http://localhost:8787/api/requests/$REQ/run \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

```json
{ "run_id": "run_fe9403fd-d764-41cd-8aa4-921ed926725a" }
```

### `GET /api/requests/:id` — the full aggregate

One call the frontend can render an entire page from: request, options, suppliers (with verdicts + evidence), destination check, freight quote, landed cost, approval chain, call outcomes, audit log, runs.

```bash
curl http://localhost:8787/api/requests/$REQ -H "authorization: Bearer $TOKEN"
```

Abridged real response (full field sets match `src/types.ts`):

```json
{
  "request": {
    "id": "req_7c868b9c-46c2-46c5-9aa8-fb7188747b76",
    "item_description": "stackable commercial chairs",
    "quantity": 40,
    "deadline": "2026-07-30",
    "delivery_address": "1234 Broadway, Oakland CA",
    "budget_max_cents": 650000,
    "state": "APPROVED_READY_TO_PLACE",
    "selected_option_id": "449fb3e9-4cd4-484a-9270-c449f1d7470b",
    "rejected_supplier_ids": ["sup_522a7ab1-452b-4296-afe5-e1f8c1e00e21"]
  },
  "options": [
    { "merchant_name": "BulkChairs Depot", "unit_price_cents": 11800, "extended_price_cents": 472000, "label": "LOWEST_PRICE", "buy_url": "https://bulkchairsdepot.com/p/econostack-commercial-black" },
    { "merchant_name": "SeatCraft Commercial", "unit_price_cents": 12400, "extended_price_cents": 496000, "label": "BEST_LANDED_VALUE", "buy_url": "https://seatcraft-commercial.com/products/pro-series-stackable-banquet" },
    { "merchant_name": "Rapid Restaurant Supply", "unit_price_cents": 13900, "extended_price_cents": 556000, "label": "FASTEST", "buy_url": "https://rapidrestaurantsupply.com/item/rapidstack-contract-grade" }
  ],
  "suppliers": [
    {
      "id": "sup_522a7ab1-452b-4296-afe5-e1f8c1e00e21",
      "merchant_name": "BulkChairs Depot",
      "verdict": "BLOCKED",
      "evidence": [
        { "source": "voygr", "claim": "phone_status", "value": "listed phone +15105550142 is disconnected", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "negative" },
        { "source": "voygr", "claim": "last_verified_at", "value": "address unconfirmed since 2026-02-20", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "negative" }
      ]
    },
    {
      "id": "sup_46308276-4758-48ae-893a-87019bd0ad50",
      "merchant_name": "SeatCraft Commercial",
      "verdict": "VERIFIED",
      "evidence": [
        { "source": "voygr", "claim": "business_status", "value": "OPERATIONAL", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "positive" },
        { "source": "crustdata", "claim": "activity_signal", "value": "2026-06-30 press release: opened second Bay Area distribution center", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "positive" },
        { "source": "voygr", "claim": "last_verified_at", "value": "place verified on 2026-07-20", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "positive" }
      ]
    }
  ],
  "destination_check": {
    "address_input": "1234 Broadway, Oakland CA",
    "resolved_address": "1234 Broadway, Oakland, CA 94612",
    "business_status": "OPERATIONAL",
    "receiving_phone": "+15105550123",
    "verdict": "VERIFIED",
    "evidence": [ { "source": "voygr", "claim": "business_status", "value": "OPERATIONAL", "observed_at": "2026-07-25T17:00:00.000Z", "supports": "positive" } ]
  },
  "freight_quote": {
    "mode": "LTL_PALLET", "pallets": 3, "destination_zip": "94612",
    "cost_cents": 74000, "transit_days": 3, "estimated_delivery": "2026-07-28",
    "meets_deadline": true, "retail_parcel_baseline_cents": 128000
  },
  "landed_cost": {
    "product_cents": 496000, "freight_cents": 74000, "total_cents": 570000,
    "budget_cents": 650000, "remaining_cents": 80000, "under_budget": true,
    "savings_vs_parcel_cents": 54000
  },
  "approval_chain": {
    "tier": "MANAGER_AND_CONTROLLER",
    "required_roles": ["manager", "controller"],
    "satisfied_roles": ["manager", "controller"],
    "status": "APPROVED",
    "escalation_reason": null,
    "decisions": [
      { "user_id": "usr_alex", "role": "ap_clerk", "decision": "BLOCKED_BY_POLICY", "reason": "role ap_clerk is not in required_roles [manager, controller]", "at": "2026-07-25T04:39:41.044Z" },
      { "user_id": "usr_marcus", "role": "manager", "decision": "APPROVED", "reason": null, "at": "2026-07-25T04:39:41.044Z" },
      { "user_id": "usr_priya", "role": "controller", "decision": "APPROVED", "reason": null, "at": "2026-07-25T04:39:41.045Z" }
    ]
  },
  "call_outcomes": [
    { "to_number": "+15105550123", "purpose": "CONFIRM_DELIVERY_WINDOW", "confirmed_window": "Thursday 2026-07-30, 08:00–11:00 PT", "succeeded": true }
  ],
  "audit_log": [
    { "from": "VERIFYING", "to": "SOURCED", "cause": "supplier BulkChairs Depot rejected — re-sourcing", "actor": "usr_dana", "at": "2026-07-25T04:39:41.041Z" }
  ],
  "runs": [ { "id": "run_fe9403fd-d764-41cd-8aa4-921ed926725a", "status": "COMPLETED" } ],
  "latest_run_id": "run_fe9403fd-d764-41cd-8aa4-921ed926725a"
}
```

### `GET /api/runs/:id`

Run status + all persisted events: `{ "run": RunRecord, "events": RunEvent[] }`.

### `GET /api/runs/:id/events` — SSE

Server-Sent Events stream of the run. Supports `?after_seq=N` replay; emits a heartbeat comment every 15 s. Wire format per event:

```
id: 9
event: supplier.evaluated
data: {"seq":9,"run_id":"run_fe94…","request_id":"req_7c86…","type":"supplier.evaluated","at":"…","payload":{…},"telemetry":null}
```

```js
const es = new EventSource(`${BASE}/api/runs/${runId}/events?token=${token}&after_seq=0`);
es.addEventListener('state.changed', (e) => render(JSON.parse(e.data)));
```

### `POST /api/requests/:id/approvals` — the security boundary

Body: `{ "decision": "APPROVED" | "DENIED", "reason?": string }`. The role comes from the session, never the body.

- Selected supplier `BLOCKED` → `409` `{ error: { reason: "SUPPLIER_BLOCKED" } }` — such a request can never reach `APPROVED_READY_TO_PLACE`.
- Role not in `required_roles` → the attempt is **recorded** in the chain as `BLOCKED_BY_POLICY` (audit trail), then `403`:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "your role is not permitted to approve this request",
    "reason": "ROLE_NOT_PERMITTED",
    "details": { "required_roles": ["manager", "controller"], "your_role": "ap_clerk" }
  }
}
```

- Permitted approval → 200 with the updated chain. `status` becomes `APPROVED` only when `required_roles ⊆ satisfied_roles`, else `PARTIAL`:

```json
{
  "chain": {
    "request_id": "req_7c868b9c-46c2-46c5-9aa8-fb7188747b76",
    "tier": "MANAGER_AND_CONTROLLER",
    "required_roles": ["manager", "controller"],
    "satisfied_roles": ["manager"],
    "status": "PARTIAL",
    "escalation_reason": null,
    "decisions": [
      { "user_id": "usr_alex", "role": "ap_clerk", "decision": "BLOCKED_BY_POLICY", "reason": "role ap_clerk is not in required_roles [manager, controller]", "at": "2026-07-25T04:39:41.044Z" },
      { "user_id": "usr_marcus", "role": "manager", "decision": "APPROVED", "reason": null, "at": "2026-07-25T04:39:41.044Z" }
    ]
  },
  "request_state": "AWAITING_APPROVAL"
}
```

- On full approval the request transitions to `APPROVED_READY_TO_PLACE` and `run.completed` is emitted. **No checkout or payment ever happens.**
- Idempotent: the same user approving twice returns 200 with the unchanged chain.
- `DENIED` by a permitted role → chain `DENIED`, request `BLOCKED`.

### `POST /api/requests/:id/call` → 201

Places the single outbound delivery-window confirmation call (to `DEMO_CALL_NUMBER` if set, else the destination's receiving phone). A second call returns `429` `{ error: { reason: "CALL_BUDGET_EXCEEDED" } }` (hard `MAX_CALLS_PER_RUN = 1`).

```json
{
  "id": "6f632db1-7793-46aa-8135-56e451f720be",
  "request_id": "req_7c868b9c-46c2-46c5-9aa8-fb7188747b76",
  "to_number": "+15105550123",
  "purpose": "CONFIRM_DELIVERY_WINDOW",
  "confirmed_window": "Thursday 2026-07-30, 08:00–11:00 PT",
  "summary": "Spoke with receiving at 1234 Broadway, Oakland. Loading dock is available Thursday morning; delivery window confirmed for 8–11 AM. Ask driver to call 30 minutes ahead.",
  "recording_url": null,
  "succeeded": true
}
```

### `POST /api/webhooks/phonely` → 202

Inbound call transcript → creates a request and auto-starts a run. If `PHONELY_WEBHOOK_SECRET` is set, the `x-phonely-signature` header must match.

```bash
curl -X POST http://localhost:8787/api/webhooks/phonely \
  -H 'content-type: application/json' \
  -d '{"call":{"from":"+15105550123","transcript":"40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500"}}'
```

```json
{ "request_id": "req_…", "run_id": "run_…", "from": "+15105550123", "telemetry": { "adapter": "phonely", "live": true, "fell_back": false, "duration_ms": 0, "error": null } }
```

### `GET /api/requests/:id/skill` → `text/yaml`

The compiled reusable skill for a completed run. `409 RUN_NOT_COMPLETED` unless the request is `APPROVED_READY_TO_PLACE`.

```yaml
skill: furnish_restaurant_seating
version: 1
learned_from: run_fe9403fd-d764-41cd-8aa4-921ed926725a
inputs:
  units: 40
  location: "1234 Broadway, Oakland CA"
  deadline: "2026-07-30"
  budget_max: 6500
constraints:
  units_per_pallet: 16
  supplier_must_be_verified: true
approval:
  required_above: 5000
  escalate_if_unverified: true
  roles: [manager, controller]
actions: [parse_request, search_products, verify_suppliers, verify_destination,
          quote_freight, compute_landed_cost, enforce_approval, confirm_delivery_window]
```

---

## SSE event catalogue

Every event — on the stream and in the persisted run log — uses the same envelope:

```json
{
  "seq": 6,
  "run_id": "run_fe9403fd-d764-41cd-8aa4-921ed926725a",
  "request_id": "req_7c868b9c-46c2-46c5-9aa8-fb7188747b76",
  "type": "sourcing.completed",
  "at": "2026-07-25T04:39:41.040Z",
  "payload": { "…": "…" },
  "telemetry": { "adapter": "channel3", "live": false, "fell_back": false, "duration_ms": 1, "error": null }
}
```

`seq` is monotonic per run starting at 1. `telemetry` is non-null on events produced by an external adapter call — render a live-vs-cached indicator per step from it (`live: false, fell_back: false` = fixture mode; `live: false, fell_back: true` = live attempted and failed; `live: true` = real vendor data).

The 18 event types and their payloads (all examples from the canonical fixture run):

| # | type | payload example |
|---|------|-----------------|
| 1 | `run.started` | `{ "request_id": "req_7c86…", "actor": "usr_dana", "now": "2026-07-25T17:00:00.000Z" }` |
| 2 | `request.parsed` | `{ "parsed": { "item_description": "stackable commercial chairs", "quantity": 40, "deadline": "2026-07-30", "delivery_address": "1234 Broadway, Oakland CA", "budget_max_cents": 650000 } }` |
| 3 | `sourcing.started` | `{ "query": "stackable commercial chairs", "quantity": 40 }` |
| 4 | `sourcing.completed` | `{ "options": [ /* 3 ProductOption rows */ ] }` + channel3 telemetry |
| 5 | `options.relabeled` | `{ "labels": [ { "option_id": "3c7e…", "label": "LOWEST_PRICE" }, { "option_id": "449f…", "label": "BEST_LANDED_VALUE" }, { "option_id": "0b7b…", "label": "FASTEST" } ] }` |
| 6 | `supplier.evaluated` | `{ "supplier": { /* Supplier with verdict + evidence[] */ }, "option_id": "3c7e…", "adapter_telemetry": [ /* crustdata, voygr AdapterTelemetry */ ] }` |
| 7 | `supplier.rejected` | `{ "supplier_id": "sup_522a…", "merchant_name": "BulkChairs Depot", "option_id": "3c7e…", "evidence": [ /* the negative rows */ ], "reason": "supplier could not be verified as a currently-operating business" }` |
| 8 | `destination.verified` | `{ "destination": { /* DestinationCheck */ } }` + voygr telemetry |
| 9 | `freight.quoted` | `{ "quote": { /* FreightQuote */ } }` + oway telemetry |
| 10 | `cost.computed` | `{ "landed_cost": { "product_cents": 496000, "freight_cents": 74000, "total_cents": 570000, "budget_cents": 650000, "remaining_cents": 80000, "under_budget": true, "savings_vs_parcel_cents": 54000 } }` |
| 11 | `approval.required` | `{ "tier": "MANAGER_AND_CONTROLLER", "required_roles": ["manager","controller"], "escalation_reason": null, "total_cents": 570000, "destination_phone": "+15105550123" }` |
| 12 | `approval.recorded` | `{ "decision": { /* ApprovalDecision (incl. BLOCKED_BY_POLICY rows) */ }, "chain_status": "PARTIAL" }` |
| 13 | `call.started` | `{ "to_number": "+15105550123", "purpose": "CONFIRM_DELIVERY_WINDOW", "actor": "usr_dana" }` |
| 14 | `call.completed` | `{ "outcome": { /* CallOutcome */ } }` + callwright telemetry |
| 15 | `state.changed` | `{ "from": "VERIFYING", "to": "SOURCED", "cause": "supplier BulkChairs Depot rejected — re-sourcing" }` |
| 16 | `run.blocked` | `{ "reason": "ALL_SUPPLIERS_BLOCKED" }` (or `"DESTINATION_CLOSED"`) |
| 17 | `run.completed` | `{ "final_state": "APPROVED_READY_TO_PLACE", "chain_status": "APPROVED" }` |
| 18 | `run.failed` | `{ "reason": "<error message>" }` |

---

## Frontend quickstart

```ts
const BASE = 'http://localhost:8787';

// 1. Log in (pick any seeded user; GET /api/org/users lists all four for role switching)
const { token } = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dana@northgate.test' }),
})).json();
const auth = { authorization: `Bearer ${token}` };

// 2. Create a request
const request = await (await fetch(`${BASE}/api/requests`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ raw_text: '40 stackable commercial chairs to 1234 Broadway, Oakland CA by Thursday, under $6,500' }),
})).json();

// 3. Start the run
const { run_id } = await (await fetch(`${BASE}/api/requests/${request.id}/run`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}',
})).json();

// 4. Subscribe to SSE (EventSource can't set headers — use ?token=)
const es = new EventSource(`${BASE}/api/runs/${run_id}/events?token=${token}`);
es.onmessage = () => {};
for (const type of ['state.changed', 'supplier.evaluated', 'supplier.rejected', 'cost.computed', 'approval.required'] as const) {
  es.addEventListener(type, (e) => console.log(type, JSON.parse((e as MessageEvent).data)));
}

// 5. Render the whole page from one aggregate call
const aggregate = await (await fetch(`${BASE}/api/requests/${request.id}`, { headers: auth })).json();

// 6. Approve (log in as marcus@northgate.test then priya@northgate.test)
await fetch(`${BASE}/api/requests/${request.id}/approvals`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'APPROVED' }),
});
```

Shared types import path: **`src/types.ts`** in this repo (compiled: `dist/types.js` + `dist/types.d.ts` after `npm run build`).
