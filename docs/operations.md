# Operations

## Prerequisites

- Docker + Docker Compose (runs PostgreSQL, web and worker; no host DB).
- Node.js 22+ and npm for host-side lint/tests/migrations.

## Configuration

Copy the template and fill the blanks. Never commit `.env`.

```powershell
Copy-Item .env.example .env
```

Generate strong values:

```powershell
# 32-byte AES key (base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Key variables (all documented in `.env.example`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Connection string. Inside Compose it is derived from `POSTGRES_*` automatically. |
| `APP_ENCRYPTION_KEY` | Base64 (32 bytes) key encrypting voucher codes, Ruijie secrets and tokens. |
| `APP_ENCRYPTION_KEY_ID` / `APP_ENCRYPTION_KEYS` | Primary key label and rotation keyring. |
| `SESSION_SECRET` | Session signing/opaque token derivation. |
| `ADMIN_EMAIL` | Bootstrap admin identity. |
| `RUIJIE_*` | Ruijie base URL/region/app credentials + manual API token (backend only). |
| `SMTP_URL` / `MAIL_FROM` | Notification email delivery. |

## Start the environment

```powershell
docker compose up --build
```

Startup order is enforced by Compose conditions:

1. `db` waits until `pg_isready` reports healthy.
2. `migrate` runs once, after `db` is healthy, then exits.
3. `web` and `worker` start only after `migrate` completes successfully.

Only the web port is published (`WEB_PORT`, default `3000`).

## Migrations

Forward-only, ordered by filename, each file in its own transaction, guarded by
a PostgreSQL advisory lock so concurrent `migrate` runs cannot race.

```powershell
# through Docker (not normally needed; migrate service runs on up)
docker compose run --rm migrate

# from the host against DATABASE_URL
npm run migrate
```

Re-running is a no-op ("database already up to date"). Destructive migrations
are disallowed during the pilot; use expand/contract.

## Health and diagnostics

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | Liveness — process is up. |
| `GET /readyz` | Readiness — runs `SELECT 1`; returns `503` when DB is down. |

```powershell
docker compose ps
docker compose logs -f web
docker compose logs -f worker
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

If `web`/`worker` never start, check `docker compose logs migrate`; the app waits
for a successful migration.

## Tests and lint

```powershell
npm install
npm run lint
npm run test          # unit tests (no DB required)
```

Integration tests need a real PostgreSQL database via `TEST_DATABASE_URL` and are
skipped otherwise:

```powershell
$env:TEST_DATABASE_URL = "postgres://skyticket:skyticket@localhost:5432/skyticket_test"
npm run test:integration
```

A throwaway database for integration tests:

```powershell
docker run --rm -d --name skyticket-test-db `
  -e POSTGRES_USER=skyticket -e POSTGRES_PASSWORD=skyticket -e POSTGRES_DB=skyticket_test `
  -p 55432:5432 postgres:17-alpine
$env:TEST_DATABASE_URL = "postgres://skyticket:skyticket@localhost:55432/skyticket_test"
npm run test:integration
docker stop skyticket-test-db
```

## Image / secret hygiene

- The image is built from `Dockerfile`; `.dockerignore` excludes `.env`, VCS and
  local artifacts; the Dockerfile copies only `src/`, `views/` and prod deps.
- Secrets are injected at runtime by Compose via `env_file: .env`. Verify a built
  image carries no secrets:

```powershell
docker run --rm --entrypoint sh skyticket/app:local -c "ls -a /app; ! test -f /app/.env"
docker save skyticket/app:local | Select-String -Pattern "APP_ENCRYPTION_KEY" -Quiet
```

## Key rotation (encryption)

Ciphertext is self-describing (`v1.<keyId>.<nonce>.<tag>.<ciphertext>`); the
keyring is `APP_ENCRYPTION_KEY` + `APP_ENCRYPTION_KEY_ID` + optional
`APP_ENCRYPTION_KEYS` (JSON `keyId -> base64 key`). Steps 1 is safe; the rest
are **(operator)** production actions.

1. Generate a new key (safe):
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Add the **current** key to `APP_ENCRYPTION_KEYS` so old ciphertext keeps
   decrypting.
3. Set `APP_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY_ID` to the new primary.
4. Redeploy; new writes use the new key.
5. Re-encrypt stored rows (codes, Ruijie secrets/tokens), then remove the old key
   from `APP_ENCRYPTION_KEYS`. This re-encryption has no automated command yet —
   it is an operator transaction. See `docs/runbooks.md` §4 for failure modes
   (e.g. `Unknown encryption key id`).

## Backup and teardown

- Data lives in the named volume `skyticket_db_data`; recreating containers keeps
  data. `docker compose down -v` deletes it.
- Backup/restore commands are in `docs/runbooks.md` §5. Stored voucher codes and
  tokens are ciphertext: a restore needs the **same** `APP_ENCRYPTION_KEY`/
  keyring, so back up the keyring separately and never in the DB volume.
- Never run destructive migrations during the pilot; orders in `issuing` or
  `needs_reconciliation` must be reconciled before releasing funds.

## Runbooks and launch gate

- Incident procedures (Ruijie/circuit, `needs_reconciliation`, ledger
  discrepancy, key rotation, backup/restore): `docs/runbooks.md`.
- Ruijie sandbox validation gate — **pending**: `docs/launch-gate.md`.
  `RUIJIE_LIVE_ENABLED` stays `false` until every checklist item is confirmed.
