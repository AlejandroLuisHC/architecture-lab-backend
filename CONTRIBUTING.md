# Contributing

## Local checks

```sh
npm ci
npm test
npm run build
```

The normal test command uses the Node test runner and does not need Firebase, Neon, or AWS credentials. Database integration tests are skipped unless `TEST_DATABASE_URL` points to a disposable PostgreSQL database. Never point those tests at production. To include them locally, set `DATABASE_URL` and `TEST_DATABASE_URL` to that test database, set `RUN_DB_TESTS=true`, run `npm run db:migrate`, then run `npm test`.

## Branch flow

- The maintainer may push directly to `dev`; CI runs on every push and reports its result.
- Contributors send PRs to `dev`. CI must pass and the code owner must approve.
- Promote `dev` to `integration`, then `integration` to `main`, using PRs and merge commits.
- PRs into `integration` from any branch other than `dev`, or into `main` from any branch other than `integration`, fail the branch-flow check.
- `integration` and `main` reject direct updates. Do not force-push or delete protected branches.

GitHub Actions validates the code only. It does not deploy or publish the backend.

## GitHub repository settings

Apply these rules to the matching branch in **Settings → Rules → Rulesets** (or equivalent branch protection settings) after the workflow has run once so its checks are selectable:

| Branch | Required pull request rules | Required status checks | Bypass |
| --- | --- | --- | --- |
| `dev` | 1 approval; require code-owner review | `Backend CI / branch-flow`, `Backend CI / verify` | Allow the maintainer to bypass so direct pushes remain possible; CI still runs and reports |
| `integration` | Require a pull request | `Backend CI / branch-flow`, `Backend CI / verify` | None |
| `main` | Require a pull request | `Backend CI / branch-flow`, `Backend CI / verify` | None |

For all three branches, block force-pushes and deletion. Require merge commits and disable squash/rebase merges in repository settings so promotions preserve ancestry. Do not require an approval on promotion PRs; their source branch and checks are the gate.
