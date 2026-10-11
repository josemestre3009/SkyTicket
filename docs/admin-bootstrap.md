# Administrator bootstrap

Creates the single initial administrator idempotently. The command never takes
a password from a file or Compose; supply it at run time.

## Requirements

1. Migrations applied (`npm run migrate` or the Compose `migrate` service).
2. `ADMIN_EMAIL` set in `.env`.
3. `DATABASE_URL` reachable from the process running the command.

## Run

Docker Compose (recommended, interacts with the TTY):

```powershell
docker compose run --rm -e ADMIN_PASSWORD web node src/cli/bootstrap-admin.js
```

Host (uses `DATABASE_URL` from `.env`):

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "<strong password>"   # optional; prompts securely if omitted
npm run migrate
node src/cli/bootstrap-admin.js
```

## Credential source

1. `ADMIN_PASSWORD` environment variable, when present.
2. Otherwise a hidden TTY prompt (no echo). Without a TTY and without
   `ADMIN_PASSWORD` the command fails instead of defaulting to a weak value.

## Idempotency

- First run prints `[bootstrap] created admin <email>`.
- Subsequent runs print `[bootstrap] admin <email> already exists; no changes`;
  the existing password is left untouched.
- If the email is already used by a non-admin user, the command fails with a
  conflict and changes nothing.

## After bootstrap

The administrator logs in with the email and password set during bootstrap;
privileged operations require only that authenticated password session.
