# Stack and architecture

## Processes

- **web** (`src/server.js` → `src/app.js`): Fastify HTTP server. Serves API and
  (later) EJS-rendered responsive pages. Exposes `/healthz` (liveness) and
  `/readyz` (DB readiness).
- **worker** (`src/worker.js`): polls the `jobs` table, claims work with
  `FOR UPDATE SKIP LOCKED`, executes registered handlers, retries with a capped
  exponential backoff and requeues jobs whose lease expired.
- **migrate** (`src/db/migrate.js`): one-shot forward-only migration runner.

Both processes share PostgreSQL and the `src/` domain modules; they never share
memory. There is no Redis: PostgreSQL is the coordination point.

## Data model

Tables are grouped by capability (see `src/db/migrations/`):

- Identity: `users`, `sessions`.
- Tenancy: `resellers`, `ruijie_connections`, `sites`, `reseller_sites`.
- Catalog: `packages`, `reseller_package_permissions`.
- Pricing: `price_rules`, `price_versions`.
- Money: `wallets`, `ledger_entries`, `holds`.
- Sales: `voucher_orders`, `order_events`, `vouchers`.
- Operations: `sync_cursors`, `jobs`, `reconciliation_cases`, `notifications`,
  `email_deliveries`, `audit_events`.

Guarantees enforced in the database (not only in app code):

- Money is integer (`*_minor`); `wallets.available_minor`/`reserved_minor` are
  `>= 0` and `ledger_entries` is append-only (trigger rejects UPDATE/DELETE).
- Idempotency: `ledger_entries.idempotency_key` unique, one reversal per entry,
  `voucher_orders (reseller_id, local_reference)` unique, capture/release keys
  unique.
- Tenant isolation: `voucher_orders` has composite FKs to `reseller_sites`
  (reseller must be assigned the site) and to `packages (id, site_id)` (package
  must belong to the site).
- Pricing integrity: `price_versions` has a GiST exclusion constraint rejecting
  overlapping validity windows for the same rule.
- `audit_events` is append-only and stores redacted before/after snapshots.

## Security primitives

- **Encryption** (`src/lib/crypto.js`): AES-256-GCM with a versioned envelope
  `v1.<keyId>.<nonce>.<tag>.<ciphertext>` (base64url). Nonce is random per
  encryption. A keyring built from `APP_ENCRYPTION_KEY` +
  `APP_ENCRYPTION_KEY_ID` + optional `APP_ENCRYPTION_KEYS` JSON map allows
  decrypting old ciphertext during rotation.
- **Passwords** (`src/lib/password.js`): `scrypt` with per-hash random salt,
  stored as `scrypt$N$r$p$salt$hash`; verification uses constant-time compare.
- **Redaction** (`src/lib/redact.js` + `src/logger.js`): key-based deep
  redaction of secrets/tokens/codes, plus `maskCode`/`maskEmail`. Fastify's pino
  logger also redacts known request/response paths.
