# REST API

Base URL: `http://localhost:8080/api` (via the gateway). Authenticated routes need `Authorization: Bearer <accessToken>`.

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
| `GET /auth/me` | - (Bearer) | `{id, username, isGuest}` |

```bash
curl -s localhost:8080/api/auth/register -H 'content-type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"password123"}'
```

## Lobby  `/lobby`

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /lobby/games` | - | **Public.** Available games and player limits |
| `GET /lobby/rooms` | `?game=ludo` | Open public rooms (max 50) |
| `POST /lobby/rooms` | `{game='ludo', maxPlayers=4 (2-8, validated per game), isPrivate=false}` | Creates a room; caller becomes host. Returns the room incl. `code` |
| `GET /lobby/rooms/:id` | - | Private rooms only visible to members |
| `POST /lobby/rooms/:idOrCode/join` | - | Join by id or 6-char code. Idempotent. `409` if full / started |
| `POST /lobby/rooms/:id/leave` | - | Only while `waiting`. Host passes to next player; empty room is deleted |
| `POST /lobby/rooms/:id/start` | - | Host only, needs min players. Emits `room.started` |
| `POST /lobby/quickmatch` | `{game='ludo', maxPlayers=2}` | `{status:'queued'}` or `{status:'matched', roomId}` |
| `GET /lobby/quickmatch` | - | Poll: `idle` \| `queued` \| `matched` (+`roomId`) |
| `DELETE /lobby/quickmatch` | - | Leave the queue |

After `start` / `matched`, open the WebSocket (see [websocket-protocol.md](websocket-protocol.md)) and `join` with the room id.

## Game  `/game`

| Method & path | Notes |
|---|---|
| `GET /game/:roomId/state` | Current state snapshot (participants only) - useful after reconnect |
| `GET /game/history/me` | Your last 20 finished matches |

## Stats  `/stats`

| Method & path | Response |
|---|---|
| `GET /stats/leaderboard/:game?limit=10` | `[{rank, userId, username, points, played, wins}]` (limit <= 100) |
| `GET /stats/me` | `[{game, played, wins, points, rank}]` |

## Health

Every service and the gateway expose `GET /health` -> `200 {"status":"ok","checks":{"mongo":"up","redis":"up"}}` or `503` when a dependency is down. Wire these to container/Kubernetes probes.
