# GameArchitecture Node

A microservice platform for real-time, turn-based multiplayer games. **Ludo** is the first game;
the engine layer is pluggable so Snakes & Ladders, Carrom, card games etc. can be added without touching service code.

**Stack:** Node.js 22+ (ESM) · Express · `ws` · **MongoDB** (durable data) · **Redis** (live state, pub/sub, streams, queues, locks, leaderboards)

```
 clients ──HTTP/WS──▶ gateway :8080 ──▶ auth    :4001  accounts, JWT
                                   ├──▶ lobby   :4002  rooms + skill-based matchmaking (bots fill empty seats)
                                   ├──▶ game    :4003  WebSocket: matchmaking + gameplay, turn timers, bots
                                   ├──▶ stats   :4004  lifetime stats, points leaderboard
                                   ├──▶ league  :4005  MMR, tiers (Bronze..Master), weekly seasons
                                   └──▶ rewards :4006  coin wallet, daily login streak, daily missions
              services talk to each other only through Redis Streams (events)
```

## Features

* **Realtime play over WebSocket** - server-authoritative Ludo (server rolls dice, validates every move).
* **Matchmaking over WebSocket** - `quickmatch` request, pushed `match_found`; players grouped by skill, window widens with wait time.
* **Bots** - if no suitable human is found within a few seconds, empty seats are filled with bots of similar rating. Hosts can also start private rooms with bots.
* **Leagues** - Elo-style MMR, 6 tiers, weekly season leaderboard per tier, season-end coin rewards for the top 3.
* **Daily login rewards** (7-day streak cycle) and **daily missions** (play, win, capture) paid into a coin wallet.
* **Turn timers** - an absent player is auto-played; 3 missed turns in a row forfeits.
* **Reliable results** - finished matches are persisted/announced with retry; every event consumer is idempotent.

## Quick start

### Option A - Docker (everything)
```bash
docker compose up --build -d      # mongo, redis, 6 services, gateway
npm install && npm run smoke      # plays full games end-to-end (see note below)
```

### Option B - local processes
```bash
npm install
cp .env.example .env
npm run infra                     # mongo + redis only (docker)
npm run dev                       # all services with auto-reload
npm test                          # unit tests (no DB needed)
BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3 npm run dev   # fast bots for the smoke test
npm run smoke
```

> The smoke test plays real games including a bot match. Bots "think" for `BOT_DELAY_MS` (default 900 ms) per action, so
> start the stack with `BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3` to keep it to a few seconds. Add `SMOKE_AFK=1` and `TURN_TIMEOUT_MS=1500`
> on the game service to also test the AFK/forfeit path.

Gateway base URL: `http://localhost:8080` (REST under `/api`, WebSocket at `/ws`).

## Repository layout

```
packages/
  common/         shared infra: config, logger, errors, Mongo/Redis clients, event bus, JWT, rate limit, locks
  game-engines/   PURE game rules (Ludo, incl. timeouts, forfeits, bot move suggestion). No I/O
  rating/         PURE rating rules: Elo, tiers, ISO-week seasons, season rewards
services/
  gateway/        single entry point: auth check, rate limiting, routing, WS proxy
  auth/           register / login / guest / refresh
  lobby/          rooms; matchmaker (MMR windows, bot fill)
  game/           WebSocket server, live state, turn timers, bot driver, match persistence
  stats/          lifetime stats + points leaderboard
  league/         MMR, tiers, weekly seasons, season rewards
  rewards/        wallet + ledger, daily login, daily missions
scripts/          dev runner, end-to-end smoke test
docs/             architecture, data model, API, WS protocol, engine guide, leagues/rewards/bots, scaling
```

## Documentation

| Doc | What's inside |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Principles, service map, diagrams, flows, design decisions, event catalogue |
| [docs/leagues-rewards-bots.md](docs/leagues-rewards-bots.md) | MMR/tier/season rules, matchmaking algorithm, bots, daily rewards & missions |
| [docs/websocket-protocol.md](docs/websocket-protocol.md) | Matchmaking + gameplay messages, Ludo state shape |
| [docs/api.md](docs/api.md) | REST reference with examples |
| [docs/data-model.md](docs/data-model.md) | Every Mongo collection/index and Redis key, who owns it |
| [docs/game-engines.md](docs/game-engines.md) | Ludo rules as implemented + how to add a new game |
| [docs/scaling-and-operations.md](docs/scaling-and-operations.md) | Scaling, failure modes, security, config, roadmap |

## Tests

* `npm test` - 39 unit tests: Ludo rules, timeouts/forfeits, bots, Elo/tiers/weeks/rewards, matchmaking windows and bot fill, daily streak and missions.
* `npm run smoke` - black-box test through the gateway: room play, quick-match of two humans, bot fill, league ratings/weekly points, daily reward and mission claims (+ optional AFK forfeit).
