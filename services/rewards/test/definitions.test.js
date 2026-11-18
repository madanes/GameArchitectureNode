import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyCoins, dayKey, prevDay, nextReset, streakAfterClaim, liveStreak, progressFromGame, MISSIONS } from '../src/definitions.js';

test('daily reward follows a 7-day cycle then restarts', () => {
  assert.equal(dailyCoins(1), 50);
  assert.equal(dailyCoins(7), 500);
  assert.equal(dailyCoins(8), 50);
});

test('day helpers work across month and year boundaries', () => {
  assert.equal(dayKey(new Date('2026-11-18T23:59:59Z')), '2026-11-18');
  assert.equal(prevDay('2026-03-01'), '2026-02-28');
  assert.equal(prevDay('2027-01-01'), '2026-12-31');
  assert.equal(nextReset(new Date('2026-11-18T10:00:00Z')).toISOString(), '2026-11-19T00:00:00.000Z');
});

test('streak continues on consecutive days, resets after a gap, blocks double claims', () => {
  assert.equal(streakAfterClaim(undefined, 0, '2026-11-18'), 1);
  assert.equal(streakAfterClaim('2026-11-17', 4, '2026-11-18'), 5);
  assert.equal(streakAfterClaim('2026-11-15', 4, '2026-11-18'), 1);
  assert.equal(streakAfterClaim('2026-11-18', 4, '2026-11-18'), null);
});

test('displayed streak expires after a missed day', () => {
  assert.equal(liveStreak('2026-11-18', 3, '2026-11-18'), 3);
  assert.equal(liveStreak('2026-11-17', 3, '2026-11-18'), 3);
  assert.equal(liveStreak('2026-11-16', 3, '2026-11-18'), 0);
});

test('mission counters from a finished game', () => {
  assert.deepEqual(progressFromGame(0, { captures: 2 }), { games: 1, wins: 1, captures: 2 });
  assert.deepEqual(progressFromGame(1), { games: 1, wins: 0, captures: 0 });
});

test('mission ids are unique and have positive targets and rewards', () => {
  assert.equal(new Set(MISSIONS.map((m) => m.id)).size, MISSIONS.length);
  assert.ok(MISSIONS.every((m) => m.target > 0 && m.coins > 0));
});
