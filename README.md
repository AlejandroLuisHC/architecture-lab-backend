# Stack Playground API

Express and TypeScript API for a guided, simulated AWS architecture lab. Firebase Authentication identifies users; PostgreSQL stores scenarios, revisions, module attempts, and progress after migration. It never creates AWS resources.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
copy .env.example .env
npm run dev
```

The guest lab works without Firebase or PostgreSQL credentials. The API runs at `http://localhost:3000`; `GET /health` returns its status. The development server loads `.env` when it exists. To enable accounts locally, set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` in `.env`. The Firestore database is needed only for existing progress and migration; new progress uses PostgreSQL after the cutover.

For production, keep Firebase credentials server-side. The server accepts a private key containing real newlines or literal `\n` sequences. Firebase emulators can be used with `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_EMULATOR_HOST`, and `FIRESTORE_EMULATOR_HOST`.

Keep the included `firestore.rules` applied. They deny direct client reads and writes; the migration reads legacy progress through the Admin SDK.

## PostgreSQL setup and migration

Provision Neon for the backend Vercel project, preferably in the backend Function region. It provides `DATABASE_URL` to the backend only. Supply that value locally before running migration commands; never commit or put it in the frontend. Keep `PROGRESS_STORE=firestore` until the import is verified.

The Vercel CLI can pull Development database variables into ignored `.env.vercel.local` with `vercel env pull .env.vercel.local --yes`; local commands load it after `.env`, so Firebase credentials can stay in the existing `.env` without copying database secrets. When `DATABASE_URL` exists, the local dev server defaults progress to PostgreSQL. Provision using Neon's explicit Free plan and keep paid plans disabled unless you intentionally choose to upgrade. Free-tier exhaustion can interrupt saves; it should not be treated as unlimited capacity. Keep Neon URLs/password aliases Sensitive in Vercel; the frontend's `VITE_*` settings are public configuration and must never contain database or Firebase Admin credentials.

Vercel originally exposed Neon connection aliases as readable `Config` entries. They have now been changed to `Secret`, but the provider password still needs to be rotated so the previously readable credential becomes invalid. After rotating in Neon, let the Vercel integration sync the new secrets, redeploy, and refresh `.env.vercel.local` locally. See the [environment-variable handling notes](docs/data-architecture.md#environment-variables-and-secrets).

```bash
npm run db:migrate
npm run db:import-firestore
npm run db:import-firestore:apply
```

The importer prints source, imported, already-imported, unsupported, and PostgreSQL counts. It exits unsuccessfully if any source document is unsupported or counts differ. Resolve those documents before setting `PROGRESS_STORE=postgres` in Vercel and locally, then redeploy the backend. Keep Firestore available during rollback. `LEGACY_FIRESTORE_FALLBACK=true` can read and import a missing current-version run on demand during a controlled transition. The [data architecture](docs/data-architecture.md) explains ownership, revisions, reference data, and later milestones.

## API contract

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/labs/serverless-web` | No | Lesson copy, steps, version, initial configuration |
| `POST` | `/labs/serverless-web/validate` | No | Evaluate `{ configuration }` and return checks, hints, and completion |
| `GET` | `/me/progress/serverless-web` | Firebase ID token | Return `{ progress }`, or `null` |
| `PUT` | `/me/progress/serverless-web` | Firebase ID token | Save `{ version, configuration, currentStep }`; the server derives completion and unlocked stages |
| `GET` | `/me/scenarios` | Firebase ID token | List owned scenarios |
| `POST` | `/me/scenarios` | Firebase ID token | Create a freeform scenario from `{ title, region, workloadAssumptions?, configuration, relationships? }` |
| `GET` | `/me/scenarios/:id` | Firebase ID token | Read an owned scenario and current snapshot |
| `PUT` | `/me/scenarios/:id` | Firebase ID token | Save the same scenario fields plus `expectedRevision` |
| `GET` | `/me/scenarios/:id/revisions` | Firebase ID token | List immutable revisions |
| `GET` | `/me/scenarios/:id/revisions/:revision` | Firebase ID token | Read one historical snapshot |

Protected routes take `Authorization: Bearer <Firebase ID token>`. The server verifies the token and checks scenario workspace ownership. The client cannot choose another user's UID. The server recalculates completion on every progress save. A saved run from an older lab version returns a conflict through the compatibility progress route; its versioned scenario and snapshot remain available through the scenario API. Writing the current version starts a new attempt.

The four-stage exercise covers private S3 delivery through CloudFront, API Gateway and Lambda, DynamoDB with restricted IAM access, and CloudWatch logs and alarms. The versioned configuration is a list of simulated resources with references between services; validation checks those relationships without calling AWS. Rules and learner-facing text are in `src/lab.ts`.

## Quality checks

```bash
npm run build
npm test
```

With a migrated test database, set `RUN_DB_TESTS=true` before `npm test` to run the PostgreSQL ownership/revision check. The optional `smoke:live` command requires `SMOKE_API_URL` and uses two temporary Firebase accounts; it removes the accounts and their test data afterward.

## Vercel deployment

Connect this repository as its own Vercel project. Vercel detects `src/index.ts` as an Express entry point and deploys it as a Function. Attach Neon to **this backend project** and verify `DATABASE_URL` exists for the desired environments. Deploy with `PROGRESS_STORE=firestore`, migrate and verify, then change it to `postgres` and redeploy. Use the API URL as `VITE_API_BASE_URL` in the frontend project. Confirm guest validation, authenticated save/reload, scenario ownership, and revision reads after deployment. The backend permits browser origins through CORS because protected operations require a verified bearer token and no cookie credentials are used.
