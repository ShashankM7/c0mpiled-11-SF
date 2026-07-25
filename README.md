# ProcureOS

A cinematic, fixture-backed demo of an agentic purchasing department.

ProcureOS takes a natural-language request through sourcing, supplier and
destination verification, landed-cost calculation, additive approval policy,
and dock confirmation. The deterministic run stops at
`APPROVED_READY`; it never places an order.

## Local development

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

Useful query parameters:

- `?mode=fixture` keeps the run explicitly offline-safe.
- `?autoplay=1` launches the canonical replay on page load.

## Validation

```bash
npm test
npm run lint
```

The tests cover state transitions, policy boundaries, the verification
re-sourcing loop, landed-cost arithmetic, playback behavior, fallback behavior,
rendered product copy, metadata, and removal of the temporary starter.

