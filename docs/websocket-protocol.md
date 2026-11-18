# WebSocket protocol

Endpoint: `ws://localhost:8080/ws?token=<accessToken>` (proxied by the gateway to the game service).
One connection per player carries **both matchmaking and gameplay**. An invalid/expired token is rejected during the HTTP upgrade with `401`.
Frames are JSON, max 4 KB. Pings every 30 s drop dead sockets.

## Client -> server

| Message | Meaning |
|---|---|
| `{"type":"quickmatch","game":"ludo","maxPlayers":2}` | Join the skill-based queue (`game` defaults to `ludo`, `maxPlayers` to 2) |
| `{"type":"cancel_quickmatch"}` | Leave the queue |
| `{"type":"join","roomId":"..."}` | Subscribe to a game and receive the current state |
| `{"type":"roll","roomId":"..."}` | Roll the dice (your turn, phase `ROLL`) |
| `{"type":"move","roomId":"...","token":0}` | Move token 0-3 (your turn, phase `MOVE`) |
| `{"type":"ping"}` | -> `{"type":"pong"}` |

## Server -> client

| Message | When |
|---|---|
| `{"type":"queued","game","maxPlayers"}` | Quick-match request accepted |
| `{"type":"match_found","roomId","game","players":[{userId,username,color,isBot}]}` | A match was made (or your room started). Next: send `join` with `roomId`. Pushed even if you joined the queue on another connection/replica |
| `{"type":"mm_timeout"}` | Only when bots are disabled: nobody was found in time |
| `{"type":"quickmatch_cancelled"}` | Reply to `cancel_quickmatch` |
| `{"type":"joined","roomId","state"}` | Reply to `join` (also the resync point after reconnect) |
| `{"type":"waiting","roomId"}` | Room started but the game is not created yet. Stay connected: `state` is pushed when ready |
| `{"type":"state","state","events":[...]}` | Broadcast after every action (including timeouts and bot moves) to **all** players in the room |
| `{"type":"error","code","message"}` | Only to the sender. Codes: `NOT_YOUR_TURN`, `WRONG_PHASE`, `ILLEGAL_MOVE`, `BAD_ACTION`, `GAME_OVER`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `BAD_JSON`, `LOCKED`, `UNKNOWN_TYPE` |

## Typical session

```
C -> {"type":"quickmatch","maxPlayers":2}
S -> {"type":"queued","game":"ludo","maxPlayers":2}
   ... a few seconds: another player, or bots after MM_BOT_FILL_SEC ...
S -> {"type":"match_found","roomId":"R","players":[{"username":"alice",...},{"username":"Bot Kira","isBot":true,...}]}
C -> {"type":"join","roomId":"R"}
S -> {"type":"joined","roomId":"R","state":{...}}
C -> {"type":"roll","roomId":"R"}                       (my turn)
S -> {"type":"state","state":{phase:"MOVE",dice:6,...},"events":[{"type":"rolled","userId":"U","dice":6}]}
C -> {"type":"move","roomId":"R","token":0}
S -> {"type":"state","state":{...},"events":[{"type":"moved","token":0,"from":-1,"to":0},{"type":"extra_turn"}]}
S -> {"type":"state", ... "events":[{"type":"rolled","userId":"bot:..."}, ...]}   (bot plays after ~1 s)
```

Reconnecting: open a new socket and `join` again - the server is stateless per connection; the Redis state is the truth.
Closing the socket while queued cancels the queue entry.

## Ludo state

```jsonc
{
  "game": "ludo",
  "status": "playing",            // "playing" | "finished"
  "turn": 0,                      // index into players[]
  "phase": "ROLL",                // "ROLL" | "MOVE"
  "dice": null,                   // value rolled (set during MOVE)
  "sixes": 0,                     // consecutive sixes this turn
  "ranking": [],                  // userIds, best first (complete when finished)
  "eliminated": [],               // forfeited userIds in order
  "turnDeadline": 1794984526313,  // ms epoch: whoever must act now is auto-played (human) / moved (bot) after this
  "moveCount": 0, "version": 0,   // version increments on every action - drop stale/out-of-order frames
  "players": [{
    "userId": "...", "username": "...",
    "seat": 0, "color": "red",    // seat decides the start cell (seat*13)
    "tokens": [-1, -1, -1, -1],   // -1 yard, 0..50 track, 51..55 home column, 56 home
    "rank": null,
    "missed": 0,                  // consecutive turn timeouts (3 = forfeit)
    "forfeited": false,
    "isBot": false,
    "captures": 0
  }]
}
```
Track position -> board cell: `(seat * 13 + pos) % 52` for `pos <= 50`. Home-column cells (51-55) are private to the owner.

## Events

`game_started`, `rolled{userId,dice}`, `no_moves`, `three_sixes`, `moved{token,from,to}`, `captured{by,victim,token}`, `token_home`, `extra_turn`, `turn{userId}`, `timeout{userId}`, `forfeited{userId}`, `player_finished{userId,rank}`, `game_over{ranking}`.
Use them to drive animations; use `state` as the source of truth.

## Client tips

* Show a countdown from `turnDeadline`.
* Compute legal tokens locally for highlighting (`pos === -1 ? dice === 6 : pos + dice <= 56`) but never trust it - the server re-validates.
* Ignore any `state` whose `version` is lower than what you already render.
* Show the `isBot` flag (e.g. a robot badge) - it is part of both `match_found` and the state.
