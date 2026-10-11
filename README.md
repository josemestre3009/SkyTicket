# SkyTicket — Reseller Panel

B2B panel to sell Ruijie Cloud Wi-Fi vouchers to authorized resellers with a
prepaid wallet, immutable ledger and audited issuance. Greenfield monolith
implementing OpenSpec change `build-reseller-panel`.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22+ (ESM) | Single language for web, worker and CLI. |
| Web/API | Fastify v5 | Small, fast, plugin-based; JSON + future EJS views. |
| Views | EJS | Server-rendered responsive pages without a separate SPA build. |
| Database | PostgreSQL 17 | Authority for identity, authorization, ledger, orders and the job queue. |
| DB driver | `pg` | Explicit transactions and row locking (`FOR UPDATE SKIP LOCKED`). |
| Email | `nodemailer` | Notification delivery from the worker. |
| Tests | `node:test` | Built-in runner, no extra framework. |
| Lint | ESLint 9+ flat config | Consistent style, no unused code. |

Architecture: one codebase, two processes — `web` (Fastify) and `worker` (jobs).
They share PostgreSQL and domain code, never memory. No Redis; jobs use row-level
locking (`docs/stack.md`, `docs/operations.md`).

## Layout

```
src/
  app.js            Fastify app factory + health routes
  server.js         web entrypoint
  worker.js         worker entrypoint (job loop)
  config.js         env parsing
  logger.js         pino logger with secret redaction
  db/
    index.js        pool + withTransaction helper
    migrate.js      forward-only migration runner (advisory lock)
    migrations/     *.sql applied in lexical order
  jobs/repository.js   atomic claim, lease, retries, run_after
  lib/
    crypto.js       versioned AES-256-GCM (keyring, rotation)
    password.js     scrypt password hashing
    redact.js       deep redaction + code/email masking
    audit.js        append-only audit writer
test/unit, test/integration
docker-compose.yml, Dockerfile, .dockerignore, .env.example
docs/               stack and operations runbooks
```

## Quick start

```powershell
Copy-Item .env.example .env   # then fill APP_ENCRYPTION_KEY, SESSION_SECRET, ADMIN_EMAIL
docker compose up --build     # db -> migrate -> web + worker
```

Open http://localhost:3000/healthz. See `docs/operations.md` for migrations,
diagnostics, tests and key rotation; `docs/runbooks.md` for incident runbooks
(Ruijie/circuit, `needs_reconciliation`, ledger discrepancy, key rotation,
backup/restore); and `docs/launch-gate.md` for the
**pending** Ruijie sandbox validation gate (`RUIJIE_LIVE_ENABLED`).
