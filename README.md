# Load Energy

A Phoenix-first commercial diesel load board. A buyer (job site or small fleet)
posts a fuel request — gallons, product type, delivery method, location pin,
delivery window — and nearby approved suppliers inside their service radius
quote a landed price per gallon on a 1–8 hour hold. The buyer accepts one
offer, which creates the order; the supplier delivers and records the BOL
gallons, and Load Energy invoices the winning supplier $0.02 per delivered
gallon (first two wins per supplier waived). It is a marketplace ledger, not a
TMS and not a payment processor. Mobile-first PWA, three roles: buyer,
supplier, admin.

Next.js 15 (App Router) + TypeScript, Prisma over PostgreSQL, Vitest with
fast-check for the property suite.

## Local setup

```bash
npm install                 # runs `prisma generate` via postinstall
cp .env.example .env        # optional; every variable is optional locally
npm run dev                 # http://localhost:3000
```

With no `DATABASE_URL`, the app runs on in-memory storage: it works, and it
forgets everything on restart. That is deliberate — a fresh clone needs
nothing installed to run the app or the tests. `DATABASE_URL` is commented out
in `.env.example` for the same reason, so copying the file does not force the
Prisma path on a machine with no Postgres.

To run against a real database locally:

```bash
# .env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/load_energy?schema=public"
```

```bash
npm run prisma:migrate-deploy   # applies prisma/migrations/
npm run seed                    # creates the first company + admin
```

`prisma/migrations/` holds a committed baseline (`..._init`), so
`prisma migrate deploy` is the normal way to build the schema; `db push` is no
longer needed. New schema changes get a migration with
`npm run prisma:migrate -- --name <change>`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes in production | Postgres connection string. Also the switch: set it and the app uses Prisma plus durable sessions; unset it and non-production falls back to in-memory adapters. A production boot without it **throws at startup** rather than losing data silently. |
| `TEST_DATABASE_URL` | No | Throwaway database for the Postgres half of the repository contract test. Unset, that suite skips. Wiped before every test. |
| `SEED_ADMIN_PHONE` | For seeding | First admin's phone, E.164 (e.g. `+16025550134`). |
| `SEED_ADMIN_PASSWORD` | For seeding | First admin's password. Never logged. |
| `SEED_ADMIN_EMAIL` | No | First admin's email, if they have one. |
| `SEED_ADMIN_COMPANY_NAME` | No | Operator company name. Defaults to `Load Energy Operations`. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | No | SMS notifications. Unset, sends fail and are recorded as isolated notification failures; orders still flow. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `EMAIL_FROM` | No | Optional email channel, used where an address is on file. `SMTP_PORT` defaults to 587. |
| `S3_TICKET_BUCKET` / `AWS_REGION` / `S3_ENDPOINT` | No | BOL ticket photo storage. Unset, a delivery records gallons and ticket number with a null photo key. AWS credentials come from the default chain. |
| `NODE_ENV` | Set by the platform | `production` is what makes a missing `DATABASE_URL` fatal. |

## Deploying to Render

`render.yaml` is a Blueprint: it defines the web service, a managed Postgres
instance, and the wiring between them.

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. Render reads
   `render.yaml`.
3. Render prompts for the values marked `sync: false`: `SEED_ADMIN_PHONE` and
   `SEED_ADMIN_PASSWORD`. Everything else is wired automatically.
4. **Apply**. Render creates `load-energy-db` and `load-energy`, injects
   `DATABASE_URL` from the database, and deploys.

What the blueprint sets, if you would rather configure the service by hand:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci --include=dev && npx prisma migrate deploy && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Region | `oregon` (service and database must match) |
| `DATABASE_URL` | From the database's internal connection string |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22.20.0` |

Notes:

- `--include=dev` is load-bearing. `NODE_ENV=production` applies to the build
  too, and without the flag npm skips devDependencies and `next build` fails
  on a missing `typescript`.
- `prisma generate` is not in the build command because `postinstall` already
  runs it.
- `prisma migrate deploy` only applies committed migrations, so it is safe on
  every deploy and a no-op once the schema is current.
- Nothing hardcodes a port; `next start` binds the `PORT` Render injects.
- `/api/health` is unauthenticated, touches no database, and returns
  `{"status":"ok"}` — no version, no environment name, no error text.
- On a paid instance type you can move the migration to Render's
  `preDeployCommand` if you prefer schema changes separated from the build.
  If a build ever cannot reach the database, that is the fallback — or run
  `npx prisma migrate deploy` once from the service Shell.

## Seeding the first admin

Identity can only be provisioned by an authenticated admin, so a freshly
migrated database has nobody who can sign in and create the first account.
Seed once, from the service's **Shell** tab on Render (or locally with the
same variables set):

```bash
npm run seed
```

It creates one operator Company (buyer kind) and one admin User, using the
real `CompanyUserService` over Prisma and bcrypt — so the phone normalisation
and password hash are exactly what the app would have produced. Sign in with
`SEED_ADMIN_PHONE` and `SEED_ADMIN_PASSWORD`.

The seed is idempotent: if a user already holds that phone number it reports
that and exits 0, so re-running it (or wiring it to a deploy hook) is safe. It
refuses to run with a blank password, and never prints the password. The same
script is registered as `prisma.seed`, so `npx prisma db seed` works too.

## Tests

```bash
npm test          # vitest, two projects: `services` (node) and `ui` (jsdom)
npm run typecheck # tsc --noEmit
npm run build     # next build
npx prisma validate
```

`prisma validate` reads the datasource, so it needs `DATABASE_URL` present —
in `.env` or inline:

```bash
DATABASE_URL="postgresql://u:p@localhost:5432/db" npx prisma validate
```

The repository contract (`src/repository/repository-contract.ts`) is run twice:
once against `InMemoryRepository` and once against `PrismaRepository`. The
Postgres half skips unless `TEST_DATABASE_URL` is set, which is why a default
`npm test` shows skipped tests. To run it:

```bash
createdb load_energy_test
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/load_energy_test?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm test
```

That database is truncated before every test. Never point it at anything you
care about.
