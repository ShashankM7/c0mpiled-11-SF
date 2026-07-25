/**
 * ProcureOS shared domain types.
 *
 * This file is the frontend contract. Everything here is exported and stable;
 * a separate frontend repo imports these types directly (see API.md).
 *
 * Invariant: all monetary values are integer cents. Field names end in _cents.
 */

export type Role = 'requester' | 'manager' | 'controller' | 'ap_clerk';

export type RequestState =
  | 'DRAFT' | 'PARSED' | 'SOURCING' | 'SOURCED' | 'VERIFYING'
  | 'QUOTED' | 'AWAITING_APPROVAL' | 'APPROVED_READY_TO_PLACE' | 'BLOCKED' | 'FAILED';

export type Verdict = 'VERIFIED' | 'NEEDS_CONFIRMATION' | 'CONFLICTING' | 'BLOCKED';

export interface Evidence {
  source: 'crustdata' | 'voygr' | 'channel3' | 'callwright' | 'human';
  claim: string;          // "business_status"
  value: string;          // "address unconfirmed since 2026-03-11"
  observed_at: string;    // ISO
  supports: 'positive' | 'negative' | 'neutral';
}

export interface ProcurementRequest {
  id: string;
  org_id: string;
  requester_id: string;
  raw_text: string;
  item_description: string | null;
  quantity: number | null;
  deadline: string | null;              // ISO date
  delivery_address: string | null;
  budget_max_cents: number | null;
  state: RequestState;
  selected_option_id: string | null;
  rejected_supplier_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ProductOption {
  id: string;
  request_id: string;
  title: string;
  merchant_name: string;
  merchant_domain: string;
  unit_price_cents: number;
  quantity_available: number | null;
  lead_time_days: number | null;
  buy_url: string;
  image_url: string | null;
  label: 'LOWEST_PRICE' | 'FASTEST' | 'BEST_LANDED_VALUE' | null;
  extended_price_cents: number;         // unit * requested quantity
}

export interface Supplier {
  id: string;
  merchant_name: string;
  merchant_domain: string;
  identity: {                            // crustdata-derived, all nullable
    legal_name: string | null;
    employee_count: number | null;
    founded_year: number | null;
    last_activity_signal: string | null;
  } | null;
  place: {                               // voygr-derived, all nullable
    place_id: string | null;
    formatted_address: string | null;
    business_status: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'UNKNOWN';
    phone: string | null;
    hours_known: boolean;
    last_verified_at: string | null;
  } | null;
  verdict: Verdict;
  evidence: Evidence[];
}

export interface DestinationCheck {
  request_id: string;
  address_input: string;
  resolved_address: string | null;
  business_status: Supplier['place'] extends null ? never : 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' | 'UNKNOWN';
  receiving_phone: string | null;
  verdict: Verdict;
  evidence: Evidence[];
}

export interface FreightQuote {
  id: string;
  request_id: string;
  mode: 'LTL_PALLET' | 'PARCEL';
  pallets: number;
  destination_zip: string;
  cost_cents: number;
  transit_days: number;
  estimated_delivery: string;            // ISO date
  meets_deadline: boolean;
  retail_parcel_baseline_cents: number | null;   // for the savings line
}

export interface LandedCost {
  product_cents: number;
  freight_cents: number;
  total_cents: number;
  budget_cents: number | null;
  remaining_cents: number | null;
  under_budget: boolean;
  savings_vs_parcel_cents: number | null;
}

export interface ApprovalDecision {
  id: string;
  user_id: string;
  role: Role;
  decision: 'APPROVED' | 'DENIED' | 'BLOCKED_BY_POLICY';
  reason: string | null;
  at: string;
}

export interface ApprovalChain {
  request_id: string;
  tier: 'SELF' | 'MANAGER' | 'MANAGER_AND_CONTROLLER' | 'CONTROLLER_ESCALATED';
  required_roles: Role[];
  satisfied_roles: Role[];
  decisions: ApprovalDecision[];
  status: 'PENDING' | 'PARTIAL' | 'APPROVED' | 'DENIED';
  escalation_reason: string | null;      // e.g. "supplier verdict NEEDS_CONFIRMATION"
}

export interface CallOutcome {
  id: string;
  request_id: string;
  to_number: string;
  purpose: 'CONFIRM_DELIVERY_WINDOW' | 'CONFIRM_INVENTORY' | 'REQUEST_QUOTE';
  confirmed_window: string | null;
  summary: string;
  recording_url: string | null;
  succeeded: boolean;
}

export interface AdapterTelemetry {
  adapter: string;
  live: boolean;                         // false => fixture served
  fell_back: boolean;                    // true => live attempted and failed
  duration_ms: number;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Additive types (not modifications of the contract above)            */
/* ------------------------------------------------------------------ */

/** The non-null shape of Supplier['place']. */
export type PlaceRecord = NonNullable<Supplier['place']>;

export type PhoneStatus = 'ACTIVE' | 'DISCONNECTED' | 'UNKNOWN';

/**
 * Normalized VOYGR output. Superset of Supplier['place']: phone_status is the
 * affirmative disconnected-phone signal verification needs (a missing phone is
 * never treated as evidence of closure).
 */
export interface PlaceInfo extends PlaceRecord {
  phone_status: PhoneStatus;
}

export interface Org {
  id: string;
  name: string;
}

export interface User {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: Role;
}

export type RunStatus = 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'BLOCKED' | 'FAILED';

export interface RunRecord {
  id: string;
  request_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
}

export type RunEventType =
  | 'run.started'
  | 'request.parsed'
  | 'sourcing.started'
  | 'sourcing.completed'
  | 'options.relabeled'
  | 'supplier.evaluated'
  | 'supplier.rejected'
  | 'destination.verified'
  | 'freight.quoted'
  | 'cost.computed'
  | 'approval.required'
  | 'approval.recorded'
  | 'call.started'
  | 'call.completed'
  | 'state.changed'
  | 'run.blocked'
  | 'run.completed'
  | 'run.failed';

/** Event envelope — identical on the SSE stream and the persisted run log. */
export interface RunEvent {
  seq: number;                           // monotonic per run, starts at 1
  run_id: string;
  request_id: string;
  type: RunEventType;
  at: string;                            // ISO
  payload: unknown;
  telemetry: AdapterTelemetry | null;
}

/** Append-only audit log entry for every state transition. */
export interface AuditEntry {
  request_id: string;
  from: RequestState;
  to: RequestState;
  cause: string;
  actor: string;                         // user id or 'system'
  at: string;
}

/** Fields the parser extracts from raw_text. */
export interface ParsedFields {
  item_description: string | null;
  quantity: number | null;
  deadline: string | null;               // ISO date
  delivery_address: string | null;
  budget_max_cents: number | null;
}
