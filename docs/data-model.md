# Data model

Each service has its own MongoDB **database** and its own Redis **key prefix**. No service reads another's collections.
(One deliberate exception: the `league:mmr:{game}` Redis ZSET is a published read-model that the lobby reads for matchmaking.)

## MongoDB

### `auth.users`
`{ _id (uuid), username (unique), email (unique sparse, lower-case), passwordHash (bcrypt), isGuest, createdAt }`

### `lobby.rooms`
| Field | Notes |
|---|---|
| `_id` | uuid: room id = game id = match id |
| `code` | 6-char join code, unique |
| `game`, `maxPlayers`, `isPrivate`, `hostId` | |
| `status` | `waiting` -> `playing` -> `finished` (compare-and-set transitions) |
| `players` | `[{userId, username, isBot?, rating?}]` - bots are `bot:<uuid>` |
| `matchmade` | true when created by the matchmaker |
| `createdAt`, `startedAt`, `finishedAt` | |

Indexes: `{code}` unique, `{status,isPrivate,game,createdAt:-1}`, `{players.userId,status}`.
Joining is one atomic `findOneAndUpdate` (status waiting, not already in, `size(players) < maxPlayers`).

### `game.matches`
`{ _id: roomId, game, players:[{userId,username,isBot,rating}], ranking:[userId...], moves, finishedAt }` - `_id = roomId` makes the insert idempotent.

### `stats.player_stats` / `stats.processed_matches`
`{ userId, game, username, played, wins, points }` (unique `{userId,game}`); `processed_matches` = idempotency ledger. Humans only.

### `league.ratings`
`{ userId, game, username, rating, peak, tier, played, wins, createdAt, updatedAt }` - unique `{userId,game}`, index `{game,rating:-1}`.

### `league.rewards`
`{ _id: "game:season:tier:userId", userId, game, season, tier, rank, points, coins, createdAt }`. `league.processed_matches` is the idempotency ledger.

### `rewards.wallets`
`{ _id: userId, coins, updatedAt }`

### `rewards.ledger`
`{ _id: idempotencyKey, userId, amount, reason ('daily_login'|'mission'|'season_rank'), meta, createdAt }`. The key makes every credit exactly-once, e.g. `daily:2026-11-18:<user>`, `mission:2026-11-18:win1:<user>`, `season:ludo:2026-W47:gold:<user>`.

### `rewards.daily_login`
`{ _id: userId, lastClaimDate: 'YYYY-MM-DD', streak, totalClaims }`

### `rewards.mission_progress`
`{ _id: "userId:YYYY-MM-DD", userId, day, progress:{games,wins,captures}, claimed:{missionId:true} }` - one document per player per day. `rewards.processed_matches` is the idempotency ledger.

## Redis

| Key | Type | Owner | TTL | Purpose |
|---|---|---|---|---|
| `auth:refresh:{sha256(token)}` | string -> userId | auth | 30 d | Refresh tokens (hashed, single-use) |
| `game:{roomId}:state` | string (JSON) | game | 24 h (10 min after finish) | Authoritative live game state incl. `turnDeadline` |
| `game:{roomId}:lock` | string | game | 5 s | Per-room mutex |
| `game:deadlines` | ZSET roomId -> ms | game | - | Turn timeouts and bot "thinking" deadlines scanned by the ticker |
| `game:pending-finalize` | HASH roomId -> {ts,state} | game | - | Finished games whose persistence/announcement is not confirmed; retried until done |
| `game:{roomId}:events` | pub/sub | game | - | Table updates to all replicas |
| `user:{userId}:events` | pub/sub | game | - | Personal pushes (`match_found`, `mm_timeout`) |
| `events:mm` `events:room` `events:game` `events:league` | streams | various | capped ~10k | Cross-service events |
| `lobby:mm:q:{game}:{size}` | ZSET userId -> MMR | lobby | - | Matchmaking queue |
| `lobby:mm:ticket:{userId}` | HASH | lobby | 10 min | `{username, game, size, mmr, since}` |
| `lobby:mm:queues` | set | lobby | - | Queues that may contain players |
| `lobby:mm:lock` | string | lobby | 0.9 s | One ticker at a time |
| `league:mmr:{game}` | ZSET userId -> MMR | league | - | Global rating board; read by lobby; rebuilt from Mongo if empty |
| `league:week:{game}:{season}:{tier}` | ZSET userId -> weekly points | league | 35 d | Weekly board per tier |
| `league:season:{game}` | string | league | - | Currently active season id |
| `league:rollover:lock` | string | league | 5 s | One replica closes a season |
| `stats:lb:{game}` | ZSET | stats | - | Lifetime points leaderboard |
| `rl:gw:*` | counters | gateway | window | Rate limiting |
| consumer groups `game-service`, `lobby-service`, `stats-service`, `league-service`, `rewards-service` | stream groups | each | - | Event delivery cursors |
