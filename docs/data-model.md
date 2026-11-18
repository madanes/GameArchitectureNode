# Data model

Each service has its own MongoDB **database** and its own Redis **key prefix**. No service reads another's data.

## MongoDB

### `auth.users`
| Field | Type | Notes |
|---|---|---|
| `_id` | string (uuid) | user id used everywhere else (`sub` in the JWT) |
| `username` | string | **unique index** |
| `email` | string | lower-cased; **unique sparse index** (guests have none) |
| `passwordHash` | string | bcrypt |
| `isGuest` | bool | |
| `createdAt` | date | |

### `lobby.rooms`
| Field | Type | Notes |
|---|---|---|
| `_id` | string (uuid) | room id = game id = match id |
| `code` | string | 6-char join code, **unique index** |
| `game` | string | engine id, e.g. `ludo` |
| `maxPlayers` | int | validated against engine metadata |
| `isPrivate` | bool | hidden from the public list |
| `status` | `waiting` \| `playing` \| `finished` | transitions are compare-and-set |
| `hostId` | string | |
| `players` | `[{userId, username}]` | |
| `createdAt`, `startedAt`, `finishedAt` | date | |

Indexes: `{status, isPrivate, game, createdAt:-1}` (open-room list), `{players.userId, status}`.

Joining is a single atomic `findOneAndUpdate` whose filter requires `status:'waiting'`, the user not already present and `size(players) < maxPlayers` - no double-joins or overfill even under races.

### `game.matches` (finished games)
`{ _id: roomId, game, players:[{userId,username}], ranking:[userId...], moves, finishedAt }`
`_id` = roomId makes the insert idempotent.

### `stats.player_stats`
`{ userId, game, username, played, wins, points, updatedAt }` - unique index `{userId, game}`; updated with `$inc` upserts.

### `stats.processed_matches`
`{ _id: matchId, at }` - idempotency ledger for `game.finished` events.

## Redis

| Key | Type | Owner | TTL | Purpose |
|---|---|---|---|---|
| `auth:refresh:{sha256(token)}` | string -> userId | auth | 30 d | Refresh tokens (hashed, single-use) |
| `game:{roomId}:state` | string (JSON) | game | 24 h (10 min after finish) | Authoritative live game state |
| `game:{roomId}:lock` | string | game | 5 s | Per-room mutex |
| `game:{roomId}:events` | pub/sub channel | game | - | State broadcast to all replicas |
| `events:room`, `events:game` | streams | lobby / game | capped ~10k | Cross-service events |
| `lobby:mm:{game}:{size}` | list | lobby | - | Quick-match queue |
| `lobby:mm:{game}:{size}:set` | set | lobby | - | Membership guard (no duplicate queueing) |
| `lobby:mm:user:{id}` / `lobby:mm:name:{id}` / `lobby:mm:matched:{id}` | string | lobby | 5-10 min | Per-user matchmaking status |
| `stats:lb:{game}` | sorted set | stats | - | Leaderboard (member = userId, score = points) |
| `rl:gw:*` | counters | gateway | window | Rate limiting |
| consumer groups `game-service`, `stats-service`, `lobby-service` | stream groups | each | - | Event delivery cursors |

## Scoring

Points per finishing rank: 1st = 30, 2nd = 15, 3rd = 5, others 0 (`POINTS` in `services/stats/src/index.js`).
