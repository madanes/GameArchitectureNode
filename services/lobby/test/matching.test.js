import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, planBotFill, allowedSpread } from '../src/matching.js';

const t = (id, mmr, waitedMs = 0, now = 100_000) => ({ id, mmr, since: now - waitedMs });
const NOW = 100_000;

test('close ratings match immediately', () => {
  const { matches, rest } = findMatches([t('a', 1000), t('b', 1050), t('c', 1900)], 2, NOW);
  assert.deepEqual(matches.map((m) => m.map((x) => x.id)), [['a', 'b']]);
  assert.deepEqual(rest.map((x) => x.id), ['c']);
});

test('distant ratings do not match until the window widens with waiting time', () => {
  assert.equal(findMatches([t('a', 1000), t('b', 1300)], 2, NOW).matches.length, 0);
  assert.equal(findMatches([t('a', 1000, 10_000), t('b', 1300)], 2, NOW).matches.length, 1); // 100 + 25*10 = 350 >= 300
  assert.equal(allowedSpread(0), 100);
});

test('forms several matches and respects table size', () => {
  const tickets = ['a', 'b', 'c', 'd', 'e'].map((id, i) => t(id, 1000 + i * 10));
  const { matches, rest } = findMatches(tickets, 2, NOW);
  assert.equal(matches.length, 2);
  assert.equal(rest.length, 1);
  assert.equal(findMatches(tickets, 4, NOW).matches[0].length, 4);
});

test('no bots before the wait threshold, bots after it', () => {
  assert.equal(planBotFill([t('a', 1000, 5_000)], 2, NOW), null);
  const plan = planBotFill([t('a', 1000, 12_000)], 4, NOW);
  assert.equal(plan.humans.length, 1);
  assert.equal(plan.botRatings.length, 3);
  assert.ok(plan.botRatings.every((r) => Math.abs(r - 1000) <= 60));
});

test('bot fill seats nearby humans first and only adds the missing bots', () => {
  const plan = planBotFill([t('old', 1000, 12_000), t('near', 1020, 1_000), t('far', 2500, 1_000)], 3, NOW);
  assert.deepEqual(plan.humans.map((h) => h.id), ['old', 'near']);
  assert.equal(plan.botRatings.length, 1);
});

test('nothing to plan for an empty queue', () => {
  assert.equal(planBotFill([], 2, NOW), null);
});
