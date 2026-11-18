import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRatingChanges, tierFor, nextTier, weekId, seasonEnd, seasonReward, weeklyPoints } from '../src/index.js';

test('equal players: winner gains 16, loser loses 16', () => {
  const d = computeRatingChanges([{ id: 'a', rating: 1000 }, { id: 'b', rating: 1000 }], ['a', 'b']);
  assert.deepEqual(d, { a: 16, b: -16 });
});

test('upset wins pay more than expected wins', () => {
  const upset = computeRatingChanges([{ id: 'low', rating: 900 }, { id: 'high', rating: 1300 }], ['low', 'high']);
  const expected = computeRatingChanges([{ id: 'low', rating: 900 }, { id: 'high', rating: 1300 }], ['high', 'low']);
  assert.ok(upset.low > 25);
  assert.ok(expected.high < 5);
});

test('4-player changes are zero-sum (within rounding) and ordered by finish', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => ({ id, rating: 1000 }));
  const d = computeRatingChanges(players, ['c', 'a', 'd', 'b']);
  assert.ok(Math.abs(Object.values(d).reduce((x, y) => x + y, 0)) <= 2);
  assert.ok(d.c > d.a && d.a > d.d && d.d > d.b);
});

test('tiers and next-tier distance', () => {
  assert.equal(tierFor(1000), 'bronze');
  assert.equal(tierFor(1050), 'silver');
  assert.equal(tierFor(1699), 'diamond');
  assert.equal(tierFor(2500), 'master');
  assert.deepEqual(nextTier(1000), { id: 'silver', min: 1050, pointsNeeded: 50 });
  assert.equal(nextTier(1800), null);
});

test('ISO week ids, including year boundaries', () => {
  assert.equal(weekId(new Date('2026-11-18T10:00:00Z')), '2026-W47');
  assert.equal(weekId(new Date('2027-01-03T23:59:59Z')), '2026-W53'); // Sunday still belongs to the old ISO year
  assert.equal(weekId(new Date('2027-01-04T00:00:00Z')), '2027-W01');
  assert.equal(weekId(new Date('2025-12-29T00:00:00Z')), '2026-W01');
});

test('season ends next Monday 00:00 UTC', () => {
  assert.equal(seasonEnd(new Date('2026-11-18T10:00:00Z')).toISOString(), '2026-11-23T00:00:00.000Z'); // Wed -> Mon
  assert.equal(seasonEnd(new Date('2026-11-22T23:00:00Z')).toISOString(), '2026-11-23T00:00:00.000Z'); // Sun
  assert.equal(seasonEnd(new Date('2026-11-23T00:00:00Z')).toISOString(), '2026-11-30T00:00:00.000Z'); // Mon = new season
});

test('rewards scale with tier and rank; only the top 3 are paid', () => {
  assert.equal(seasonReward('bronze', 1), 1000);
  assert.equal(seasonReward('master', 1), 5000);
  assert.equal(seasonReward('gold', 3), 500);
  assert.equal(seasonReward('gold', 4), 0);
  assert.equal(weeklyPoints(0), 30);
  assert.equal(weeklyPoints(5), 0);
});
