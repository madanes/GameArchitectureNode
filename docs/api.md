# REST API

Base URL: `http://localhost:8080/api` (via the gateway). Authenticated routes need `Authorization: Bearer <accessToken>`.
Quick-match and gameplay are **not** REST - see [websocket-protocol.md](websocket-protocol.md).

Errors always look like:
```json
{ "error": { "code": "CONFLICT", "message": "Room is full", "details": null } }
```
Common codes: `BAD_REQUEST` 400 (with zod `details`), `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429, `BAD_GATEWAY` 502.

## Auth  `/auth`  (public, rate-limited to 20 req/min/IP)

| Method & path | Body | Response |
|---|---|---|
| `POST /auth/register` | `{username (3-24, [a-zA-Z0-9_-]), email, password (8-128)}` | `201 {user, accessToken, refreshToken, expiresIn}` |
| `POST /auth/login` | `{identifier (username or email), password}` | `200` same as above |
| `POST /auth/guest` | - | `201` same as above (temporary account) |
| `POST /auth/refresh` | `{refreshToken}` | `200` new pair. The old refresh token is **invalidated** (rotation) |
| `POST /auth/logout` | `{refreshToken}` | `204` |
| `GET /auth/me` | - | `{id, username, isGuest}` |

```bash
curl -s localhost:8080/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"password123"}'
```

## Lobby  `/lobby`  (private/custom rooms)

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /lobby/games` | - | **Public.** Available games and player limits |
| `GET /lobby/rooms` | `?game=ludo` | Open public rooms (max 50) |
| `POST /lobby/rooms` | `{game='ludo', maxPlayers=4 (validated per game), isPrivate=false}` | Caller becomes host. Returns the room incl. `code` |
| `GET /lobby/rooms/:id` | - | Private rooms only visible to members |
| `POST /lobby/rooms/:idOrCode/join` | - | Join by id or 6-char code. Idempotent. `409` if full / started |
| `POST /lobby/rooms/:id/leave` | - | Only while `waiting`. Host passes to next player; empty room is deleted |
| `POST /lobby/rooms/:id/start` | `{fillWithBots=false}` | Host only. Needs min players, or `fillWithBots:true` to take every empty seat with a bot |

After `start`, open the WebSocket and `join` with the room id (you are also sent `match_found`).

## Game  `/game`

| Method & path | Notes |
|---|---|
| `GET /game/:roomId/state` | Current state snapshot (participants only) |
| `GET /game/history/me` | Your last 20 finished matches |

## League  `/league`

| Method & path | Response |
|---|---|
| `GET /league/tiers` | `[{id, min}]` |
| `GET /league/:game/me` | `{rating, peak, tier, nextTier:{id,min,pointsNeeded}, played, wins, overallRank, season:{id, endsAt, tier, points, rank, players}}` |
| `GET /league/:game/leaderboard?scope=rating\|week&tier=gold&limit=20` | `scope=rating`: global MMR board. `scope=week`: this week's board of `tier` (default bronze). `[{rank, userId, username, score, tier}]` |
| `GET /league/rewards/me` | Season rewards you earned |

## Rewards  `/rewards`

| Method & path | Response |
|---|---|
| `GET /rewards/wallet` | `{coins}` |
| `GET /rewards/ledger` | Last 50 coin movements |
| `GET /rewards/daily` | `{today, canClaim, streak, nextReward:{day,coins}, cycle:[...], nextResetAt}` |
| `POST /rewards/daily/claim` | `{reward, streak, day, balance}`; `409` if already claimed today |
| `GET /rewards/missions` | `{day, resetsAt, missions:[{id,title,target,progress,completed,claimed,coins}]}` |
| `POST /rewards/missions/:id/claim` | `{mission, reward, balance}`; `409` if not completed or already claimed |

## Stats  `/stats`

| Method & path | Response |
|---|---|
| `GET /stats/leaderboard/:game?limit=10` | Lifetime points board `[{rank, userId, username, points, played, wins}]` (limit <= 100) |
| `GET /stats/me` | `[{game, played, wins, points, rank}]` |

## Health

Every service and the gateway expose `GET /health` -> `200 {"status":"ok","checks":{...}}` or `503`. Wire these to container/Kubernetes probes.
