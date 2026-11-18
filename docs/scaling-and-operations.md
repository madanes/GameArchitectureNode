# Scaling, operations and security

## Scaling

| Component | How to scale | Notes |
|---|---|---|
| gateway, auth, lobby, stats | Add replicas behind a load balancer | Stateless. Stats/lobby/game consumers share a Redis consumer group so replicas split events |
| **game** | Add replicas; any replica can serve any room | Needs no sticky sessions: state is in Redis, actions are serialised by a per-room lock, results fan out over pub/sub. WebSocket connections should be load-balanced by least-connections |
| MongoDB | Replica set for HA; later move each service DB to its own cluster | Add a shard key on `matches` (e.g. hashed `_id`) when history grows |
| Redis | Start with one instance + AOF; use Sentinel/Cluster for HA | Cluster note: keys of one room share the `game:{roomId}:*` prefix - wrap `{roomId}` in braces (`game:{id}:state`) so they hash to one slot, and Pub/Sub uses sharded channels |

Try it: `docker compose up -d --scale game=3`, point the gateway at a load-balanced name, run `npm run smoke` - players may land on different replicas and the game still works.

## Failure behaviour

| Failure | Effect |
|---|---|
| A service crashes | Others unaffected. Events (`room.started`, `game.finished`) wait in the stream; on restart the service first re-reads its un-acked events, then continues |
| Game replica dies | Its sockets drop; clients reconnect to another replica and `join` (state is in Redis). A held lock expires after 5 s |
| Redis unavailable | Gateway rate limiting fails open. Game/lobby/auth operations fail with errors until it returns. Enable AOF so state survives restarts |
| Mongo unavailable | Game play continues (Redis). If it is down at the moment a game ends, persisting the match fails, the last mover gets an error and `game.finished` is **not** published (no automatic retry yet - see roadmap item 10). Health endpoint reports `503` |
| Duplicate event delivery | Safe: all consumers are idempotent (see architecture.md) |

## Security checklist

* Set a strong `JWT_SECRET` - services **refuse to start** in `NODE_ENV=production` with the default.
* Passwords: bcrypt (cost 10). Refresh tokens are random, stored hashed, single-use.
* Auth endpoints limited to 20 req/min/IP; everything else 600 req/min/IP at the gateway.
* All HTTP input validated with zod; WebSocket frames capped at 4 KB.
* Server-side dice and move validation; clients cannot act out of turn or see other rooms (participant check on join).
* Run behind TLS (terminate at the load balancer/ingress); use `wss://` in production.
* Don't expose Mongo/Redis ports publicly (compose publishes them for local dev only - remove `ports:` in production).
* Hardening next: switch JWT to RS256 (only auth holds the private key), add `helmet` and CORS allow-list at the gateway, per-user WebSocket message rate limit.

## Observability

* **Logs:** JSON (pino) with `reqId`, method, path, status, latency. The gateway forwards `x-request-id` upstream - correlate across services.
* **Health:** `GET /health` on every service.
* **To add:** Prometheus metrics (`prom-client`: request latency, WS connections, active games, stream lag via `XPENDING`), OpenTelemetry tracing.

## Configuration (environment)

| Variable | Default | Used by |
|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017` | all but gateway |
| `REDIS_URL` | `redis://localhost:6379` | all |
| `JWT_SECRET` | dev value (rejected in prod) | all |
| `ACCESS_TTL_SEC` / `REFRESH_TTL_SEC` | 900 / 2592000 | auth |
| `AUTH_PORT` `LOBBY_PORT` `GAME_PORT` `STATS_PORT` `GATEWAY_PORT` | 4001-4004 / 8080 | each |
| `AUTH_URL` `LOBBY_URL` `GAME_URL` `STATS_URL` | localhost URLs | gateway |
| `NODE_ENV`, `LOG_LEVEL` | development, info | all |

## Roadmap / known gaps

1. **Turn timers & AFK handling** - add a Redis sorted set of deadlines (`ZADD turns <ts> roomId`) polled by the game service to auto-roll/skip.
2. **Reconnect grace & disconnect forfeits.**
3. **Bots** to fill empty seats (engine is pure, so a bot is just a function `state -> action`).
4. **Dead-letter stream** after N failed deliveries (today failures are retried on restart).
5. **Ludo blockade variant**, team play (2v2).
6. **Event schemas** (JSON Schema/zod) with versioning for the streams.
7. **TypeScript + OpenAPI** generation; CI pipeline running `npm test` and a compose-based `npm run smoke`.
8. **Wallet/economy service** (coins, entry fees) consuming `game.finished` - the existing event model supports it unchanged.
9. Redis Cluster-safe key naming (see the scaling table) before moving to a cluster.
10. **Reliable match finalisation** - write the finished-match record and the `game.finished` event through a retry/outbox so a Mongo blip at game end cannot lose a result.
