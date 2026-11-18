import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { getEngine } from '../src/index.js';
import { suggestAction } from '../src/ludo/engine.js';

const ludo = getEngine('ludo');

test('bot-only games driven by suggestAction always finish', () => {
  const rng = () => randomInt(1, 7);
  for (const n of [2, 3, 4]) {
    for (let g = 0; g < 10; g++) {
      let s = ludo.create({ players: Array.from({ length: n }, (_, i) => ({ userId: `bot:${i}`, username: `Bot${i}`, isBot: true })) });
      for (let step = 0; step < 100000 && s.status === 'playing'; step++) {
        s = ludo.applyAction(s, s.players[s.turn].userId, ludo.suggestAction(s), rng).state;
      }
      assert.equal(s.status, 'finished');
      assert.equal(s.ranking.length, n);
      assert.ok(s.players.every((p) => p.isBot));
    }
  }
});

test('suggestAction prefers finishing a token, then leaving the yard, then advancing', () => {
  const s = ludo.create({ players: [{ userId: 'a', username: 'A' }, { userId: 'b', username: 'B' }] });
  s.phase = 'MOVE'; s.dice = 3;
  s.players[0].tokens = [53, 10, -1, -1];
  assert.deepEqual(suggestAction(s), { type: 'move', token: 0 }); // 53+3 = home
  s.dice = 6; s.players[0].tokens = [10, 20, -1, 30];
  assert.deepEqual(suggestAction(s), { type: 'move', token: 2 }); // leaving the yard beats advancing a token
  s.players[0].tokens = [10, 20, 5, 30];
  assert.deepEqual(suggestAction(s), { type: 'move', token: 3 }); // nothing in the yard -> furthest token
});

test('captures are counted per player', () => {
  const s = ludo.create({ players: [{ userId: 'a', username: 'A' }, { userId: 'b', username: 'B' }] });
  s.players[0].tokens = [1, -1, -1, -1];
  s.players[1].tokens = [29, -1, -1, -1];
  const r = ludo.applyAction(ludo.applyAction(s, 'a', { type: 'roll' }, () => 2).state, 'a', { type: 'move', token: 0 }, null);
  assert.equal(r.state.players[0].captures, 1);
});
