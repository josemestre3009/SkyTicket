# Runbooks

Operational procedures for the pilot. Complements `docs/operations.md` (setup,
migrations, key rotation) and `docs/launch-gate.md` (validation gate).

**Conventions**

- **Safe check** — read-only, needs no secrets, destroys nothing. Safe to run
  during an incident.
- **(operator)** — production step that needs a human with credentials, DB or
  Ruijie access, and/or changes state. Never automated blindly.
- **No faking the sandbox.** The Ruijie sandbox checklist is **pending**
  (`docs/launch-gate.md`). Never treat a simulated `create` as real evidence.

Always start with the shared diagnostics:

```powershell
docker compose ps
docker compose logs -f web
docker compose logs -f worker
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Web surfaces: `/admin/orders`, `/admin/audit`, `/admin/config` (shows the
Ruijie gate state). Reconciliation is automatic and internal in the MVP: there
is **no** visible tray, case inbox or resolve route. Inspect and resolve cases
with the read-only/operator SQL below.

## 1. Ruijie failure / circuit open

**Symptoms:** voucher creation fails before reserving balance, logs mention
`Ruijie circuit open; emission unavailable`, the panel shows emission
unavailable while history and local data keep working.

**How it behaves:** one circuit per connection (`closed`/`open`/`half_open`).
Opens after 5 consecutive recoverable failures, retries a single probe after
~30s; a successful probe closes it. Tokens are reused per connection/region and
renewed once on codes 3/4. Idempotent `GET`s retry up to 3 times with
backoff+jitter and honor `Retry-After` on 429. `POST`/`create` is **never**
retried automatically.

**Safe checks**

```sql
-- state per connection (read-only)
SELECT id, region, circuit_state, consecutive_failures,
       circuit_opened_at, circuit_half_open_at
FROM ruijie_connections;
```

**Actions**

- Do **not** retry `create` by hand: Ruijie has no creation idempotency. An
  ambiguous `create` becomes `needs_reconciliation` (see runbook 2).
- Let the circuit recover on its own (reset timeout + one half-open probe).
- If failures persist, check Ruijie status and the credentials/token; keep live
  emission disabled while any contract is unconfirmed.

**(operator) Force a circuit reset** only after the upstream cause is fixed:

```sql
UPDATE ruijie_connections
SET circuit_state = 'closed', consecutive_failures = 0,
    circuit_opened_at = NULL, circuit_half_open_at = NULL
WHERE id = $1;
```

**Verification:** circuit back to `closed` / `0` failures; a single controlled
create against the **approved sandbox** succeeds once and no duplicate voucher
appears.

## 2. Order stuck in `needs_reconciliation`

**Symptoms:** order status `needs_reconciliation` after timeout, codes
`3`/`4`/`7`/`25`, a partial `create` response, or a local failure after a
possible emission. The hold stays **reserved**; nothing is re-created.

**Safe checks**

- `/admin/orders?status=needs_reconciliation`.
- Open cases via read-only SQL (no visible tray in the MVP):

```sql
SELECT id, case_type, severity, status, order_id, summary, created_at
FROM reconciliation_cases
WHERE status <> 'resolved'
ORDER BY created_at DESC;
```

- Read-only SQL for the order, its events and hold:

```sql
SELECT o.id, o.status, o.create_dispatched_at, o.failure_reason,
       h.id AS hold_id, h.status AS hold_status, h.amount_minor,
       h.captured_minor, h.released_minor
FROM voucher_orders o
LEFT JOIN holds h ON h.id = o.hold_id
WHERE o.id = $1;
```

**Actions**

- Locate the vouchers by UUID via Ruijie `getList` (operator, sandbox/manual).
- Resolve through the reconciliation service (operator/worker) with a **reason**
  and **evidence**; there is no web resolve route in the MVP. Only permitted
  case types can be resolved: `order_stuck`, `voucher_local_only`,
  `voucher_ruijie_only`, `voucher_mismatch`, `wallet_projection_mismatch`.
- For `order_stuck` dispositions: `confirmed_no_emission` releases the hold;
  `confirmed_emitted` captures it. Never both.
- **Partial issuance resolution stays disabled** until sandbox proves the
  semantics; a partial result must not be captured or released automatically.

**Verification:** order ends `failed` or `issued`, hold settled once, at most
one capture/release ledger entry, and a `RECONCILIATION_RESOLVE` audit event.

**Never:** repeat `create`, `capture` or `release` on an ambiguous order in
order to "make it work".

## 3. Ledger / projection discrepancy

**Symptoms:** wallet operations fail with `integrity_blocked`; a
`wallet_projection_mismatch` (severity `critical`) case is open.

**How it behaves:** the worker auto-runs `orders.recovery` every
`WORKER_MAINTENANCE_INTERVAL_MS`. Wallet reconciliation compares the
`wallets` projection against the `ledger_entries` sum. It **never
auto-corrects**: on a mismatch it blocks the wallet and opens the case.

**Safe checks**

```sql
-- projection vs ledger sum (read-only)
SELECT w.id, w.available_minor, w.reserved_minor,
       COALESCE(SUM(l.available_delta), 0) AS ledger_available,
       COALESCE(SUM(l.reserved_delta), 0) AS ledger_reserved
FROM wallets w
LEFT JOIN ledger_entries l ON l.wallet_id = w.id
WHERE w.id = $1
GROUP BY w.id;
```

- Open cases via read-only SQL (`reconciliation_cases WHERE status <> 'resolved'`).

**(operator) Trigger wallet reconciliation** by enqueuing the worker job
(no dedicated CLI yet):

```sql
INSERT INTO jobs (job_type, payload)
VALUES ('wallet.reconciliation', jsonb_build_object('resellerId', $1));
```

**Actions**

- Find the root cause (duplicate insert, missing entry, manual tamper).
- Correct only with **new compensating entries** (reversal/adjustment). The
  ledger is append-only; the DB trigger rejects `UPDATE`/`DELETE`.
- Resolve the case with evidence after the correction. The wallet stays blocked
  until then.

**Verification:** projection equals the ledger sum, no negative available or
reserved, and the resolution is audited.

## 4. Versioned `APP_ENCRYPTION_KEY` rotation

See also the rotation steps in `docs/operations.md`. Ciphertext is
self-describing: `v1.<keyId>.<nonce>.<tag>.<ciphertext>`. The keyring is built
from `APP_ENCRYPTION_KEY` + `APP_ENCRYPTION_KEY_ID` + the optional
`APP_ENCRYPTION_KEYS` JSON map, so old ciphertext keeps decrypting during the
change.

1. **Safe check** — generate a new 32-byte key:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. **(operator)** Add the current key to `APP_ENCRYPTION_KEYS` as JSON
   `{"<oldKeyId>":"<oldBase64Key>"}`.
3. **(operator)** Point `APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_KEY_ID` at the
   new key.
4. **(operator)** Restart `web` and `worker`.
5. **(operator)** Re-encrypt stored rows (voucher codes, Ruijie secrets/tokens):
   decrypt with the keyring, re-encrypt under the new primary, in a transaction.
   Keep the old key until every row is migrated.
6. **(operator)** Remove the old key from `APP_ENCRYPTION_KEYS` only after all
   rows are re-encrypted and verified.

**Failure modes**

- `Unknown encryption key id` — a ciphertext references a key missing from the
  keyring. Re-add that key to `APP_ENCRYPTION_KEYS`; do **not** rotate further.
- Primary key lost with no rotation copy — voucher codes and tokens are
  unrecoverable. Treat as an incident; restore from a backup taken with the
  matching key.

**Verification:** `npm run test` covers round-trip, rotation keyring and unknown
key id (`test/unit/crypto.test.js`) — safe, no secrets needed.

## 5. PostgreSQL backup and restore

Data lives in the named volume `skyticket_db_data`. Voucher codes and Ruijie
tokens are stored as **ciphertext**; a restore needs the **same
`APP_ENCRYPTION_KEY`/keyring** or those values cannot be decrypted.

**Backup (operator)** — logical dump, custom format, no service stop:

```powershell
docker compose exec -T db pg_dump -U skyticket -d skyticket -Fc --file=/tmp/skyticket.dump
docker compose cp db:/tmp/skyticket.dump ./backups/skyticket.dump
```

**Restore (operator, destructive)** — into a **stopped** app:

```powershell
docker compose stop web worker
docker compose cp ./backups/skyticket.dump db:/tmp/skyticket.dump
docker compose exec -T db pg_restore -U skyticket -d skyticket --clean --if-exists /tmp/skyticket.dump
docker compose start web worker
```

- **Drill safely:** point `DATABASE_URL`/`TEST_DATABASE_URL` at a throwaway
  container and restore there first. Never rehearse against pilot data.
- Volume snapshots are an alternative but must be taken with the app stopped to
  avoid an inconsistent copy.
- Never run `docker compose down -v` on pilot data.

**Verification:** migrations re-run as a no-op ("database already up to date"),
`/readyz` returns 200, a stored voucher decrypts with the current keyring, and
the wallet projection equals the ledger sum (runbook 3).

## 6. Command safety summary

| Command | Class |
| --- | --- |
| `npm run lint` | Safe |
| `npm run test` (unit) | Safe — no DB, no secrets |
| `npm run test:integration` | Safe only with a **throwaway** `TEST_DATABASE_URL` |
| `node -e "...randomBytes(32)..."` | Safe |
| `docker compose config` | Operator — reads `.env`; output is secret-bearing |
| `docker compose up --build` | Operator — needs valid `.env` |
| `curl /healthz`, `/readyz` | Needs a running stack |
| `pg_dump` / `pg_restore` | Operator — DB access; restore is destructive |
| Key rotation / circuit reset / wallet reconcile enqueue | Operator — changes state |
