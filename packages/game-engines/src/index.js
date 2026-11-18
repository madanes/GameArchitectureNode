/**
 * Game engine registry.
 *
 * An engine is a PURE module (no I/O, no clock, no randomness of its own) with this contract:
 *
 *   meta: { id, name, minPlayers, maxPlayers }
 *   create({ players: [{userId, username}], options }) -> state          (JSON-serialisable)
 *   applyAction(state, userId, action, rng) -> { state, events }          (throws EngineError)
 *   onTimeout(state, rng) -> { state, events }      the current player ran out of time: play for them,
 *                                                    or forfeit them after repeated misses
 *   suggestAction(state) -> action | null           what a reasonable player would do now (bots, auto-play)
 *   players may carry isBot:true; the platform plays their turns via suggestAction
 *   rng: () => integer 1..6 (injected so tests are deterministic)
 *
 * State is plain JSON so it can live in Redis and be sent to clients unchanged.
 * When the game ends: state.status === 'finished' and state.ranking lists userIds, best first.
 * To add a game: implement the contract, register it below. No service code changes.
 */
import * as ludo from './ludo/engine.js';

export { EngineError } from './errors.js';

const engines = new Map([[ludo.meta.id, ludo]]);

export const getEngine = (id) => engines.get(id);
export const listGames = () => [...engines.values()].map((e) => e.meta);
