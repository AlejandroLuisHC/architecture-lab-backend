# Stack Playground data architecture

## Product direction

The guided serverless lab is the first use of a broader architecture sandbox. Users should eventually be able to model multiple systems, compare revisions, and inspect cost, security, capability, and performance findings. A future import path may start from an existing architecture. All simulated resources remain inert: saving a scenario does not create AWS infrastructure.

The foundation separates **user-owned scenarios**, **published learning modules**, **reference data**, and **analysis results**. A resource configuration is allowed only when its type has a versioned schema and an evaluator that understands the relevant settings. Adding an AWS setting merely because it exists in the real console would imply a level of fidelity the sandbox does not yet have.

## Storage and trust boundaries

- Firebase Authentication remains the identity provider. The Express API verifies ID tokens and takes ownership from the token UID, never from a client-supplied user ID.
- PostgreSQL is the product database. Each user has a personal workspace; scenarios belong to workspaces. The API checks ownership before returning or changing any scenario or revision. The database is reached only from the backend. No AWS account credentials or secrets belong in resource configuration.
- `scenario_resources` holds the editable current resource set. `resource_type`, `service`, `region`, and `schema_version` are typed columns; `config` is validated JSONB for that resource type. `scenario_relationships` contains typed links with foreign keys. During the guided lab, a deliberately broken ID remains in the draft config for feedback, but it cannot become a valid graph edge.
- Every save creates an immutable `scenario_revisions` snapshot. Future `analysis_runs` reference an exact revision, evaluator version, workload assumptions, and source catalog versions. Earlier results do not silently change when the architecture or source data changes.
- `module_versions` stores an immutable published definition and content hash. `module_attempts` pins an attempt to one module version and a scenario. Lesson copy and validation code are owned in the repository; deployment publishes the corresponding version. A changed lesson requires a version bump and an explicit upgrade path for old attempts.
- `user_entitlements` is separate from scenarios. Paid analysis can be added without changing who owns an architecture or how it is stored.

## Environment variables and secrets

- `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `PGPASSWORD`, and `POSTGRES_PASSWORD` contain live credentials. Keep them in the backend only and mark them Sensitive in Vercel. The current Vite Firebase settings and `VITE_API_BASE_URL` are public browser configuration; never put an admin key or database URL under a `VITE_` name.
- `FIREBASE_PRIVATE_KEY` stays server-side and Sensitive in Vercel Production and Preview. Firebase project metadata can remain server-side as configured. Local credentials belong in ignored `.env` files; `.env.example` contains names only.
- When Vercel variables change, refresh local copies with `vercel env pull` into ignored `.env.vercel.local` files. Check `.gitignore` and `git status` before committing. Do not print values to logs or paste them into chat.
- Neon credential aliases were originally provisioned as readable Vercel `Config` entries. They have now been changed to `Secret`; rotate the Neon database password at the provider and redeploy so the old readable password stops working.

## Reference data and accuracy roadmap

`source_catalog_versions` reserves metadata for future ingestions: kind, source URL, object key, region, effective date, retrieval time, hash, and coverage. When ingestion begins, raw AWS price and quota files will go into object storage; PostgreSQL will hold provenance and normalized data needed by evaluators. A source version is immutable. Estimates must report missing coverage and assumptions, rather than treating published rates or default quotas as an exact customer bill or effective account limit.

1. **Now:** migrate progress, add personal scenarios, resource links, revisions, and module versioning.
2. **Next:** grow supported resource schemas and freeform editing in the UI, with explicit schema migrations and validation fixtures.
3. **Then:** ingest versioned AWS sources; implement deterministic cost, security, capability, and workload-based performance evaluations with provenance.
4. **Later:** support architecture import and premium AI explanations grounded in those evaluations. Import credentials and customer infrastructure data will require a separate security design before implementation.

## Rollout and failure recovery

The backend defaults to Firestore progress until `PROGRESS_STORE=postgres`. First provision Neon and run SQL migrations. Run the Firestore importer in dry-run mode, then with `--apply`; it is idempotent through `legacy_imports`. The importer prints source/imported/unsupported counts and fails if the PostgreSQL count does not match. Inspect and resolve unsupported old formats before switching the progress route. Keep Firestore intact for rollback until production read/save and account isolation have been checked. Optional `LEGACY_FIRESTORE_FALLBACK=true` can lazily import a missing current-version document during the transition, but the count-verified bulk import is the primary path.

If a database request fails, the API returns an error and the frontend retains the current in-memory draft for retry. Guest work remains in memory only. The client must continue offering a choice before replacing a guest draft with account progress. Scenario edits include `expectedRevision`; stale updates return a conflict instead of overwriting another edit.
