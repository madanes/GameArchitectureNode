# Upgrading Node.js (example: 16 -> latest LTS)

This repo already targets **Node >= 22.9** (`engines` in `package.json`, `FROM node:22-alpine` in the `Dockerfile`). If an older machine, CI image or server still runs Node 16, follow this guide. Node 16 has been end-of-life since September 2023 and receives no security fixes.

Always pick an **LTS (even-numbered) release**, never an odd "Current" one, for production. Check the current LTS at <https://nodejs.org/en/about/previous-releases>.

## Step 0 - Inventory

```bash
node -v && npm -v
grep -rn "node:" Dockerfile docker-compose.yml .github 2>/dev/null   # image tags / CI
cat .nvmrc 2>/dev/null; grep -n '"engines"' -A2 package.json
```

## Step 1 - Install a version manager (once)

```bash
# macOS / Linux
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# or: brew install fnm   /   volta install node
```

## Step 2 - Hop through the majors in a branch

You can jump straight to the latest LTS, but if something breaks, bisecting is easier when you move in steps and run the tests at each one:

```bash
git checkout -b chore/upgrade-node
for v in 18 20 22 24; do      # add the newest LTS if higher
  nvm install $v && nvm use $v
  rm -rf node_modules package-lock.json   # only if dependency resolution fails; otherwise keep the lockfile
  npm ci || npm install
  npm test || break
done
```

## Step 3 - What changes when leaving Node 16

| Change | Impact here |
|---|---|
| Native `fetch` and `AbortController` (18+) | No code change; you may drop `node-fetch`/`axios` if added later |
| `node --test` built-in runner (18+, stable 20+) | We use it for `npm test`. On newer Node pass a **glob**, not a directory (`node --test "packages/*/test/*.test.js"`) |
| `--watch` flag (18.11+/20) | `npm run dev` style reloads without nodemon |
| OpenSSL 3 (17+) | Old crypto algorithms (md4, some RSA keys) can fail with `ERR_OSSL_EVP_UNSUPPORTED`. We use `jsonwebtoken` HS256, bcrypt, `crypto.randomInt`: unaffected. If you add RS256 keys, use PKCS#8 / 2048+ bit |
| `localhost` resolves to IPv6 first (17+) | If a service cannot reach `localhost`, use `127.0.0.1` or set `--dns-result-order=ipv4first`. Check `MONGO_URL`, `REDIS_URL` and the gateway's `*_URL`s |
| Unhandled promise rejections crash the process (15+) | Good: the services already log and exit; watch logs for new crashes after upgrading |
| ESM-only packages / `require(esm)` (22+) | The repo is pure ESM (`"type":"module"`), nothing to change |
| Stricter `http` header/URL parsing (various) | Re-test gateway proxy and `/ws` upgrade |
| Removed/changed APIs | Search release notes for `url.parse` deprecations, `fs.rmdir(recursive)`, `process.binding` |

Read the "Notable changes" for each major: <https://nodejs.org/en/blog/release>.

## Step 4 - Dependencies

```bash
npm outdated
npm update                      # within semver ranges
npm audit
```

Packages that matter for runtime compatibility:

| Package | Why it matters | Note |
|---|---|---|
| `mongodb` driver | Node version support matrix | 6.x supports Node 16.20+; keep it recent |
| `ioredis` | works on all supported LTS | |
| `ws` | WebSocket server | 8.x works on Node 10+; no change needed |
| `http-proxy-middleware` | `/ws` upgrade proxying in the gateway | After upgrading Node, open a socket through the gateway to verify |
| `bcryptjs` | pure JS, safe across versions | If you switch to native `bcrypt`, it needs a rebuild per Node version |

Update `engines`:

```json
"engines": { "node": ">=24" }
```

> **Native modules** (bcrypt, sharp, argon2, sqlite3, ...) must be rebuilt for the new Node: see [native-modules.md](native-modules.md).

## Step 5 - Pin the version everywhere

```bash
echo "24" > .nvmrc                                   # use the target LTS major
sed -i.bak 's/node:22-alpine/node:24-alpine/' Dockerfile && rm Dockerfile.bak
```

(Use the number of the LTS you chose. Edit CI workflow images the same way.) Prefer a pinned minor in production (`node:24.x.y-alpine`) for reproducible builds, and bump it on a schedule.

## Step 6 - Test

```bash
npm ci
npm test
docker compose build --no-cache
docker compose up -d
BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3 npm run smoke
```

Manually verify the **socket path**: connect with `wscat -c "ws://localhost:8080/ws?token=<jwt>"`, send `{"type":"quickmatch","maxPlayers":2}`, expect `queued`, then `match_found` (bots after `MM_BOT_FILL_SEC`).

Check memory/CPU after a few minutes: newer V8 versions change GC behaviour, so compare with the old baseline.

## Step 7 - Roll out

Stateless services can be rolled one replica at a time (`docker compose up -d --no-deps --build <service>` or a Kubernetes rolling update):

1. auth, stats, rewards, league (no sockets).
2. lobby (matchmaker is lock-guarded, only one ticker runs at a time).
3. gateway.
4. **game**, one replica at a time. Its sockets drop; clients reconnect and `join`. Timers and bots live in Redis, so no match is lost. Wait for the replica to be healthy before the next.

## Rollback

Revert the Dockerfile/`.nvmrc` commit and redeploy the previous image tag. Nothing persistent changes when you move Node, so rollback is safe at any point.

## Checklist

- [ ] CI and Docker images on the new LTS
- [ ] `engines`, `.nvmrc`, `Dockerfile` updated
- [ ] `npm test` and `npm run smoke` pass
- [ ] WebSocket matchmaking verified through the gateway
- [ ] Lockfile committed, `npm audit` reviewed
- [ ] Rolled out service by service, game replicas last
