import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { getEngine, EngineError } from '../src/index.js';
import { HOME, YARD, legalMoves } from '../src/ludo/engine.js';

const ludo = getEngine('ludo');
const mk = (n = 2) => ludo.create({ players: Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, username: `P${i}` })) });
const fixed = (...values) => () => values.shift();
const act = (s, u, a, rng) => ludo.applyAction(s, u, a, rng);

test('cannot leave the yard without a six', () => {
  const s = mk();
  const r = act(s, 'u0', { type: 'roll' }, fixed(3));
  assert.equal(r.state.turn, 1); // no legal move -> turn passes
  assert.ok(r.events.some((e) => e.type === 'no_moves'));
});

test('a six leaves the yard and grants another roll', () => {
  let s = act(mk(), 'u0', { type: 'roll' }, fixed(6)).state;
  assert.equal(s.phase, 'MOVE');
  s = act(s, 'u0', { type: 'move', token: 0 }, null).state;
  assert.equal(s.players[0].tokens[0], 0);
  assert.equal(s.turn, 0);
  assert.equal(s.phase, 'ROLL');
});

test('three sixes in a row forfeit the turn', () => {
  let s = mk();
  for (let i = 0; i < 2; i++) {
    s = act(s, 'u0', { type: 'roll' }, fixed(6)).state;
    s = act(s, 'u0', { type: 'move', token: i }, null).state;
  }
  const r = act(s, 'u0', { type: 'roll' }, fixed(6));
  assert.equal(r.state.turn, 1);
  assert.ok(r.events.some((e) => e.type === 'three_sixes'));
});

test('landing on a lone opponent on a normal cell captures it and gives a bonus roll', () => {
  const s = mk();
  s.players[0].tokens[0] = 1; // abs 1
  s.players[1].tokens[0] = 29; // seat 2 -> abs (26+29)%52 = 3
  const r1 = act(s, 'u0', { type: 'roll' }, fixed(2));
  const r2 = act(r1.state, 'u0', { type: 'move', token: 0 }, null);
  assert.equal(r2.state.players[1].tokens[0], YARD);
  assert.equal(r2.state.turn, 0);
  assert.ok(r2.events.some((e) => e.type === 'captured'));
});

test('safe cells cannot be captured on', () => {
  const s = mk();
  s.players[0].tokens[0] = 6; // -> 8 (star, safe)
  s.players[1].tokens[0] = 34; // abs (26+34)%52 = 8
  const r = act(act(s, 'u0', { type: 'roll' }, fixed(2)).state, 'u0', { type: 'move', token: 0 }, null);
  assert.equal(r.state.players[1].tokens[0], 34);
});

test('exact roll is required to reach HOME', () => {
  const s = mk();
  s.players[0].tokens = [54, YARD, YARD, YARD];
  const r = act(s, 'u0', { type: 'roll' }, fixed(3));
  assert.equal(r.state.turn, 1); // 54+3 > 56 -> no legal move
  const s2 = mk();
  s2.players[0].tokens = [53, YARD, YARD, YARD];
  const r2 = act(s2, 'u0', { type: 'roll' }, fixed(3));
  assert.deepEqual(legalMoves(r2.state), [0]);
});

test('rejects actions out of turn or out of phase', () => {
  const s = mk();
  assert.throws(() => act(s, 'u1', { type: 'roll' }, fixed(1)), (e) => e instanceof EngineError && e.code === 'NOT_YOUR_TURN');
  assert.throws(() => act(s, 'u0', { type: 'move', token: 0 }, null), (e) => e.code === 'WRONG_PHASE');
});

test('does not mutate the input state', () => {
  const s = mk();
  const snapshot = JSON.stringify(s);
  act(s, 'u0', { type: 'roll' }, fixed(6));
  assert.equal(JSON.stringify(s), snapshot);
});

for (const n of [2, 3, 4]) {
  test(`random ${n}-player games always terminate with a full ranking`, () => {
    const rng = () => randomInt(1, 7);
    for (let g = 0; g < 20; g++) {
      let s = mk(n);
      for (let step = 0; step < 100000 && s.status === 'playing'; step++) {
        const uid = s.players[s.turn].userId;
        s = s.phase === 'ROLL'
          ? act(s, uid, { type: 'roll' }, rng).state
          : act(s, uid, { type: 'move', token: legalMoves(s)[0] }, null).state;
      }
      assert.equal(s.status, 'finished');
      assert.equal(s.ranking.length, n);
      assert.equal(new Set(s.ranking).size, n);
      assert.ok(s.players.some((p) => p.tokens.every((t) => t === HOME)));
    }
  });
}
