/** Pure reward rules (no I/O) - unit tested in ../test/definitions.test.js */

/** Daily login reward: coins by streak day. Day 7 is the big one, then the cycle restarts. */
export const DAILY_CYCLE = [50, 60, 80, 100, 150, 200, 500];
export const dailyCoins = (streak) => DAILY_CYCLE[(streak - 1) % DAILY_CYCLE.length];

/** Daily missions. `metric` is the counter the mission reads from finished games. */
export const MISSIONS = [
  { id: 'play3', title: 'Play 3 games', metric: 'games', target: 3, coins: 100 },
  { id: 'win1', title: 'Win a game', metric: 'wins', target: 1, coins: 150 },
  { id: 'capture3', title: 'Capture 3 opponent tokens', metric: 'captures', target: 3, coins: 120 },
];
export const getMission = (id) => MISSIONS.find((m) => m.id === id);

/** UTC calendar day, "YYYY-MM-DD". Days reset at 00:00 UTC. */
export const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);
export const prevDay = (key) => dayKey(new Date(Date.parse(`${key}T00:00:00Z`) - 86400000));
export const nextReset = (date = new Date()) => new Date(Date.parse(`${dayKey(date)}T00:00:00Z`) + 86400000);

/** Streak the player would have after claiming today (null = already claimed today). */
export function streakAfterClaim(lastClaimDate, streak, today) {
  if (lastClaimDate === today) return null;
  return lastClaimDate === prevDay(today) ? streak + 1 : 1;
}

/** Streak to display now: it survives until the day after the last claim ends. */
export function liveStreak(lastClaimDate, streak, today) {
  return lastClaimDate === today || lastClaimDate === prevDay(today) ? streak : 0;
}

/** What one finished game adds to a player's mission counters. */
export const progressFromGame = (position, stats = {}) => ({ games: 1, wins: position === 0 ? 1 : 0, captures: stats.captures ?? 0 });
