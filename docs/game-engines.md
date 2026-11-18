# Game engines

## Ludo rules as implemented

* 2-4 players, 4 tokens each. 2 players sit on opposite seats (0 and 2).
* Shared outer track of 52 cells; seat `s` enters at cell `13*s`. Each player then walks 51 cells (positions 0-50), 5 private home-column cells (51-55) and finishes on 56.
* **Six** needed to bring a token out of the yard.
* **Extra roll** after a six, a capture, or a token reaching home.
* **Three sixes in a row** forfeit the turn (the third six is not played).
* **Exact roll** required to land on home (56). If no token can move the turn passes.
* **Capture:** landing on a cell holding opponent token(s) sends them to their yard, unless the cell is **safe**. Captures are counted per player (`captures`, used by missions).
* **Safe cells:** the four start cells (0, 13, 26, 39) and four star cells (8, 21, 34, 47). Home-column cells can never be attacked.
* **Ranking:** players rank as they bring all 4 tokens home; the game ends when one player is left (they take the last active rank).
* **Timeout:** `onTimeout` plays the turn for an absent player (roll, then `suggestAction`'s move). Every real action resets `missed`.
* **Forfeit:** 3 consecutive timeouts (`MAX_MISSED`) remove the player; they rank below everyone still playing, later forfeits rank better than earlier ones. When one active player remains the game ends.
* Not implemented: blockades / "two tokens form a wall" variants. Add them in `move()`; nothing else changes.

Everything is covered by `packages/game-engines/test/` (rules, timeouts, forfeits, bots, randomised complete games including AFK players).

## Engine contract

```js
export const meta = { id, name, minPlayers, maxPlayers };
export function create({ players, options }) -> state                      // players: [{userId, username, isBot?}]
export function applyAction(state, userId, action, rng) -> { state, events }   // throws EngineError(code, message)
export function onTimeout(state, rng) -> { state, events }                 // current player ran out of time
export function suggestAction(state) -> action | null                      // what a sensible player would do (bots, auto-play)
```

Rules for an engine:
1. **Pure.** No I/O, no `Date.now()`, no `Math.random()`. Randomness only through the injected `rng`; time is handled by the platform (it calls `onTimeout`).
2. **JSON state.** Stored in Redis and sent to clients verbatim.
3. **Never mutate the input.** Clone and return the new state - tests assert this.
4. **Validate everything**: whose turn, which phase, legality. Throw `EngineError` with a stable `code`.
5. When the game ends set `status: 'finished'` and `ranking: [userId...]` (best first). The platform handles persistence, events, ratings, missions, leaderboards from that.
6. Increment `version` per action. Players should carry `isBot`, `missed`, `forfeited`; per-player counters that missions need (e.g. `captures`) are exported in the `game.finished` event by the game service.

## Adding a new game (e.g. Snakes & Ladders)

1. Create `packages/game-engines/src/snakes/engine.js` implementing the contract above.
2. Register it in `packages/game-engines/src/index.js`:
   ```js
   import * as snakes from './snakes/engine.js';
   const engines = new Map([[ludo.meta.id, ludo], [snakes.meta.id, snakes]]);
   ```
3. Write `packages/game-engines/test/snakes.test.js`.
4. Done: the lobby validates player counts from `meta`, matchmaking and bots work through `suggestAction`, the game service plays it, leagues/stats key off `state.game`. Leagues get a new per-game rating board automatically (`listGames()`).

If a game needs a new action name, the WebSocket handler in `services/game/src/ws.js` forwards `roll`/`move`; extend that list (or forward a generic `{type:'action', ...}`) and the engine decides what is valid.

## Dice

Dice are rolled in `gameManager.js` (`serverRng`, `crypto.randomInt`). For regulated/real-money use, replace it with an auditable RNG and persist each roll (seed + nonce) in the match record.
