# WebSocket protocol

Endpoint: `ws://localhost:8080/ws?token=<accessToken>` (proxied by the gateway to the game service).
An invalid/expired token is rejected during the HTTP upgrade with `401`. Frames are JSON, max 4 KB. Pings every 30 s drop dead sockets.

## Client -> server

| Message | Meaning |
|---|---|
| `{"type":"join","roomId":"..."}` | Subscribe to a game and receive the current state |
| `{"type":"roll","roomId":"..."}` | Roll the dice (only on your turn, phase `ROLL`) |
| `{"type":"move","roomId":"...","token":0}` | Move token 0-3 (only on your turn, phase `MOVE`) |
| `{"type":"ping"}` | -> `{"type":"pong"}` |

## Server -> client

| Message | When |
|---|---|
| `{"type":"joined","roomId","state"}` | Reply to `join` (also the resync point after reconnect) |
| `{"type":"waiting","roomId"}` | Room was started but the game is not created yet. Stay connected: `state` arrives when it is ready |
| `{"type":"state","state","events":[...]}` | Broadcast after every action to **all** players in the room |
| `{"type":"error","code","message"}` | Only to the sender. Codes: `NOT_YOUR_TURN`, `WRONG_PHASE`, `ILLEGAL_MOVE`, `BAD_ACTION`, `GAME_OVER`, `FORBIDDEN`, `NOT_FOUND`, `BAD_JSON`, `LOCKED` |

## Typical session

```
C -> {"type":"join","roomId":"R"}
S -> {"type":"joined","roomId":"R","state":{...}}
C -> {"type":"roll","roomId":"R"}                       (my turn)
S -> {"type":"state","state":{phase:"MOVE",dice:6,...},"events":[{"type":"rolled","userId":"U","dice":6}]}
C -> {"type":"move","roomId":"R","token":0}
S -> {"type":"state","state":{...},"events":[{"type":"moved","token":0,"from":-1,"to":0},{"type":"extra_turn"}]}
```

Reconnecting: open a new socket and `join` again - the server is stateless per connection, the Redis state is the truth.

## Ludo state

```jsonc
{
  "game": "ludo",
  "status": "playing",            // "playing" | "finished"
  "turn": 0,                      // index into players[]
  "phase": "ROLL",                // "ROLL" | "MOVE"
  "dice": null,                   // value rolled this phase (set during MOVE)
  "sixes": 0,                     // consecutive sixes this turn
  "ranking": [],                  // userIds in finishing order
  "moveCount": 0, "version": 0,   // version increments on every action - use to drop stale/out-of-order frames
  "players": [{
    "userId": "...", "username": "...",
    "seat": 0, "color": "red",    // seat decides the start cell (seat*13)
    "tokens": [-1, -1, -1, -1],   // -1 yard, 0..50 track, 51..55 home column, 56 home
    "rank": null
  }]
}
```
Track position -> board cell: `(seat * 13 + pos) % 52` for `pos <= 50`. Home-column cells (51-55) are private to the owner.

## Events

`game_started`, `rolled{userId,dice}`, `no_moves`, `three_sixes`, `moved{token,from,to}`, `captured{by,victim,token}`, `token_home`, `extra_turn`, `turn{userId}`, `player_finished{userId,rank}`, `game_over{ranking}`.
Use them to drive animations; use `state` as the source of truth.

## Client tips

* Compute legal tokens locally for UI highlighting (`pos === -1 ? dice === 6 : pos + dice <= 56`) but never trust it - the server re-validates.
* Ignore any `state` whose `version` is lower than what you already render.
