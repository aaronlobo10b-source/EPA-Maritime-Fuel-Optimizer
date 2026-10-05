# Maritime Fuel Optimizer

Source-backed vessel and voyage planning with a physics-based fuel baseline, optional local FuelCast predictions, and fleet optimization.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/lib/maritime-engine.ts` — voyage physics, fuel estimates, INR objective, and optimizer heuristics.
- `artifacts/api-server/src/lib/fuelcast.ts` and `scripts/fuelcast_model.py` — local measured-data validation and prediction integration.
- `lib/api-spec/openapi.yaml` — API contract source; generated clients and validators live under `lib/`.
- `lib/db/src/schema/maritime-vessels.ts` — saved vessel profile schema.
- `artifacts/maritime-optimizer/src/App.tsx` — dashboard and voyage workspace.
- `README.md` — setup, currency methodology, FuelCast provenance, license, and local training instructions.

## Architecture decisions

- Vessel particulars and financial assumptions are operator-entered and source-cited; no demo vessel or price is preloaded.
- Physics remains the default estimate. FuelCast is a separately selected model whose kg/s prediction is integrated over sailing time.
- FuelCast data and fitted weights stay under the ignored `.local/fuelcast/` directory.
- Fuel, carbon, port, and voyage costs use INR directly without exchange-rate conversion.

## Product

The dashboard manages vessel profiles, compares voyage scenarios, reports emissions and schedule constraints, and benchmarks QPSO, GA, PSO, and greedy optimization. There is no QUBO implementation in the current codebase.

## Gotchas

- FuelCast training requires a separate Python environment and a local license-compliant download; follow `README.md`.
- FuelCast has no reliable voyage IDs or absolute timestamps. Time blocks use its sequential five-minute row index.
- Run `pnpm --filter @workspace/api-spec run codegen` after editing the OpenAPI source.

## Pointers

- See `README.md` for local data setup, license, validation, and INR methodology.
