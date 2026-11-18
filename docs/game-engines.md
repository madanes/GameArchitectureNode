# Game engines

## Ludo rules as implemented

* 2-4 players, 4 tokens each. 2 players sit on opposite seats (0 and 2).
* Shared outer track of 52 cells; seat `s` enters at cell `13*s`. Each player then walks 51 cells (positions 0-50), 5 private home-column cells (51-55) and finishes on 56.
* **Six** needed to bring a token out of the yard.
* **Extra roll** after a six, a capture, or a token reaching home.
* **Three sixes in a row** forfeit the turn (the third six is not played).
* **Exact roll** required to land on home (56); overshooting is illegal. If no token can move the turn passes.
* **Capture:** landing on a cell holding opponent token(s) sends them to their yard, unless the cell is **safe**.
* **Safe cells:** the four start cells (0, 13, 26, 39) and four star cells (8, 21, 34, 47). Home-column cells can never be attacked.
* **Ranking:** players are ranked as they bring all 4 tokens home; the game ends when one player is left (they take the last rank).
* Not implemented: blockades / "two tokens form a wall" variants. Add them inside `engines/ludo/engine.js` `move()`; nothing else needs to change.

Everything is covered by `packages/game-engines/test/ludo.test.js`, including randomised complete games.

## Engine contract

```js
export const meta = { id, name, minPlayers, maxPlayers };
export function create({ players, options }) -> state                 // players: [{userId, username}]
export function applyAction(state, userId, action, rng) -> { state, events }   // throws EngineError(code, message)
```

Rules for an engine:
1. **Pure.** No I/O, no `Date.now()`, no `Math.random()`. Randomness comes only through the injected `rng` (tests pass a scripted one).
2. **JSON state.** It is stored in Redis and sent to clients verbatim.
3. **Never mutate the input.** Clone (`structuredClone`) and return the new state - tests assert this.
4. **Validate everything**: whose turn, which phase, legality. Throw `EngineError` with a stable `code`; the game service turns it into `422` / a WS `error`.
5. Set `status: 'finished'` and fill `ranking: [userId...]` (best first) when the game ends - the platform handles persistence, events, stats and leaderboards from that.
6. Include a `version` that increments per action.

## Adding a new game (e.g. Snakes & Ladders)

1. Create `packages/game-engines/src/snakes/engine.js` implementing the contract above.
2. Register it in `packages/game-engines/src/index.js`:
   ```js
   import * as snakes from './snakes/engine.js';
   const engines = new Map([[ludo.meta.id, ludo], [snakes.meta.id, snakes]]);
   ```
3. Write `packages/game-engines/test/snakes.test.js`.
4. Done: the lobby validates player counts from `meta`, the game service plays it, stats/leaderboards key off `state.game`.

If a game needs a new action name, the WebSocket handler in `services/game/src/ws.js` forwards `roll`/`move`; extend that list (or forward a generic `{type:'action', ...}`) and the engine decides what is valid.

## Extending the dice

Dice are rolled in `gameManager.js` (`serverRng`, `crypto.randomInt`). For regulated/real-money use, replace it with an auditable RNG and persist each roll (seed + nonce) in the match record.
