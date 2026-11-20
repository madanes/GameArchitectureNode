# Upgrade guides: Node.js, Redis, MongoDB

Step-by-step guides for moving the platform's three runtime dependencies to the latest stable release.

| Guide | Starting point (example) | Target |
|---|---|---|
| [node/](node/README.md) | Node 16 | Latest **LTS** (check <https://nodejs.org/en/about/previous-releases>) |
| [redis/](redis/README.md) | Redis 6/7 | Latest stable 8.x (check <https://redis.io/downloads/>) |
| [mongodb/](mongodb/README.md) | MongoDB 4.4-7.0 | Latest stable major (check <https://www.mongodb.com/docs/manual/release-notes/>) |

> Versions move. Always confirm "latest stable" on the vendor pages above before you start; the steps are version-independent.

## What in this project depends on them

| Part | Node | Redis | MongoDB |
|---|---|---|---|
| gateway (REST proxy + `/ws` proxy) | runtime, `http-proxy-middleware` | rate-limit counters | - |
| auth | runtime | refresh tokens | `auth.users` |
| lobby (REST + matchmaker) | runtime | queues, tickets, locks, streams | `lobby.rooms` |
| **game (WebSocket gameplay)** | runtime, `ws` | live state, per-room lock, `game:deadlines` ZSET, pub/sub, streams | `game.matches` |
| stats, league, rewards | runtime | streams, ZSET leaderboards | their own DBs |

The sockets are the most sensitive part: a Redis or Node restart drops every WebSocket. Players reconnect and `join` again because state lives in Redis, but plan upgrades for a quiet window and roll game replicas one at a time.

## Recommended order

1. **Backups and a staging copy** of Mongo and Redis (see each guide).
2. **MongoDB** first (slowest, hop one major at a time, drivers are backward compatible).
3. **Redis** second (rolling replica swap, `ioredis` is compatible).
4. **Node** last (rebuild images, run tests, roll services).

Doing Node last means the code you test against is already running the target data stores. Doing it the other way round also works; never upgrade all three in one deploy, so a regression is easy to attribute.

## Universal safety checklist

- [ ] Backup taken **and a restore tested**.
- [ ] Upgrade done on staging first, with `npm test` and `npm run smoke` green.
- [ ] Release notes read for every major version you cross.
- [ ] Rollback plan written down (what, who, how long).
- [ ] Deploy window chosen outside peak hours; players warned if sockets will drop.
- [ ] Dashboards open: `/health` of every service, `game:pending-finalize` size, error logs.
- [ ] Change merged in git (Dockerfile, compose, `engines`, `.nvmrc`) so the repo describes what runs.

## Verifying after any upgrade

```bash
npm test                 # 39 unit tests
npm run smoke            # end-to-end: register, quickmatch over WS, bots, league, rewards
curl -s localhost:8080/health
```

Smoke test tip: start the stack with `BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3` so bot games finish quickly.
