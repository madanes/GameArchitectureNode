# InfinityPlay Node

A microservice platform for real-time, turn-based multiplayer games. **Ludo** is the first game;
the engine layer is pluggable so Snakes & Ladders, Carrom, card games etc. can be added without touching service code.

**Stack:** Node.js 22+ (ESM) · Express · `ws` · **MongoDB** (durable data) · **Redis** (live state, pub/sub, streams, queues, locks, leaderboards)

```
 clients ──HTTP/WS──▶ gateway :8080 ──▶ auth :4001   (accounts, JWT)
                                   ├──▶ lobby :4002  (rooms, quick-match)
                                   ├──▶ game  :4003  (WebSocket, Ludo engine, live state)
                                   └──▶ stats :4004  (stats, leaderboard)
              services talk to each other only through Redis Streams (events)
```

## Quick start

### Option A - Docker (everything)
```bash
docker compose up --build -d      # mongo, redis, 4 services, gateway
npm install && npm run smoke      # plays a full Ludo match end-to-end
```

### Option B - local processes
```bash
npm install
cp .env.example .env
npm run infra                     # mongo + redis only (docker)
npm run dev                       # all services with auto-reload
npm test                          # engine unit tests (no DB needed)
npm run smoke
```

Gateway base URL: `http://localhost:8080` (REST under `/api`, WebSocket at `/ws`).

## Repository layout

```
packages/
  common/         shared infra: config, logger, errors, Mongo/Redis clients, event bus, JWT, rate limit, locks
  game-engines/   PURE game rules (Ludo). No I/O. Fully unit-tested.
services/
  gateway/        single entry point: auth check, rate limiting, routing, WS proxy
  auth/           register / login / guest / refresh (Mongo + Redis)
  lobby/          rooms, quick-match queue
  game/           realtime play over WebSocket, authoritative state
  stats/          match results -> player stats + leaderboard
scripts/          dev runner, end-to-end smoke test
docs/             architecture, data model, API, WS protocol, engine guide, scaling
```

## Documentation

| Doc | What's inside |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Principles, service map, diagrams, request & game-flow sequences, design decisions |
| [docs/data-model.md](docs/data-model.md) | Every Mongo collection/index and Redis key, who owns it |
| [docs/api.md](docs/api.md) | REST reference with examples |
| [docs/websocket-protocol.md](docs/websocket-protocol.md) | Realtime messages and Ludo state shape |
| [docs/game-engines.md](docs/game-engines.md) | Ludo rules as implemented + how to add a new game |
| [docs/scaling-and-operations.md](docs/scaling-and-operations.md) | Scaling, failure modes, security, observability, roadmap |

## Tests

* `npm test` - 11 engine tests: rules (six to leave yard, captures, safe cells, exact home roll, three-sixes) and randomised full games for 2/3/4 players.
* `npm run smoke` - black-box test through the gateway: register, create room, join, start, play to completion over WebSocket, verify leaderboard.
