import type {
  ApprovalChain,
  AuditEntry,
  CallOutcome,
  DestinationCheck,
  FreightQuote,
  LandedCost,
  Org,
  ProcurementRequest,
  ProductOption,
  RunEvent,
  RunRecord,
  Supplier,
  User,
} from '../types.js';

/**
 * Persistence boundary. The only implementation today is in-memory with a JSON
 * snapshot (store/memory.ts). Swapping in SQLite later means implementing this
 * interface in one new file — route and orchestrator code never sees storage
 * details.
 */
export interface Store {
  putOrg(org: Org): Promise<void>;
  getOrg(id: string): Promise<Org | null>;

  putUser(user: User): Promise<void>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  listOrgUsers(orgId: string): Promise<User[]>;

  putRequest(request: ProcurementRequest): Promise<void>;
  getRequest(id: string): Promise<ProcurementRequest | null>;
  listRequests(orgId: string): Promise<ProcurementRequest[]>;

  putOptions(requestId: string, options: ProductOption[]): Promise<void>;
  getOptions(requestId: string): Promise<ProductOption[]>;

  putSupplier(requestId: string, supplier: Supplier): Promise<void>;
  getSuppliers(requestId: string): Promise<Supplier[]>;

  putDestinationCheck(check: DestinationCheck): Promise<void>;
  getDestinationCheck(requestId: string): Promise<DestinationCheck | null>;

  putFreightQuote(quote: FreightQuote): Promise<void>;
  getFreightQuote(requestId: string): Promise<FreightQuote | null>;

  putLandedCost(requestId: string, landedCost: LandedCost): Promise<void>;
  getLandedCost(requestId: string): Promise<LandedCost | null>;

  putApprovalChain(chain: ApprovalChain): Promise<void>;
  getApprovalChain(requestId: string): Promise<ApprovalChain | null>;

  putCallOutcome(outcome: CallOutcome): Promise<void>;
  listCallOutcomes(requestId: string): Promise<CallOutcome[]>;

  putRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRunsForRequest(requestId: string): Promise<RunRecord[]>;

  /** Assigns the next monotonic per-run seq (starting at 1) and persists. */
  appendEvent(event: Omit<RunEvent, 'seq'>): Promise<RunEvent>;
  listEvents(runId: string, afterSeq?: number): Promise<RunEvent[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(requestId: string): Promise<AuditEntry[]>;
}
