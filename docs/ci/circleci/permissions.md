# CircleCI permissions, secrets and security

Principle: CircleCI jobs get the **minimum** access to GitHub, to cloud accounts and to secrets, and untrusted code (fork PRs) gets none of the secrets.

## 1. Who can do what

### On GitHub

| Need | Permission |
|---|---|
| Connect CircleCI to an organisation | Organisation **owner** (or an owner approves the app request) |
| Add a project in CircleCI | Repo **admin** (to create webhooks/deploy keys) or access through the GitHub App installation |
| Run/rerun pipelines | Anyone in the CircleCI org with access to the project |
| Branch protection rules | Repo admin |

Use the **GitHub App** connection when available: access is limited to selected repos, tokens are short-lived and not tied to one person's account. With the older **OAuth** connection CircleCI acts with the permissions of the user who authorised it; use a dedicated machine user and not a personal admin account.

### Inside CircleCI (organisation roles)

| Role | Can |
|---|---|
| **Admin** | Manage org settings, billing, contexts, security groups, members |
| **Contributor / member** | Run pipelines, view projects, use contexts they are allowed to |
| Project **admins** | Project settings, env vars, SSH keys, triggers |

Give people member access by default; keep the admin list to the minimum (2-3 people).

## 2. Secrets: three places, pick the narrowest

| Place | Scope | Use for |
|---|---|---|
| Project **Environment Variables** | One project | Project-specific tokens (e.g. `NPM_TOKEN`) |
| **Contexts** | Many projects, restrictable | Shared credentials: registry, cloud deploy, notification webhooks |
| Config file `environment:` | Plain text, visible to all with repo access | Only non-secret values (`NODE_ENV=test`, `JWT_SECRET=ci-secret` for tests) |

Rules:

- Secrets are masked in logs, but never `echo` or `env | sort` them, and never write them to artifacts.
- Do not run `npm publish`, deploy or registry-login steps on branches from forks.
- Rotate tokens on a schedule and when a member with access leaves.

### Contexts and restrictions

1. **Organization Settings -> Contexts -> Create Context**, e.g. `docker-registry`, `prod-deploy`.
2. Add environment variables (name/value).
3. **Security:** restrict who can use the context:
   - by **security group** (GitHub team) so only a team can trigger jobs using it;
   - by **project** (project restrictions) so only listed projects can use it;
   - by **expression** (e.g. only `main`): `pipeline.git.branch == "main"` on newer plans.
4. Attach to a job in the workflow: `- publish: { context: docker-registry }`.
5. Use separate contexts for staging and production, and require **manual approval** before any job that uses the production context.

## 3. Fork pull requests

Open-source or contributor forks are the main secret-leak risk.

- **Project Settings -> Advanced**: leave **"Build forked pull requests"** off unless needed, and keep **"Pass secrets to builds from forked pull requests"** **off**.
- If you build forks, jobs get no secrets, so the unit and smoke jobs (which need none) still work, but publish/deploy jobs must be filtered out (`filters: branches: only: main`).
- For private repos with trusted contributors, branches in the same repo are fine.
- Use **"Only build pull requests"** and **"Auto-cancel redundant builds"** to save credits.

## 4. SSH keys

| Key type | Purpose | Notes |
|---|---|---|
| **Deploy key** (read-only) | Check out the repo | Created automatically for OAuth projects. Read-only; cannot push |
| **User key** | Push to the repo (tags, version commits) | Has the permissions of the user. Avoid; prefer a GitHub token or app |
| **Additional SSH key** | Log in to your servers to deploy | **Project Settings -> SSH Keys -> Add SSH Key**: add the private key and the host; CircleCI shows a **fingerprint**. Use it with `add_ssh_keys: { fingerprints: ["xx:xx:..."] }` in the job |

Good practice: a dedicated key per deploy target, limited to a deploy user on the server (no root, no shell access beyond the deploy script), rotated regularly. Put server host keys in `known_hosts` (`ssh-keyscan`) and never disable host-key checking.

## 5. Cloud access without stored keys (OIDC)

CircleCI provides an OIDC token to each job (`$CIRCLE_OIDC_TOKEN_V2`). Configure AWS (IAM role with a web identity provider), GCP (workload identity federation) or Azure to trust CircleCI **for your org ID and project ID only**, then the job exchanges the token for short-lived credentials. This avoids long-lived access keys in contexts.

Scope the cloud role to only what the job needs (e.g. push to one container repository, not admin).

## 6. Using a GitHub token (for tags/releases/comments)

If a job must call the GitHub API or push tags:

1. Create a **fine-grained personal access token** or GitHub App installation token limited to this repo, with only `contents: write` (and `pull-requests: write` if commenting).
2. Store it in a context (`GITHUB_TOKEN`), restrict the context to the `main` branch.
3. Do not reuse the token for anything else.

## 7. Network and image safety

- Pin images by major version (`cimg/node:24.x`) or digest; prefer the official `cimg/*` images.
- Pin third-party orbs (`circleci/node@5.2.0`), never `@volatile`. Review orbs from certified publishers; others run arbitrary code in your pipeline. Use **Organization Settings -> Security -> Orb policy** to allow only certified/approved orbs.
- Run `npm ci` (lockfile-exact), and `npm audit --omit=dev --audit-level=high` as an advisory step.
- Do not enable `--ignore-scripts=false` surprises: dependency install scripts run in CI with your secrets present if a context is attached, so keep contexts off the install/test jobs.

## 8. Audit and offboarding

- **Organization Settings -> Audit logs** (plan-dependent) lists context, project and member changes.
- When someone leaves: remove from the GitHub org (revokes their access and any OAuth-user-key based actions), rotate contexts/project variables they could read, remove their user SSH keys.
- Review **Settings -> Projects**, **Contexts**, **SSH Keys** and **API tokens** every quarter; delete unused ones.
- CircleCI **personal API tokens** (used for the API or CLI) are per user; store them in a password manager, never in the repo.

## Quick matrix for this project

| Job | Secrets needed | Runs on |
|---|---|---|
| install, unit tests | none | every branch and PR (including forks) |
| smoke (Mongo + Redis service containers) | none (CI-only `JWT_SECRET`) | branches and PRs; forks only if you build them |
| docker build | none | same-repo branches |
| publish image | `docker-registry` context | `main` and tags, after approval |
| deploy | `prod-deploy` context (OIDC or SSH key) | `main` / tags, after approval |
