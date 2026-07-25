"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { FlowField } from "./FlowField";
import {
  STEP_DELAYS_MS,
  LAST_DEMO_STEP,
  activeProcureState,
  blockedSupplier,
  callOutcome,
  canonicalRequest,
  demoReducer,
  destinationSupplier,
  formatMoney,
  freightQuote,
  initialDemoState,
  landedCost,
  productOptions,
  verifiedSupplier,
  type ProcureState,
} from "../lib/procure-demo";

const timelineStates: ProcureState[] = [
  "PARSED",
  "SOURCED",
  "VERIFYING",
  "QUOTED",
  "AWAITING_APPROVAL",
  "APPROVED_READY",
];

const stateLabels: Record<ProcureState, string> = {
  PARSED: "Parsed",
  SOURCED: "Sourced",
  VERIFYING: "Verifying",
  QUOTED: "Quoted",
  AWAITING_APPROVAL: "Approval",
  APPROVED_READY: "Ready",
  BLOCKED: "Blocked",
};

const labelCopy = {
  LOWEST_PRICE: "Lowest price",
  FASTEST: "Fastest",
  BEST_LANDED: "Best landed",
} as const;

function stageClass(step: number, startsAt: number, completesAt: number) {
  if (step < startsAt) return "stage-card stage-card--queued";
  if (step < completesAt) return "stage-card stage-card--active";
  return "stage-card stage-card--complete";
}

function StatusPill({
  tone,
  children,
}: {
  tone: "teal" | "amber" | "violet" | "red" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span className="status-pill" data-tone={tone}>
      <span className="status-pill__dot" />
      {children}
    </span>
  );
}

function StageHeading({
  number,
  eyebrow,
  title,
  status,
}: {
  number: string;
  eyebrow: string;
  title: string;
  status: React.ReactNode;
}) {
  return (
    <header className="stage-heading">
      <div className="stage-heading__index">{number}</div>
      <div>
        <p className="stage-heading__eyebrow">{eyebrow}</p>
        <h3>{title}</h3>
      </div>
      <div className="stage-heading__status">{status}</div>
    </header>
  );
}

export function ProcureDemo() {
  const [machine, dispatch] = useReducer(demoReducer, initialDemoState);
  const [transcriptProgress, setTranscriptProgress] = useState({
    runId: 0,
    length: 0,
  });
  const consoleRef = useRef<HTMLElement>(null);
  const currentState = activeProcureState(machine.step);
  const displayState = currentState ?? "PARSED";

  const prefersReducedMotion = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const focusConsole = useCallback(() => {
    window.setTimeout(() => {
      consoleRef.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }, 520);
  }, [prefersReducedMotion]);

  const startDemo = useCallback(() => {
    dispatch({ type: "START" });
    focusConsole();
  }, [focusConsole]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("autoplay") === "1") {
      dispatch({ type: "START" });
      focusConsole();
    }
  }, [focusConsole]);

  useEffect(() => {
    if (!machine.playing || machine.step >= LAST_DEMO_STEP) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "NEXT" });
    }, STEP_DELAYS_MS[machine.step] ?? 2600);
    return () => window.clearTimeout(timer);
  }, [machine.playing, machine.step]);

  useEffect(() => {
    if (machine.step !== 1) return;

    const interval = window.setInterval(() => {
      setTranscriptProgress((current) => {
        const currentLength =
          current.runId === machine.runId ? current.length : 0;
        if (currentLength >= canonicalRequest.raw_text.length) {
          window.clearInterval(interval);
          return current;
        }
        return {
          runId: machine.runId,
          length: Math.min(
            currentLength + 3,
            canonicalRequest.raw_text.length,
          ),
        };
      });
    }, 36);
    return () => window.clearInterval(interval);
  }, [machine.runId, machine.step]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      { threshold: 0.12 },
    );
    const revealNodes = document.querySelectorAll("[data-reveal]");
    revealNodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [machine.launched]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName)
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        dispatch({ type: machine.playing ? "PAUSE" : "PLAY" });
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        dispatch({ type: "NEXT" });
      } else if (event.key.toLowerCase() === "r" && machine.launched) {
        dispatch({ type: "REPLAY" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [machine.launched, machine.playing]);

  const statusAnnouncement = useMemo(() => {
    if (!machine.launched) return "ProcureOS is ready to run.";
    if (machine.step === 3) {
      return "Supplier blocked. Returning to sourcing.";
    }
    if (machine.step === LAST_DEMO_STEP) {
      return "Approved and ready. Dock window confirmed.";
    }
    return `Run step ${machine.step} of ${LAST_DEMO_STEP}. ${stateLabels[displayState]}.`;
  }, [displayState, machine.launched, machine.step]);

  const timelineIndex = currentState ? timelineStates.indexOf(currentState) : -1;
  const isComplete = machine.step >= LAST_DEMO_STEP;
  const transcriptLength =
    machine.step < 1
      ? 0
      : machine.step > 1
        ? canonicalRequest.raw_text.length
        : transcriptProgress.runId === machine.runId
          ? transcriptProgress.length
          : 0;
  const transcript = canonicalRequest.raw_text.slice(0, transcriptLength);

  return (
    <div className={`procure-site ${machine.launched ? "is-launched" : ""}`}>
      <FlowField />
      <div className="noise-layer" aria-hidden="true" />

      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="ProcureOS home">
          <span className="wordmark__mark">P</span>
          <span className="wordmark__name">PROCURE</span>
          <span className="wordmark__slash">/</span>
          <span className="wordmark__os">OS</span>
        </a>

        <nav className="site-nav" aria-label="Primary navigation">
          <a href="#system">System</a>
          <a href="#evidence">Evidence</a>
          <a href="#authority">Authority</a>
        </nav>

        <div className="site-header__right">
          <StatusPill tone="violet">Fixture replay</StatusPill>
          <button
            className="header-run"
            type="button"
            onClick={machine.launched ? () => dispatch({ type: "REPLAY" }) : startDemo}
          >
            {machine.launched ? "Replay run" : "Run ProcureOS"}
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__orbit hero__orbit--one" aria-hidden="true" />
          <div className="hero__orbit hero__orbit--two" aria-hidden="true" />
          <div className="hero__content">
            <p className="hero__eyebrow" aria-label="The agentic purchasing department">
              {"THE AGENTIC PURCHASING DEPARTMENT".split("").map((character, index) => (
                <span key={`${character}-${index}`} style={{ "--char": index } as React.CSSProperties}>
                  {character === " " ? "\u00A0" : character}
                </span>
              ))}
            </p>
            <h1 id="hero-title">
              <span className="hero__line">
                <span className="hero__word">From request</span>
                <span className="hero__word">to ready—</span>
              </span>
              <span className="hero__line">
                <em className="hero__accent hero__word">with proof</em>
                <span className="hero__word">at every step.</span>
              </span>
            </h1>
            <p className="hero__summary">
              Give ProcureOS intent and spending authority. It sources, verifies,
              prices, and returns an approved, execution-ready outcome.
            </p>
            <div className="hero__actions">
              <button className="forge-button" type="button" onClick={startDemo}>
                <span>Run ProcureOS</span>
                <span className="forge-button__arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
              <a className="ghost-button" href="#system">
                Inspect the system
              </a>
            </div>
          </div>

          <div className="organ-rail" aria-label="ProcureOS operating model">
            {[
              ["01", "Intent", "Parse the need"],
              ["02", "Truth", "Verify the world"],
              ["03", "Authority", "Enforce the spend"],
              ["04", "Reach", "Complete the action"],
            ].map(([number, name, description]) => (
              <div className="organ-rail__item" key={name}>
                <span>{number}</span>
                <strong>{name}</strong>
                <small>{description}</small>
              </div>
            ))}
          </div>
          <div className="hero__scroll" aria-hidden="true">
            <span>Scroll to inspect</span>
            <i />
          </div>
        </section>

        <section className="system" id="system" ref={consoleRef} aria-labelledby="system-title">
          <div className="section-intro" data-reveal>
            <div>
              <p className="section-eyebrow">RUN_0001 · OAKLAND, CA</p>
              <h2 id="system-title">
                A purchasing department,
                <br />
                <em>running as an agent.</em>
              </h2>
            </div>
            <p>
              One request moves through intent, supplier truth, landed cost, and
              enforced authority. When truth fails, the system loops—notifies,
              re-sources, and proves why.
            </p>
          </div>

          <div className="run-console" data-reveal>
            <div className="run-console__topbar">
              <div className="run-id">
                <span className="run-id__pulse" data-playing={machine.playing} />
                <div>
                  <small>ACTIVE PROCEDURE</small>
                  <strong>furnish_restaurant_seating</strong>
                </div>
              </div>

              <div className="run-controls" aria-label="Demo controls">
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: machine.playing ? "PAUSE" : "PLAY" })
                  }
                  disabled={!machine.launched}
                >
                  <span aria-hidden="true">{machine.playing ? "Ⅱ" : "▶"}</span>
                  {machine.playing ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "NEXT" })}
                  disabled={!machine.launched || isComplete}
                >
                  <span aria-hidden="true">→</span>
                  Next
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "REPLAY" })}
                  disabled={!machine.launched}
                >
                  <span aria-hidden="true">↻</span>
                  Replay
                </button>
              </div>
            </div>

            <div
              className="state-map"
              aria-label={
                currentState
                  ? `Current state: ${stateLabels[currentState]}`
                  : "Run has not started"
              }
            >
              {timelineStates.map((state, index) => {
                const reached = index <= timelineIndex;
                const active = state === currentState;
                return (
                  <div
                    className="state-map__node"
                    data-reached={reached}
                    data-active={active}
                    key={state}
                  >
                    <span className="state-map__number">
                      {reached && !active ? "✓" : String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{stateLabels[state]}</span>
                  </div>
                );
              })}
              <div className="state-map__loop" data-visible={machine.step === 3 || machine.step === 4}>
                <span>supplier rejected</span>
                <strong>↶ re-source</strong>
              </div>
            </div>

            <div className="bento-grid">
              <article className={`${stageClass(machine.step, 1, 2)} stage-card--request`}>
                <StageHeading
                  number="01"
                  eyebrow="Intent"
                  title="Request"
                  status={
                    machine.step < 1 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : (
                      <StatusPill tone="violet">Parsed</StatusPill>
                    )
                  }
                />
                <div className="transcript">
                  <p className={machine.step === 1 ? "is-typing" : ""}>
                    “{transcript}
                    {machine.step === 1 && transcriptLength < canonicalRequest.raw_text.length ? (
                      <span className="typing-caret" aria-hidden="true" />
                    ) : (
                      "”"
                    )}
                  </p>
                  <div className="transcript__source">
                    <span className="waveform" aria-hidden="true">
                      {Array.from({ length: 18 }, (_, index) => (
                        <i key={index} style={{ "--bar": index } as React.CSSProperties} />
                      ))}
                    </span>
                    <small>VOICE INTAKE · FIXTURE</small>
                  </div>
                </div>
                <dl className="request-fields">
                  <div>
                    <dt>Item</dt>
                    <dd>{machine.step >= 1 ? canonicalRequest.item : "—"}</dd>
                  </div>
                  <div>
                    <dt>Quantity</dt>
                    <dd>{machine.step >= 1 ? canonicalRequest.quantity : "—"}</dd>
                  </div>
                  <div>
                    <dt>Deadline</dt>
                    <dd>{machine.step >= 1 ? "Thu · Jul 30" : "—"}</dd>
                  </div>
                  <div>
                    <dt>Budget</dt>
                    <dd>
                      {machine.step >= 1
                        ? formatMoney(canonicalRequest.budget_max_cents)
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </article>

              <article className={`${stageClass(machine.step, 2, 5)} stage-card--sourcing`}>
                <StageHeading
                  number="02"
                  eyebrow="Product truth"
                  title="Sourcing"
                  status={
                    machine.step < 2 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : (
                      <StatusPill tone="teal">3 options</StatusPill>
                    )
                  }
                />
                <div className="product-options">
                  {productOptions.map((option, index) => {
                    const selected = option.label === "BEST_LANDED" && machine.step >= 4;
                    const rejected = index === 0 && machine.step >= 3;
                    return (
                      <div
                        className="product-option"
                        data-selected={selected}
                        data-rejected={rejected}
                        key={option.id}
                      >
                        <div className="product-option__label">
                          {machine.step >= 2 ? labelCopy[option.label] : "Waiting"}
                        </div>
                        <div className="chair-mark" aria-hidden="true">
                          <span />
                          <i />
                        </div>
                        <strong>{machine.step >= 2 ? option.title : "Sourcing option"}</strong>
                        <small>{machine.step >= 2 ? option.merchant_name : "—"}</small>
                        <div className="product-option__meta">
                          <b>
                            {machine.step >= 2
                              ? `${formatMoney(option.unit_price_cents)}/u`
                              : "—"}
                          </b>
                          <span>
                            {machine.step >= 2
                              ? `${option.lead_time_days}d lead`
                              : "—"}
                          </span>
                        </div>
                        {rejected && <span className="product-option__strike">Blocked</span>}
                        {selected && <span className="product-option__selected">Selected</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="fixture-note">
                  Demo vendors and products are clearly labeled fixture data.
                </p>
              </article>

              <article
                className={`${stageClass(machine.step, 3, 6)} stage-card--verification`}
                id="evidence"
              >
                <StageHeading
                  number="03"
                  eyebrow="Supplier truth"
                  title="Verification"
                  status={
                    machine.step < 3 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : machine.step < 5 ? (
                      <StatusPill tone="red">Re-sourcing</StatusPill>
                    ) : (
                      <StatusPill tone="teal">Verified</StatusPill>
                    )
                  }
                />
                <div className="verification-stack">
                  <div className="verification-row verification-row--blocked" data-visible={machine.step >= 3}>
                    <div className="verification-row__identity">
                      <span className="verdict-symbol">×</span>
                      <div>
                        <strong>{blockedSupplier.merchant_name}</strong>
                        <small>Candidate supplier A</small>
                      </div>
                    </div>
                    <div className="evidence-list">
                      {blockedSupplier.evidence.map((item) => (
                        <div key={`${item.source}-${item.claim}`}>
                          <span>{item.source}</span>
                          <b>{item.claim}</b>
                          <em>{item.value}</em>
                        </div>
                      ))}
                    </div>
                    <StatusPill tone="red">Blocked</StatusPill>
                  </div>

                  <div className="rejection-loop" data-visible={machine.step >= 3}>
                    <span className="rejection-loop__line" />
                    <p>
                      <strong>Truth changed authority.</strong>
                      ProcureOS refused the supplier and reopened sourcing.
                    </p>
                    <span>VERIFYING ↶ SOURCED</span>
                  </div>

                  <div className="verification-row verification-row--verified" data-visible={machine.step >= 5}>
                    <div className="verification-row__identity">
                      <span className="verdict-symbol">✓</span>
                      <div>
                        <strong>{verifiedSupplier.merchant_name}</strong>
                        <small>Replacement supplier B</small>
                      </div>
                    </div>
                    <div className="evidence-list">
                      {verifiedSupplier.evidence.slice(0, 2).map((item) => (
                        <div key={`${item.source}-${item.claim}`}>
                          <span>{item.source}</span>
                          <b>{item.claim}</b>
                          <em>{item.value}</em>
                        </div>
                      ))}
                    </div>
                    <StatusPill tone="teal">Verified</StatusPill>
                  </div>

                  <div className="destination-check" data-visible={machine.step >= 5}>
                    <span className="destination-check__mark">⌖</span>
                    <div>
                      <small>DESTINATION CHECK</small>
                      <strong>{destinationSupplier.merchant_name}</strong>
                    </div>
                    <p>Business open · dock phone confirmed</p>
                    <StatusPill tone="teal">Verified</StatusPill>
                  </div>
                </div>
              </article>

              <article className={`${stageClass(machine.step, 6, 7)} stage-card--cost`}>
                <StageHeading
                  number="04"
                  eyebrow="Landed value"
                  title="Landed cost"
                  status={
                    machine.step < 6 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : (
                      <StatusPill tone="teal">Under budget</StatusPill>
                    )
                  }
                />
                <div className="cost-total">
                  <span>Total landed</span>
                  <strong>{machine.step >= 6 ? formatMoney(landedCost.total_cents) : "—"}</strong>
                  <small>
                    {machine.step >= 6
                      ? `${formatMoney(landedCost.remaining_cents)} remaining`
                      : "Waiting for freight quote"}
                  </small>
                </div>
                <div className="budget-meter">
                  <div className="budget-meter__bar">
                    <span style={{ width: machine.step >= 6 ? "87.7%" : "0%" }} />
                  </div>
                  <div>
                    <span>$0</span>
                    <b>{formatMoney(landedCost.budget_cents)} budget</b>
                  </div>
                </div>
                <dl className="cost-breakdown">
                  <div>
                    <dt>Product</dt>
                    <dd>{machine.step >= 6 ? formatMoney(landedCost.product_cents) : "—"}</dd>
                  </div>
                  <div>
                    <dt>{freightQuote.pallets} pallets · {freightQuote.transit_days}d</dt>
                    <dd>{machine.step >= 6 ? formatMoney(landedCost.freight_cents) : "—"}</dd>
                  </div>
                  <div className="cost-breakdown__saving">
                    <dt>vs. retail parcel</dt>
                    <dd>
                      {machine.step >= 6
                        ? `${formatMoney(landedCost.parcel_savings_cents)} saved`
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </article>

              <article
                className={`${stageClass(machine.step, 7, 10)} stage-card--authority`}
                id="authority"
              >
                <StageHeading
                  number="05"
                  eyebrow="Spend authority"
                  title="Approval chain"
                  status={
                    machine.step < 7 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : machine.step < 9 ? (
                      <StatusPill tone="amber">Partial</StatusPill>
                    ) : (
                      <StatusPill tone="teal">Approved</StatusPill>
                    )
                  }
                />
                <div className="policy-banner">
                  <div>
                    <small>POLICY RESULT</small>
                    <strong>&gt;$5,000 → manager + controller</strong>
                  </div>
                  <span>Server policy · demo simulation</span>
                </div>
                <div className="approval-list">
                  <div className="approval-row" data-visible={machine.step >= 7} data-tone="red">
                    <span className="avatar">A</span>
                    <div>
                      <strong>Alex</strong>
                      <small>AP clerk</small>
                    </div>
                    <p>Role cannot approve this tier</p>
                    <b>Denied</b>
                  </div>
                  <div className="approval-row" data-visible={machine.step >= 8} data-tone="amber">
                    <span className="avatar">M</span>
                    <div>
                      <strong>Marcus</strong>
                      <small>Manager</small>
                    </div>
                    <p>First required signature</p>
                    <b>Approved</b>
                  </div>
                  <div className="approval-row" data-visible={machine.step >= 9} data-tone="teal">
                    <span className="avatar">P</span>
                    <div>
                      <strong>Priya</strong>
                      <small>Controller</small>
                    </div>
                    <p>Final required signature</p>
                    <b>Approved</b>
                  </div>
                </div>
                <p className="policy-footnote">
                  Supplier uncertainty adds controller review. A blocked supplier
                  can never reach approved-ready.
                </p>
              </article>

              <article className={`${stageClass(machine.step, 10, 10)} stage-card--action`}>
                <StageHeading
                  number="06"
                  eyebrow="Physical reach"
                  title="Action"
                  status={
                    machine.step < 10 ? (
                      <StatusPill tone="muted">Queued</StatusPill>
                    ) : (
                      <StatusPill tone="teal">Confirmed</StatusPill>
                    )
                  }
                />
                <div className="call-panel">
                  <div className="call-panel__signal">
                    <span className="call-panel__ring" />
                    <span className="call-panel__phone">⌕</span>
                  </div>
                  <div className="call-panel__copy">
                    <small>DOCK CONFIRMATION · FIXTURE</small>
                    <strong>
                      {machine.step >= 10 ? callOutcome.confirmed_slot : "Waiting for approval"}
                    </strong>
                    <p>
                      {machine.step >= 10
                        ? callOutcome.summary
                        : "The call begins only after the policy gate clears."}
                    </p>
                  </div>
                  <div className="call-panel__wave" aria-hidden="true">
                    {Array.from({ length: 24 }, (_, index) => (
                      <i key={index} style={{ "--bar": index } as React.CSSProperties} />
                    ))}
                  </div>
                </div>
                <div className="ready-state" data-visible={machine.step >= 10}>
                  <span className="ready-state__check">✓</span>
                  <div>
                    <small>FINAL STATE</small>
                    <strong>APPROVED — READY TO PLACE</strong>
                  </div>
                  <span>No checkout performed</span>
                </div>
              </article>
            </div>

            <div className="run-console__footer">
              <span>
                <i /> Fixture replay
              </span>
              <span>10 deterministic events</span>
              <span>0 network dependencies</span>
              <span>Keyboard: Space · → · R</span>
            </div>
          </div>
        </section>

        <section className="compiled-skill" aria-labelledby="skill-title">
          <div className="compiled-skill__intro" data-reveal>
            <p className="section-eyebrow">THE COMPOUNDING ADVANTAGE</p>
            <h2 id="skill-title">
              Every completed job
              <br />
              <em>becomes procedure.</em>
            </h2>
            <p>
              The run does not disappear into a chat log. ProcureOS compiles the
              outcome, constraints, and authority rules into a reusable company
              skill.
            </p>
          </div>
          <div className="manifest-card" data-reveal data-complete={isComplete}>
            <div className="manifest-card__topbar">
              <div>
                <span />
                <span />
                <span />
              </div>
              <small>COMPILED SKILL · YAML</small>
              <StatusPill tone={isComplete ? "teal" : "muted"}>
                {isComplete ? "Written" : "Pending run"}
              </StatusPill>
            </div>
            <pre aria-label="Compiled ProcureOS skill">
              <code>
                <span className="code-key">skill:</span>{" "}
                <span className="code-value">furnish_restaurant_seating</span>
                {"\n"}
                <span className="code-key">version:</span>{" "}
                <span className="code-number">1</span>
                {"\n"}
                <span className="code-key">learned_from:</span>{" "}
                <span className="code-value">run_0001</span>
                {"\n\n"}
                <span className="code-key">inputs:</span>
                {"\n  "}
                <span className="code-key">units:</span>{" "}
                <span className="code-number">40</span>
                {"\n  "}
                <span className="code-key">location:</span>{" "}
                <span className="code-value">Oakland, CA</span>
                {"\n  "}
                <span className="code-key">deadline:</span>{" "}
                <span className="code-value">Thursday</span>
                {"\n  "}
                <span className="code-key">budget_max:</span>{" "}
                <span className="code-number">6500</span>
                {"\n\n"}
                <span className="code-key">approval:</span>
                {"\n  "}
                <span className="code-key">required_above:</span>{" "}
                <span className="code-number">5000</span>
                {"\n  "}
                <span className="code-key">escalate_if_unverified:</span>{" "}
                <span className="code-bool">true</span>
              </code>
            </pre>
            <div className="manifest-card__footer">
              <span>Job one teaches the system.</span>
              <strong>Job two costs less.</strong>
            </div>
          </div>
        </section>

        <section className="final-cta" data-reveal>
          <p className="section-eyebrow">PROCUREMENT, COMPILED</p>
          <h2>
            Give it intent.
            <br />
            <em>Keep the authority.</em>
          </h2>
          <button className="forge-button" type="button" onClick={startDemo}>
            <span>{machine.launched ? "Run it again" : "Run ProcureOS"}</span>
            <span className="forge-button__arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        </section>
      </main>

      <footer className="site-footer">
        <a className="wordmark wordmark--footer" href="#top">
          <span className="wordmark__mark">P</span>
          <span className="wordmark__name">PROCURE</span>
          <span className="wordmark__slash">/</span>
          <span className="wordmark__os">OS</span>
        </a>
        <p>Agentic purchasing with evidence and enforced authority.</p>
        <span>DEMO FIXTURES · NO PURCHASES</span>
      </footer>

      <p className="sr-only" aria-live="polite">
        {statusAnnouncement}
      </p>
    </div>
  );
}
