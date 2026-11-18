/**
 * Ludo rules engine (2-4 players, 4 tokens each).
 *
 * Board model
 *  - Shared outer track of 52 cells, indexed 0..51 ("absolute cells").
 *  - Each seat enters the track at its own start cell: seat * 13.
 *  - A token's position is RELATIVE to its owner:
 *        -1        in the yard (base)
 *        0..50     on the outer track (absolute cell = (seat*13 + pos) % 52)
 *        51..55    in the private home column (nobody else can ever land here)
 *        56        HOME (finished)
 *  - Safe cells (no capture): the 4 start cells and the 4 star cells.
 *
 * Rules implemented
 *  - A 6 is needed to leave the yard.
 *  - A 6, a capture, or bringing a token HOME grants another roll.
 *  - Three consecutive 6s forfeit the turn.
 *  - An exact roll is needed to reach HOME.
 *  - Landing on a lone opponent on a non-safe cell sends it back to the yard.
 *  - Players are ranked in finishing order; the game ends when one player remains.
 * Not implemented (documented): blockades / stacked-token rules.
 */
import { EngineError } from '../errors.js';

export const meta = { id: 'ludo', name: 'Ludo', minPlayers: 2, maxPlayers: 4 };

export const TRACK = 52;
export const YARD = -1;
export const LAST_TRACK_POS = 50;
export const HOME = 56;
export const TOKENS = 4;
export const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLORS = ['red', 'green', 'yellow', 'blue'];
const SEATS = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

export const absCell = (seat, pos) => (seat * 13 + pos) % TRACK;

export function create({ players }) {
  if (players.length < meta.minPlayers || players.length > meta.maxPlayers) {
    throw new EngineError('BAD_PLAYER_COUNT', `Ludo needs ${meta.minPlayers}-${meta.maxPlayers} players`);
  }
  const seats = SEATS[players.length];
  return {
    game: meta.id,
    status: 'playing', // 'playing' | 'finished'
    players: players.map((p, i) => ({
      userId: p.userId,
      username: p.username,
      seat: seats[i],
      color: COLORS[seats[i]],
      tokens: Array(TOKENS).fill(YARD),
      rank: null,
    })),
    turn: 0, // index into players[]
    phase: 'ROLL', // 'ROLL' | 'MOVE'
    dice: null,
    sixes: 0, // consecutive sixes this turn
    ranking: [], // userIds in finishing order
    moveCount: 0,
    version: 0,
  };
}

/** Indexes of the current player's tokens that can legally move with the current dice. */
export function legalMoves(state) {
  const p = state.players[state.turn];
  const out = [];
  p.tokens.forEach((pos, i) => {
    if (pos === HOME) return;
    if (pos === YARD ? state.dice === 6 : pos + state.dice <= HOME) out.push(i);
  });
  return out;
}

export function applyAction(rawState, userId, action, rng) {
  const state = structuredClone(rawState);
  if (state.status !== 'playing') throw new EngineError('GAME_OVER', 'Game is finished');
  const player = state.players[state.turn];
  if (player.userId !== userId) throw new EngineError('NOT_YOUR_TURN', 'It is not your turn');

  const events = [];
  if (action?.type === 'roll') roll(state, player, rng, events);
  else if (action?.type === 'move') move(state, player, action.token, events);
  else throw new EngineError('BAD_ACTION', 'Unknown action');

  state.version += 1;
  return { state, events };
}

function roll(state, player, rng, events) {
  if (state.phase !== 'ROLL') throw new EngineError('WRONG_PHASE', 'You must move a token');
  const dice = rng();
  state.dice = dice;
  state.sixes = dice === 6 ? state.sixes + 1 : 0;
  events.push({ type: 'rolled', userId: player.userId, dice });

  if (state.sixes === 3) {
    events.push({ type: 'three_sixes', userId: player.userId });
    return endTurn(state, events);
  }
  if (legalMoves(state).length === 0) {
    events.push({ type: 'no_moves', userId: player.userId });
    return endTurn(state, events);
  }
  state.phase = 'MOVE';
}

function move(state, player, token, events) {
  if (state.phase !== 'MOVE') throw new EngineError('WRONG_PHASE', 'You must roll first');
  if (!Number.isInteger(token) || !legalMoves(state).includes(token)) {
    throw new EngineError('ILLEGAL_MOVE', 'That token cannot move');
  }
  const from = player.tokens[token];
  const to = from === YARD ? 0 : from + state.dice;
  player.tokens[token] = to;
  state.moveCount += 1;
  events.push({ type: 'moved', userId: player.userId, token, from, to });

  let captured = false;
  if (to <= LAST_TRACK_POS && !SAFE_CELLS.has(absCell(player.seat, to))) {
    const cell = absCell(player.seat, to);
    for (const other of state.players) {
      if (other === player) continue;
      other.tokens.forEach((pos, i) => {
        if (pos >= 0 && pos <= LAST_TRACK_POS && absCell(other.seat, pos) === cell) {
          other.tokens[i] = YARD;
          captured = true;
          events.push({ type: 'captured', by: player.userId, victim: other.userId, token: i });
        }
      });
    }
  }

  const reachedHome = to === HOME;
  if (reachedHome) events.push({ type: 'token_home', userId: player.userId, token });

  if (player.tokens.every((p) => p === HOME)) {
    state.ranking.push(player.userId);
    player.rank = state.ranking.length;
    events.push({ type: 'player_finished', userId: player.userId, rank: player.rank });
    const remaining = state.players.filter((p) => p.rank === null);
    if (remaining.length <= 1) {
      for (const p of remaining) { state.ranking.push(p.userId); p.rank = state.ranking.length; }
      state.status = 'finished';
      state.phase = 'ROLL';
      state.dice = null;
      events.push({ type: 'game_over', ranking: state.ranking });
      return;
    }
    return endTurn(state, events);
  }

  if (state.dice === 6 || captured || reachedHome) {
    events.push({ type: 'extra_turn', userId: player.userId });
    state.phase = 'ROLL';
    state.dice = null;
    return;
  }
  endTurn(state, events);
}

function endTurn(state, events) {
  let next = state.turn;
  do { next = (next + 1) % state.players.length; } while (state.players[next].rank !== null);
  state.turn = next;
  state.phase = 'ROLL';
  state.dice = null;
  state.sixes = 0;
  events.push({ type: 'turn', userId: state.players[next].userId });
}
