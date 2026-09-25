# One-click repository promotion

The `Promote both repositories` GitHub Actions workflow coordinates promotion of the backend and frontend together. Run it in `architecture-lab-backend` from the `main` branch and choose one stage:

- `integration` promotes `dev` to `integration`.
- `main` promotes `integration` to `main`.

The workflow creates or reuses the corresponding pull requests in both repositories, waits for each repository's required `branch-flow` and `verify` checks, and merges with a merge commit only when all checks pass. If either repository fails CI, neither PR is merged. If one repository has no new commits for that stage, it is skipped. Draft PRs must be marked ready first.

The pull requests are still created on GitHub so the branch rules remain effective, but you do not need to create or merge them manually. The workflow does not use an admin bypass and does not deploy. Merging to `main` can still start the existing Vercel Git integration for that repository.

Import and activate the six branch rulesets before using the action. The workflow checks that both expected CI contexts are registered as required checks; if they are absent, it stops without merging.

## One-time GitHub App setup

The workflow uses a GitHub App installation token instead of a personal access token. The token is short-lived, scoped to these two repositories, and cannot bypass their rulesets.

1. Create a GitHub App under your personal GitHub account. Disable its webhook; it does not need a callback URL or user login.
2. Grant repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, and **Checks: Read-only**. Leave other permissions disabled.
3. Install the app on only `architecture-lab-backend` and `architecture-lab-frontend`.
4. In `architecture-lab-backend` → **Settings → Secrets and variables → Actions**, add the app's Client ID as the repository variable `PROMOTION_APP_CLIENT_ID`, and its private key as the repository secret `PROMOTION_APP_PRIVATE_KEY`.
5. Keep the private key only in GitHub Secrets. Do not commit it or put it in an application `.env` file.

The workflow rejects runs unless the actor is `AlejandroLuisHC` and the workflow was selected from `main`. For an additional GitHub-side block before a run can start, configure **Workflow execution protections** to allow only `AlejandroLuisHC` to dispatch `.github/workflows/promote.yml`. This platform setting is separate from branch rulesets.

The workflow file must first be promoted to `main` through the normal branch flow. GitHub exposes manual dispatch only for workflows present on the repository's default branch.
