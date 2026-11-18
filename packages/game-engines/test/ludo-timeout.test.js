import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { getEngine } from '../src/index.js';
import { MAX_MISSED, YARD } from '../src/ludo/engine.js';

const ludo = getEngine('ludo');
const mk = (n = 2) => ludo.create({ players: Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, username: `P${i}` })) });
const fixed = (...values) => () => values.shift();

test('timeout rolls and moves automatically for the absent player', () => {
  const r = ludo.onTimeout(mk(), fixed(6));
  assert.equal(r.state.players[0].tokens[0], 0); // a 6 brings a token out
  assert.equal(r.state.players[0].missed, 1);
  assert.ok(r.events.some((e) => e.type === 'timeout'));
});

test('timeout with no legal move just passes the turn', () => {
  const r = ludo.onTimeout(mk(), fixed(2));
  assert.equal(r.state.turn, 1);
  assert.equal(r.state.status, 'playing');
});

test('a real action resets the missed counter', () => {
  let s = ludo.onTimeout(mk(), fixed(2)).state; // u0 missed once, now u1's turn
  s = ludo.onTimeout(s, fixed(2)).state; // u1 missed, back to u0
  assert.equal(s.players[0].missed, 1);
  s = ludo.applyAction(s, 'u0', { type: 'roll' }, fixed(2)).state;
  assert.equal(s.players[0].missed, 0);
});

test(`${MAX_MISSED} consecutive timeouts forfeit the player and end a 2-player game`, () => {
  let s = mk();
  const rng = () => 2;
  for (let i = 0; i < MAX_MISSED; i++) {
    s = ludo.onTimeout(s, rng).state; // u0 times out
    if (s.status === 'finished') break;
    s = ludo.applyAction(s, 'u1', { type: 'roll' }, rng).state; // u1 stays present
  }
  assert.equal(s.status, 'finished');
  assert.deepEqual(s.ranking, ['u1', 'u0']);
  assert.equal(s.players[0].forfeited, true);
});

test('3-player game continues after one forfeit; forfeiter ranks last', () => {
  let s = mk(3);
  s.players[0].missed = MAX_MISSED - 1;
  s = ludo.onTimeout(s, fixed(1)).state; // u0 forfeits
  assert.equal(s.status, 'playing');
  assert.equal(s.turn, 1); // turn skipped to the next active player
  s = ludo.forfeitPlayer(s, 'u2').state; // u2 leaves too -> u1 wins
  assert.equal(s.status, 'finished');
  assert.deepEqual(s.ranking, ['u1', 'u2', 'u0']); // later forfeit ranks better
});

test('forfeited players are skipped and games with random timeouts still terminate', () => {
  const rng = () => randomInt(1, 7);
  for (let g = 0; g < 30; g++) {
    let s = mk(4);
    for (let step = 0; step < 100000 && s.status === 'playing'; step++) {
      const p = s.players[s.turn];
      // player u3 is always AFK; others sometimes
      if (p.userId === 'u3' || Math.random() < 0.1) s = ludo.onTimeout(s, rng).state;
      else if (s.phase === 'ROLL') s = ludo.applyAction(s, p.userId, { type: 'roll' }, rng).state;
      else {
        const t = p.tokens.findIndex((pos) => pos !== 56 && (pos === YARD ? s.dice === 6 : pos + s.dice <= 56));
        s = ludo.applyAction(s, p.userId, { type: 'move', token: t }, rng).state;
      }
    }
    assert.equal(s.status, 'finished');
    assert.equal(new Set(s.ranking).size, 4);
  }
});
