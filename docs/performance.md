# Performance and volume validation (task 11.3)

Reproducible pilot-volume run: **more than 200 simulated daily emissions** plus
**simultaneous background jobs** against a real PostgreSQL, using the simulated
Ruijie adapter and the real issuance, wallet, order and job services.

It asserts the pilot invariants directly in the database:

- **No duplicates** — one order per local reference, one `issued` event per
  order, one voucher per UUID/fingerprint, exactly one `createVouchers` call per
  order (no double-create or double-capture).
- **No negative balance** — wallet available/reserved never below zero, ledger
  projection equals the wallet projection, reconciliation reports consistent.
- **No lost leases** — every job is claimed once (`attempts = 1`), none left
  `running`/`pending`, zero `failed`/`dead`; an abandoned lease is recovered and
  finished with `attempts = 2`.
- **Acceptable lag** — emission and job latencies and total wall time stay
  inside the pilot budget below.

## How to run

```powershell
# spins a throwaway postgres:17-alpine container, migrates, runs, tears down
npm run load

# or reuse an existing database (no container)
$env:LOAD_DATABASE_URL = "postgres://skyticket:skyticket@localhost:5432/skyticket_load"
npm run load
```

The same harness is exposed as a `node:test` gate (`test/load/emission-volume.test.js`),
skipped unless `TEST_DATABASE_URL` is set:

```powershell
$env:TEST_DATABASE_URL = "postgres://skyticket:skyticket@localhost:55432/skyticket_test"
node --test --test-concurrency=1 "test/load/**/*.test.js"
```

## Pilot budgets (documented thresholds)

These are **service-level budgets for a pilot, not hardware benchmarks**. They
are deliberately loose, overridable by environment, and expressed as ceilings so
a slower CI host or a future real-network pilot can move the bar without editing
assertions.

| Metric | Budget | Env override |
| --- | --- | --- |
| Emissions per run | 250 (>200) | `LOAD_EMISSIONS` |
| Emission concurrency | 25 | `LOAD_EMISSION_CONCURRENCY` |
| Emission p95 latency | ≤ 2000 ms | `LOAD_EMISSION_P95_MS` |
| Emission p99 latency | ≤ 5000 ms | `LOAD_EMISSION_P99_MS` |
| Emission max latency | ≤ 15000 ms | `LOAD_EMISSION_MAX_MS` |
| Emissions wall clock | ≤ 90000 ms | `LOAD_EMISSIONS_WALL_MS` |
| Simultaneous jobs | 200 | `LOAD_JOBS` |
| Job workers | 6 | `LOAD_JOB_WORKERS` |
| Job p95 latency | ≤ 2000 ms | `LOAD_JOB_P95_MS` |
| Job drain wall clock | ≤ 30000 ms | `LOAD_JOB_DRAIN_MS` |
| Job lease | 30 s | `LOAD_JOB_LEASE_MS` |

The budget is a gate because database-level invariants (duplicates, negative
balance, lost leases) are absolute and asserted unconditionally; latency is only
a ceiling to catch pathological serialization or lock contention, not a
throughput target.

## Result

Run against `postgres:17-alpine` (Docker Desktop, Windows). Simulated adapter,
emission quantity 1, unit price 1000 COP.

| Metric | Value |
| --- | --- |
| Emissions requested / issued | 250 / 250 |
| Abnormal orders (failed/reconciliation) | 0 |
| Ruijie create calls | 250 |
| Vouchers / distinct UUIDs / fingerprints | 250 / 250 / 250 |
| `issued` order events | 250 |
| Emission p50 / p95 / p99 / max | 592 / 1157 / 1318 / 1519 ms |
| Emissions wall / throughput | 6605 ms / 37.9 per s |
| Wallet available / reserved (expected 1000 / 0) | 1000 / 0, consistent |
| Jobs succeeded / running / pending / failed | 200 / 0 / 0 / 0 |
| Jobs max attempts, duplicates | 1, 0 |
| Job p50 / p95 / max | 5 / 8 / 9 ms |
| Job drain wall / throughput | 437 ms / 457 per s |
| Abandoned lease | recovered, reclaimed, finished, attempts 2 |

**Outcome: PASS** — no duplicates, no negative balance, no lost leases, lag
within the pilot budget.

## Defect found and fixed

The first volume run (250 emissions, concurrency 25) exposed a real production
bug: **215 of 250 emissions were marked `needs_reconciliation` instead of
`issued`**, and emission p95 latency was ~25 s.

Root cause: `wallet.capture`/`wallet.release` inserted the ledger row first,
whose foreign key to `wallets` takes a `KEY SHARE` lock on the wallet, and only
afterwards requested the wallet's `EXCLUSIVE` lock. Two concurrent settlements
each held the shared lock and both requested the exclusive lock, which
PostgreSQL aborts as a deadlock (`40P01`). The issuance flow swallowed that
error as `persistence_failure_after_create`, leaving the hold reserved and the
order in `needs_reconciliation` even though the vouchers were created and
persisted. `wallet.reserve` already locked the wallet first, so the lock order
was inconsistent.

Fix (`src/modules/wallet/service.js`, minimal): settlement now locks the wallet
before the hold, giving a single global `wallet -> hold` order. Regression test:
`test/load/wallet-capture-concurrency.test.js` (24 concurrent captures and 24
concurrent releases on one wallet must all settle without deadlock).

After the fix the same run is clean: all 250 issued, emission p95 ≈ 1.2 s, and
the wallet projection stays consistent.
