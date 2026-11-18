# Scaling, operations and security

## Scaling

| Component | How to scale | Notes |
|---|---|---|
| gateway, auth, stats, rewards | Add replicas behind a load balancer | Stateless. Event consumers share a Redis consumer group per service, so replicas split the events |
| lobby | Add replicas | Matchmaker ticker is guarded by a Redis lock (one runs at a time); queue ops are atomic Redis calls |
| league | Add replicas | Rollover guarded by a lock; closing a season is idempotent |
| **game** | Add replicas; any replica can serve any room | No sticky sessions: state is in Redis, actions serialised by a per-room lock, results fan out over pub/sub. Timers and bots live in Redis (`game:deadlines`), not in process memory, so every replica can serve due rooms and a crash loses nothing. Load-balance WebSockets by least-connections |
| MongoDB | Replica set for HA; later move each service DB to its own cluster | Shard `matches` by hashed `_id` when history grows; `rewards.ledger` and `mission_progress` grow per user per day - add a TTL index on old `mission_progress` if you do not need history |
| Redis | One instance + AOF to start; Sentinel/Cluster for HA | Cluster note: wrap the room id in hash tags (`game:{id}:state`, `game:{id}:lock`) so a room's keys share a slot, and use sharded Pub/Sub |

Try it: `docker compose up -d --scale game=3`, point the gateway at a load-balanced name, run the smoke test - players may land on different replicas and everything still works.

## Failure behaviour

| Failure | Effect |
|---|---|
| A service crashes | Others unaffected. Events wait in the stream; on restart the service first re-reads its un-acked events |
| Game replica dies | Its sockets drop; clients reconnect to another replica and `join` (state is in Redis). A held lock expires after 5 s; timers/bots continue on other replicas |
| Redis unavailable | Gateway rate limiting fails open. Game, lobby matchmaking and auth fail until it returns. Enable AOF so state survives restarts |
| Mongo unavailable at game end | The match is parked in `game:pending-finalize` and retried every 5 s until it is stored and `game.finished` is published; the player's last action is not failed. All consumers are idempotent |
| League service down for a while | Matchmaking falls back to rating 1000 for unknown players; ratings/missions catch up from the stream when services return |
| Duplicate event delivery | Safe: all consumers are idempotent (see architecture.md) |
| Player disconnects mid-game | Their turns are auto-played; after 3 missed turns they forfeit. They can rejoin any time before that |

## Security checklist

* Set a strong `JWT_SECRET` - services **refuse to start** in `NODE_ENV=production` with the default.
* Passwords: bcrypt (cost 10). Refresh tokens are random, stored hashed, single-use.
* Auth endpoints limited to 20 req/min/IP; everything else 600 req/min/IP at the gateway.
* All HTTP input validated with zod; WebSocket frames capped at 4 KB; matchmaking requests validated against engine metadata.
* Server-side dice and move validation; clients cannot act out of turn or see other rooms (participant check on join).
* Wallet credits are idempotent and ledgered; there is no endpoint that lets a client choose an amount.
* Run behind TLS (terminate at the load balancer); use `wss://` in production.
* Don't expose Mongo/Redis ports publicly (compose publishes them for local dev only - remove `ports:` in production).
* Hardening next: RS256 JWTs (only auth holds the private key), `helmet` + CORS allow-list at the gateway, per-user WebSocket message rate limit (a client could spam `quickmatch`; each call just re-queues but still costs an event).

## Observability

* **Logs:** JSON (pino) with `reqId`, method, path, status, latency. The gateway forwards `x-request-id` upstream.
* **Health:** `GET /health` on every service.
* **To add:** Prometheus metrics (request latency, WS connections, queue length and wait time, active games, `game:pending-finalize` size, stream lag via `XPENDING`), OpenTelemetry tracing.

## Configuration (environment)

| Variable | Default | Used by |
|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017` | all but gateway |
| `REDIS_URL` | `redis://localhost:6379` | all |
| `JWT_SECRET` | dev value (rejected in prod) | all |
| `ACCESS_TTL_SEC` / `REFRESH_TTL_SEC` | 900 / 2592000 | auth |
| `*_PORT` | gateway 8080, auth 4001, lobby 4002, game 4003, stats 4004, league 4005, rewards 4006 | each |
| `*_URL` (`AUTH_URL` ... `REWARDS_URL`) | localhost URLs | gateway |
| `TURN_TIMEOUT_MS` | 20000 | game |
| `BOT_DELAY_MS` | 900 | game |
| `MM_BOTS` | `on` | lobby |
| `MM_BOT_FILL_SEC` | 10 | lobby |
| `MM_MAX_WAIT_SEC` | 60 (only with `MM_BOTS=off`) | lobby |
| `NODE_ENV`, `LOG_LEVEL` | development, info | all |

## Roadmap / known gaps

1. **Friends & invites**, presence, party queue (queue as a group).
2. **Push notifications** (daily reward ready, season ended, match found while the app is backgrounded) - consume `league.season_ended` and friends.
3. **Reconnect UX**: grace period before turn timeouts start counting, "resume your game" lookup (an endpoint listing the caller's active games).
4. **Smarter bots / difficulty levels**; bot-aware tuning of `BOT_GAME_FACTOR`.
5. **More missions** (weekly missions, streak missions, achievements) - plain data in `definitions.js`.
6. **Wallet spending**: entry fees, shop, cosmetics; ledger already supports debits (negative amounts) but no endpoint exists.
7. **Promotion/relegation leagues** (cohorts of ~30 players per week) instead of MMR-derived tiers.
8. **Blockade variant**, team play (2v2), more games via the engine contract.
9. **Dead-letter stream** after N failed event deliveries (today failures are retried on restart).
10. **Event schemas** (versioned zod/JSON Schema) for the streams.
11. **TypeScript + OpenAPI** generation; CI running `npm test` and a compose-based `npm run smoke`.
12. Redis Cluster-safe key naming before moving to a cluster.
13. **Anti-abuse:** rating/rewards audit trail, detection of win-trading, per-user WebSocket rate limits.
