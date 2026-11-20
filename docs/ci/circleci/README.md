# CircleCI: step-by-step integration for this Node project

Goal: on every push and pull request, install dependencies, run the unit tests, run the end-to-end smoke test (real MongoDB + Redis + all services + WebSockets), build the Docker image, and on `main` publish the image. Prerequisites: the repo is on GitHub (`madanes/GameArchitectureNode`) and you can create an account in the CircleCI organisation.

Files in this folder:

| File | Purpose |
|---|---|
| `README.md` | This guide |
| [`config.example.yml`](config.example.yml) | Ready-to-use pipeline. Copy to `.circleci/config.yml` in the repo root |
| [`permissions.md`](permissions.md) | Roles, secrets, contexts, SSH keys, fork safety, least privilege |

Vendor docs (always the source of truth): <https://circleci.com/docs/>.

---

## Step 1 - Create the CircleCI account and connect GitHub

1. Go to <https://app.circleci.com/> and choose **Sign up / Log in with GitHub**.
2. Pick the GitHub **organisation or user** that owns the repo (here `madanes`). You must be allowed to authorise apps for an organisation (owner, or an owner approves the request).
3. Authorise CircleCI. Newer accounts connect through the **GitHub App** integration (recommended: fine-grained, per-repo access, no personal user key). Older accounts use the **GitHub OAuth** app. In either case, grant access only to the repositories you need ("Only select repositories").

## Step 2 - Add the project

1. In CircleCI: **Projects -> Create Project** (or **Set Up Project** next to the repo).
2. Choose the repo `GameArchitectureNode`.
3. When asked for a config, choose **"Fastest: use the .circleci/config.yml in my repo"**, and select the branch (`main`).
4. CircleCI sets up the webhook and, for OAuth projects, a **deploy key** (read-only SSH key) so it can check out the code.

## Step 3 - Add the pipeline file

```bash
mkdir -p .circleci
cp docs/ci/circleci/config.example.yml .circleci/config.yml
git add .circleci && git commit -m "Add CircleCI pipeline" && git push
```

CircleCI starts a pipeline within seconds. Open **Pipelines** to watch it. Validate edits locally before pushing:

```bash
brew install circleci          # or see circleci.com/docs/local-cli
circleci config validate .circleci/config.yml
circleci config process .circleci/config.yml     # expands orbs, shows final YAML
```

## Step 4 - Understand the pipeline

```
workflow: build-test-deploy
  install  ->  lint/unit tests  ->  smoke (Mongo + Redis)  ->  docker build  ->  publish (main only, needs approval)
```

Key ideas used in `config.example.yml`:

| Concept | How it is used |
|---|---|
| **Executor** | `cimg/node:<LTS>` convenience image. Keep it equal to `.nvmrc` / `engines` / `Dockerfile` |
| **Service containers** | `cimg/mongo`-style images (`mongo`, `redis`) run next to the job and are reachable on `localhost` |
| **Cache** | `~/.npm` cached by `package-lock.json` checksum, so `npm ci` is fast. Cache key includes the Node major so native binaries are never reused across versions (see [native-modules](../../upgrades/node/native-modules.md)) |
| **Workspace** | Passes `node_modules` from `install` to later jobs within one workflow run |
| **Test results** | `store_test_results` shows pass/fail per test and enables flaky/timing insights |
| **Branch filters** | Publish job runs only on `main` |
| **Manual approval** | `type: approval` job gates the publish step |
| **Contexts** | Registry credentials live in a context, not in the YAML |

## Step 5 - Configure secrets (permissions summary)

Never commit tokens. Add them in the UI, then reference them by name.

1. **Organisation Settings -> Contexts -> Create Context** (e.g. `docker-registry`). Add variables such as `REGISTRY_USER`, `REGISTRY_TOKEN`, `REGISTRY_URL`. Restrict the context to a security group or project (see [permissions.md](permissions.md)).
2. Reference it in the workflow: `context: docker-registry`.
3. Project-only variables: **Project Settings -> Environment Variables** (e.g. `NPM_TOKEN` if you use a private registry).
4. Required values for tests do **not** need secrets: use throw-away values (`JWT_SECRET=ci-secret`). Never put production secrets in CI test jobs.

Details, roles, SSH keys and fork-PR safety are in [permissions.md](permissions.md).

## Step 6 - Branch protection and status checks

In GitHub: **Settings -> Branches -> Add rule** for `main`:

- Require a pull request before merging.
- **Require status checks to pass** and select the CircleCI checks (the names appear after the first run, e.g. `ci/circleci: unit-tests`).
- Require branches to be up to date; optionally require reviews and linear history.

CircleCI posts the statuses to commits and PRs automatically.

## Step 7 - Docker image and deployment

The example pipeline builds the image with `setup_remote_docker` and pushes `:<short-sha>` and `:latest` on `main` after approval. Replace the registry login with yours (Docker Hub, GHCR, ECR). For cloud registries prefer **OIDC** over long-lived keys: CircleCI exposes `$CIRCLE_OIDC_TOKEN_V2` that AWS/GCP/Azure can trust (see [permissions.md](permissions.md)).

Deploying to servers or Kubernetes: add a `deploy` job after `publish` that applies the new tag (`kubectl set image`, `docker compose pull && up -d` over SSH, or your platform's CLI). Keep the same rollout order as the upgrade guide: stateless services first, **game** replicas one at a time.

## Step 8 - Speed and cost tuning

- **Parallelism and splitting:** the test suite is small; if it grows use `parallelism: N` with `circleci tests glob ... | circleci tests split`.
- **Resource class:** `medium` (2 vCPU, 4 GB) is enough for unit tests; the smoke job runs 7 Node processes plus Mongo and Redis, so keep `medium` or use `large` if it is slow.
- **Skip work:** use `filters` / path-filtering so docs-only changes skip the smoke and docker jobs.
- **Cache the Docker layers:** enable Docker Layer Caching only if builds are slow (paid feature).
- **Auto-cancel redundant builds:** **Project Settings -> Advanced -> Auto-cancel redundant workflows**.

## Step 9 - Scheduled and release pipelines

Nightly full run (smoke with more bots, dependency audit): add a `scheduled` trigger in **Project Settings -> Triggers**, or in config use a `schedule` trigger and a workflow gated by a pipeline parameter. Tag releases (`v1.2.3`) can run the publish job with tag filters: `filters: { tags: { only: /^v.*/ }, branches: { ignore: /.*/ } }`.

## Step 10 - Verify and troubleshoot

| Symptom | Likely cause / fix |
|---|---|
| No pipeline starts on push | Project not set up, wrong branch, or `.circleci/config.yml` missing on that branch. Check **Project Settings -> Triggers** |
| `Config file not found` / YAML error | Run `circleci config validate`; check indentation |
| `Could not find a pipeline` for PRs from forks | Fork PRs do not run by default; see fork settings in [permissions.md](permissions.md) |
| `ECONNREFUSED 127.0.0.1:27017` in smoke | Service container not ready: add a wait loop (`dockerize -wait` or the `nc` loop in the example) |
| `compiled against a different Node.js version` | Cache restored binaries from another Node: bump the cache key version string |
| `permission denied (publickey)` | Deploy/user key missing or read-only; see SSH section in permissions |
| Docker `Cannot connect to the Docker daemon` | Missing `setup_remote_docker` step |
| Secret is empty in a job | Context not attached to the workflow job, or restricted to a different group |
| Smoke test too slow | Set `BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3` (already in the example) |

## Final checklist

- [ ] GitHub org connected, only needed repos authorised
- [ ] Project created, pipeline file committed to `main`
- [ ] Node image version matches `.nvmrc` / `engines` / `Dockerfile`
- [ ] Secrets in contexts / project variables, none in the repo
- [ ] Contexts restricted; roles reviewed ([permissions.md](permissions.md))
- [ ] Branch protection requires the CircleCI checks
- [ ] Fork PR policy decided (secrets not exposed)
- [ ] Publish/deploy requires approval and runs only on `main` / tags
- [ ] Config validated locally with `circleci config validate`
