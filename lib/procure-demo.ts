export type ProcureState =
  | "PARSED"
  | "SOURCED"
  | "VERIFYING"
  | "QUOTED"
  | "AWAITING_APPROVAL"
  | "APPROVED_READY"
  | "BLOCKED";

export type SupplierVerdict =
  | "VERIFIED"
  | "NEEDS_CONFIRMATION"
  | "CONFLICTING"
  | "BLOCKED";

export type ApprovalRole =
  | "requester"
  | "manager"
  | "controller"
  | "ap_clerk";

export interface Request {
  id: string;
  raw_text: string;
  org_id: string;
  requester_id: string;
  item: string;
  quantity: number;
  deadline: string;
  delivery_address: string;
  budget_max_cents: number;
  state: ProcureState;
}

export interface ProductOption {
  id: string;
  title: string;
  merchant_name: string;
  merchant_domain: string;
  unit_price_cents: number;
  qty_available: number;
  lead_time_days: number;
  buy_url: string;
  image_url?: string;
  label: "LOWEST_PRICE" | "FASTEST" | "BEST_LANDED";
}

export interface Evidence {
  source: "CrustData" | "VOYGR";
  claim: string;
  value: string;
}

export interface Supplier {
  merchant_name: string;
  domain: string;
  crustdata: {
    legal_name: string;
    employees: number | null;
    founded: number | null;
    last_signal: string;
  };
  voygr: {
    place_id: string;
    address: string;
    business_status: string;
    hours: string;
    phone: string;
    last_seen: string;
  };
  verdict: SupplierVerdict;
  evidence: Evidence[];
}

export interface FreightQuote {
  mode: "LTL_PALLET";
  pallets: number;
  dest_zip: string;
  cost_cents: number;
  transit_days: number;
  delivery_date: string;
}

export interface LandedCost {
  product_cents: number;
  freight_cents: number;
  total_cents: number;
  budget_cents: number;
  remaining_cents: number;
  parcel_savings_cents: number;
  under_budget: boolean;
}

export interface Approval {
  user: string;
  role: ApprovalRole;
  decision: "DENIED" | "APPROVED";
  at: string;
}

export interface ApprovalChain {
  tier: string;
  required_roles: ApprovalRole[];
  approvals: Approval[];
  status: "PENDING" | "PARTIAL" | "APPROVED";
}

export interface CallOutcome {
  to: string;
  purpose: string;
  confirmed_slot: string;
  summary: string;
  recording_url: string;
}

export interface StepResult<T> {
  data: T;
  source: "live" | "fixture";
  fallback_reason?: "fixture_mode" | "timeout" | "error";
  elapsed_ms: number;
}

export interface PolicyResult {
  blocked: boolean;
  requiredRoles: ApprovalRole[];
  reason: string;
}

export interface DemoMachineState {
  launched: boolean;
  playing: boolean;
  step: number;
  runId: number;
}

export type DemoAction =
  | { type: "START" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "NEXT" }
  | { type: "REPLAY" }
  | { type: "RESET" };

export const LAST_DEMO_STEP = 10;
export const STEP_DELAYS_MS = [
  0, 2600, 2600, 3400, 2500, 2800, 2600, 2500, 2400, 2600, 3400,
] as const;

export const initialDemoState: DemoMachineState = {
  launched: false,
  playing: false,
  step: 0,
  runId: 0,
};

export function demoReducer(
  state: DemoMachineState,
  action: DemoAction,
): DemoMachineState {
  switch (action.type) {
    case "START":
      return {
        launched: true,
        playing: true,
        step: 1,
        runId: state.runId + 1,
      };
    case "PLAY":
      if (!state.launched || state.step >= LAST_DEMO_STEP) {
        return {
          launched: true,
          playing: true,
          step: 1,
          runId: state.runId + 1,
        };
      }
      return { ...state, playing: true };
    case "PAUSE":
      return { ...state, playing: false };
    case "NEXT": {
      const nextStep = Math.min(state.step + 1, LAST_DEMO_STEP);
      return {
        launched: true,
        playing: nextStep === LAST_DEMO_STEP ? false : state.playing,
        step: nextStep,
        runId: state.runId,
      };
    }
    case "REPLAY":
      return {
        launched: true,
        playing: true,
        step: 1,
        runId: state.runId + 1,
      };
    case "RESET":
      return initialDemoState;
    default:
      return state;
  }
}

export function activeProcureState(step: number): ProcureState | null {
  if (step <= 0) return null;
  if (step === 1) return "PARSED";
  if (step === 2 || step === 4) return "SOURCED";
  if (step === 3 || step === 5) return "VERIFYING";
  if (step === 6) return "QUOTED";
  if (step >= 7 && step <= 9) return "AWAITING_APPROVAL";
  return "APPROVED_READY";
}

export function approvalPolicy(
  totalCents: number,
  verdict: SupplierVerdict,
): PolicyResult {
  let requiredRoles: ApprovalRole[];

  if (totalCents < 100_000) {
    requiredRoles = ["requester"];
  } else if (totalCents <= 500_000) {
    requiredRoles = ["manager"];
  } else {
    requiredRoles = ["manager", "controller"];
  }

  if (verdict === "BLOCKED") {
    return {
      blocked: true,
      requiredRoles,
      reason: "Blocked suppliers can never reach approved-ready.",
    };
  }

  if (verdict !== "VERIFIED" && !requiredRoles.includes("controller")) {
    requiredRoles = [...requiredRoles, "controller"];
  }

  return {
    blocked: false,
    requiredRoles,
    reason:
      verdict === "VERIFIED"
        ? "Spend tier determines the approval chain."
        : "Supplier uncertainty adds controller review.",
  };
}

export async function runStep<T>(
  live: (signal: AbortSignal) => Promise<T>,
  fixture: T,
  options: { mode?: "live" | "fixture"; timeoutMs?: number } = {},
): Promise<StepResult<T>> {
  const mode = options.mode ?? "fixture";
  const timeoutMs = options.timeoutMs ?? 4_000;
  const startedAt = Date.now();

  if (mode === "fixture") {
    return {
      data: fixture,
      source: "fixture",
      fallback_reason: "fixture_mode",
      elapsed_ms: Date.now() - startedAt,
    };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("step_timeout"));
        controller.abort();
      }, timeoutMs);
    });
    const data = await Promise.race([live(controller.signal), timeout]);
    return {
      data,
      source: "live",
      elapsed_ms: Date.now() - startedAt,
    };
  } catch {
    return {
      data: fixture,
      source: "fixture",
      fallback_reason: timedOut ? "timeout" : "error",
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export const canonicalRequest: Request = {
  id: "run_0001",
  raw_text:
    "We need 40 stackable commercial chairs for our Oakland restaurant by Thursday. Keep the whole job under sixty-five hundred dollars.",
  org_id: "demo_oakland_hospitality",
  requester_id: "dana_requester",
  item: "Stackable commercial chairs",
  quantity: 40,
  deadline: "2026-07-30",
  delivery_address: "Demo Restaurant · Oakland, CA",
  budget_max_cents: 650_000,
  state: "PARSED",
};

export const productOptions: ProductOption[] = [
  {
    id: "option_axis",
    title: "Axis Stack Chair",
    merchant_name: "Bayline Contract · Demo",
    merchant_domain: "demo.invalid",
    unit_price_cents: 11_800,
    qty_available: 64,
    lead_time_days: 5,
    buy_url: "#fixture",
    label: "LOWEST_PRICE",
  },
  {
    id: "option_dash",
    title: "Dash Commercial Chair",
    merchant_name: "RapidSeat Supply · Demo",
    merchant_domain: "demo.invalid",
    unit_price_cents: 12_900,
    qty_available: 48,
    lead_time_days: 2,
    buy_url: "#fixture",
    label: "FASTEST",
  },
  {
    id: "option_arc",
    title: "Arc One Contract Chair",
    merchant_name: "Westbridge Seating · Demo",
    merchant_domain: "demo.invalid",
    unit_price_cents: 12_400,
    qty_available: 86,
    lead_time_days: 3,
    buy_url: "#fixture",
    label: "BEST_LANDED",
  },
];

export const blockedSupplier: Supplier = {
  merchant_name: "Bayline Contract · Demo",
  domain: "demo.invalid",
  crustdata: {
    legal_name: "Demo fixture — not a real business",
    employees: null,
    founded: null,
    last_signal: "No current company signal",
  },
  voygr: {
    place_id: "fixture_blocked_supplier",
    address: "Address unconfirmed since March",
    business_status: "UNCONFIRMED",
    hours: "Unavailable",
    phone: "Disconnected",
    last_seen: "2026-03-14",
  },
  verdict: "BLOCKED",
  evidence: [
    {
      source: "VOYGR",
      claim: "Address",
      value: "Unconfirmed since March",
    },
    { source: "VOYGR", claim: "Phone", value: "Disconnected" },
  ],
};

export const verifiedSupplier: Supplier = {
  merchant_name: "Westbridge Seating · Demo",
  domain: "demo.invalid",
  crustdata: {
    legal_name: "Demo fixture — not a real business",
    employees: 41,
    founded: 2012,
    last_signal: "Current company activity signal",
  },
  voygr: {
    place_id: "fixture_verified_supplier",
    address: "Commercial district · Demo fixture",
    business_status: "OPERATIONAL",
    hours: "Open · 8 AM–5 PM",
    phone: "Working business line",
    last_seen: "2026-07-24",
  },
  verdict: "VERIFIED",
  evidence: [
    {
      source: "CrustData",
      claim: "Company",
      value: "Active · 41 employees",
    },
    { source: "VOYGR", claim: "Place", value: "Open · hours confirmed" },
    { source: "VOYGR", claim: "Phone", value: "Working business line" },
  ],
};

export const destinationSupplier: Supplier = {
  merchant_name: "Demo Restaurant · Destination",
  domain: "demo.invalid",
  crustdata: {
    legal_name: "Demo fixture — not a real business",
    employees: null,
    founded: null,
    last_signal: "Destination check only",
  },
  voygr: {
    place_id: "fixture_verified_destination",
    address: "Oakland, CA",
    business_status: "OPERATIONAL",
    hours: "Open · dock contact available",
    phone: "Working dock line",
    last_seen: "2026-07-24",
  },
  verdict: "VERIFIED",
  evidence: [
    { source: "VOYGR", claim: "Business", value: "Open" },
    { source: "VOYGR", claim: "Dock", value: "Phone confirmed" },
  ],
};

export const freightQuote: FreightQuote = {
  mode: "LTL_PALLET",
  pallets: 3,
  dest_zip: "94607",
  cost_cents: 74_000,
  transit_days: 2,
  delivery_date: "2026-07-30",
};

export const landedCost: LandedCost = {
  product_cents: 496_000,
  freight_cents: freightQuote.cost_cents,
  total_cents: 570_000,
  budget_cents: canonicalRequest.budget_max_cents,
  remaining_cents: 80_000,
  parcel_savings_cents: 31_000,
  under_budget: true,
};

export const approvalChain: ApprovalChain = {
  tier: "Over $5,000",
  required_roles: ["manager", "controller"],
  approvals: [
    {
      user: "Alex",
      role: "ap_clerk",
      decision: "DENIED",
      at: "10:03:18",
    },
    {
      user: "Marcus",
      role: "manager",
      decision: "APPROVED",
      at: "10:03:42",
    },
    {
      user: "Priya",
      role: "controller",
      decision: "APPROVED",
      at: "10:04:09",
    },
  ],
  status: "APPROVED",
};

export const callOutcome: CallOutcome = {
  to: "Demo Restaurant dock",
  purpose: "Confirm Thursday receiving window",
  confirmed_slot: "Thursday · 10:00 AM–12:00 PM",
  summary: "Dock contact confirmed a two-hour receiving window.",
  recording_url: "#fixture",
};
