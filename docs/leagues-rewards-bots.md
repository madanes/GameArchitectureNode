# Leagues, matchmaking, bots, daily rewards and missions

All numbers below live in code and are easy to tune (file in brackets).

## 1. Ratings (MMR)  - `packages/rating/src/index.js`

* Every player starts at **1000** per game.
* After each finished game, **multiplayer Elo** is applied: every pair of players is treated as a 1v1 (higher finish wins), averaged over the `n-1` opponents, `K = 32`. An equal-rated 1v1 is +16 / -16; an upset pays more; a 4-player game moves ratings about as much as a 1v1.
* Rating never drops below 0. `peak` is tracked.
* **Games with bots** use the bots' rating (they carry the rating they were matched at) but all changes and weekly points are multiplied by `BOT_GAME_FACTOR = 0.5`. Bots themselves are never stored.

## 2. Leagues (tiers)

| Tier | MMR from | Season reward multiplier |
|---|---|---|
| Bronze | 0 | x1 |
| Silver | 1050 | x1.5 |
| Gold | 1150 | x2 |
| Platinum | 1300 | x3 |
| Diamond | 1500 | x4 |
| Master | 1700 | x5 |

A player's tier is derived from their MMR, so it moves as they win and lose. `GET /league/:game/me` returns the tier plus the distance to the next one.

## 3. Weekly seasons

* A season is an **ISO week** (Monday 00:00 UTC -> next Monday), id like `2026-W47`.
* Each finished game adds **weekly points** to the board of the tier the player was in when the game started: 1st = 30, 2nd = 15, 3rd = 5, others 0 (halved in bot games).
* The league service checks every 30 s whether the week changed. On rollover (guarded by a Redis lock) it closes the old season: the **top 3 of every tier board** with positive points receive coins (`1000 / 500 / 250` x tier multiplier), stored in `league.rewards` and announced as `league.reward` events. The rewards service credits the wallet. Closing is idempotent (reward `_id = game:season:tier:user`; wallet ledger key likewise), so a crash mid-rollover is simply retried.

## 4. Matchmaking  - `services/lobby/src/matching.js`, `matchmaker.js`

1. The client sends `{"type":"quickmatch","maxPlayers":2}` on the game WebSocket. The game service validates it and emits `mm.join`.
2. The lobby reads the player's MMR from `league:mmr:{game}` (default 1000) and adds them to the queue `lobby:mm:q:{game}:{size}` (sorted by MMR) with a ticket (`since` timestamp).
3. A **1-second ticker** (one replica at a time) looks at each queue sorted by MMR and slides a window of `size` players. A window matches if `maxMMR - minMMR <= 100 + 25 x seconds the longest-waiting player has waited`. Quality first, but nobody waits forever.
4. **Bot fill:** if nobody matches and the longest-waiting player has waited `MM_BOT_FILL_SEC` (default 10 s), that player (plus any humans within range) is seated and every empty seat gets a bot rated close to the humans' average. Set `MM_BOTS=off` to disable; then players get `mm_timeout` after `MM_MAX_WAIT_SEC`.
5. The group is removed from the queue one player at a time with `ZREM` (a concurrent cancel aborts the match and returns the others to the queue), a room is created and started, `room.started` fires, the game service creates the game and pushes `match_found` to every human over `user:{id}:events`.
6. Disconnecting while queued cancels the queue entry.

Private rooms can also be started with bots: `POST /lobby/rooms/:id/start {"fillWithBots": true}`.

## 5. Bots  - `suggestAction` in the engine, driver in `services/game/src/gameManager.js`

* A bot is just a player with `isBot: true` and a `bot:<uuid>` id; it has no socket.
* After each committed action the manager stamps a deadline: `BOT_DELAY_MS` (default 900 ms, "thinking time") when it is a bot's turn. The ticker then calls `engine.suggestAction(state)`: roll; then finish a token if possible, otherwise bring a token out of the yard, otherwise advance the furthest token.
* Bots never appear on leaderboards, in stats, in ratings or in missions; they do count as opponents for the humans' Elo (at half weight).
* To make bots smarter, only `suggestAction` needs to change (the same function also powers AFK auto-play).

## 6. Turn timers and forfeits

* A human has `TURN_TIMEOUT_MS` (default 20 s) per action. On timeout the engine plays the turn for them (`onTimeout`) and `missed` increases; any real action resets it to 0.
* After **3 consecutive misses** the player forfeits: their tokens are removed, they are skipped, and they rank below everyone still playing (a later forfeit ranks better than an earlier one). If one player remains, the game ends.
* The client sees `turnDeadline` (ms epoch) in the state to draw a countdown.

## 7. Wallet, daily login reward, missions  - `services/rewards`

**Wallet:** `wallets` holds the balance; `ledger` holds every movement with an idempotency key (`daily:<day>:<user>`, `mission:<day>:<id>:<user>`, `season:<game>:<season>:<tier>:<user>`), so retries never pay twice.

**Daily login** (UTC days): claim once per day. Consecutive days continue the streak, a gap resets it. Coins by streak day: `50, 60, 80, 100, 150, 200, 500`, then the cycle restarts. Claims are compare-and-set on the previous claim date, so two concurrent claims cannot both succeed.

**Daily missions** (reset 00:00 UTC), progress counted from every finished game (including bot games):

| Id | Mission | Reward |
|---|---|---|
| `play3` | Play 3 games | 100 |
| `win1` | Win a game | 150 |
| `capture3` | Capture 3 opponent tokens | 120 |

Progress is read from `game.finished` (`ranking` and per-player `captures`). Claiming is explicit (`POST /rewards/missions/:id/claim`) and only possible once completed and not yet claimed.

Mission definitions are plain data in `services/rewards/src/definitions.js`; to add a mission add an entry and, if it needs a new counter, extend `progressFromGame` and the event's `stats`.
