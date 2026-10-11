# Launch gate — Ruijie sandbox validation

**Status: PENDING — not validated.** Real Ruijie emission stays disabled until
every item below is confirmed with evidence and the OpenSpec artifacts are
approved.

## The gate

`RUIJIE_LIVE_ENABLED` (`.env`, default `false`) is the master switch. While it
is `false`:

- No outbound Ruijie call is ever made.
- The `ruijie.sync` handler is a no-op (`{ skipped: 'ruijie_live_disabled' }`).
- The issuance adapter rejects `create` **before** any balance is reserved.

Turning it on is a production action that requires the operator sign-off
described below. See `docs/runbooks.md` for the failure/recovery procedures and
`docs/operations.md` for setup.

## Sandbox checklist (pending, task 7.7)

Each item is **PENDING** until observed against the approved sandbox with
recorded evidence. Do not check an item from documentation or from a simulated
run.

| # | Item | Evidence | Confirmed by | Date |
| --- | --- | --- | --- | --- |
| 1 | Host / base URL / region | — | — | — |
| 2 | Permissions and app credentials | — | — | — |
| 3 | Token access + refresh (codes 3/4) | — | — | — |
| 4 | `voucher/create` payload | — | — | — |
| 5 | Partial issuance (`count < quantity`) | — | — | — |
| 6 | Timeout behavior | — | — | — |
| 7 | Pagination (`getList`, partial page, `count`) | — | — | — |
| 8 | Aliases (`codeNo`/`voucherCode`, `comment`/`nameRef`, `limitClients`/`maxClients`) | — | — | — |
| 9 | Units (duration / consumption / speed) | — | — | — |
| 10 | Rate limit and 429 `Retry-After` | — | — | — |
| 11 | Meaning of code `25` | — | — | — |

## Rules

- Any **critical contract unconfirmed** keeps emission disabled — no exceptions.
- A finding that contradicts a spec is **not** patched silently: update the
  OpenSpec artifacts first (task 7.8), get the revision approved, then proceed.
- A simulated `create` (fixture, mock or `src/ruijie/simulation.js`) is **never**
  sandbox evidence.

## Activation procedure (operator, after approval)

1. Every checklist item is confirmed with evidence.
2. Contradicted artifacts updated and the revision approved (task 7.8);
   credentials rotated.
3. Launch gate items verified: backups tested (`docs/runbooks.md` §5),
   healthchecks green, administrator created, two pilot resellers configured
   (task 11.5).
4. Set `RUIJIE_LIVE_ENABLED=true`, redeploy `web` + `worker`, then run **one**
   controlled emission and confirm it reconciles.

**Rollback:** set `RUIJIE_LIVE_ENABLED=false` and redeploy. Orders in `issuing`
or `needs_reconciliation` stay reserved and are resolved per `docs/runbooks.md`
§2; never force a release to "clean up".
