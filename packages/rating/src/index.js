/**
 * Pure rating / league rules shared by the league service (ratings, seasons)
 * and the lobby (matchmaking). No I/O.
 */
export const INITIAL_RATING = 1000;
export const K_FACTOR = 32;
/** Rating and weekly points earned in games that contain bots are multiplied by this. */
export const BOT_GAME_FACTOR = 0.5;

/** Leagues (tiers), lowest first. A player's tier is derived from their MMR. */
export const TIERS = [
  { id: 'bronze', min: 0 },
  { id: 'silver', min: 1050 },
  { id: 'gold', min: 1150 },
  { id: 'platinum', min: 1300 },
  { id: 'diamond', min: 1500 },
  { id: 'master', min: 1700 },
];

export const tierFor = (rating) => [...TIERS].reverse().find((t) => rating >= t.min).id;

export function nextTier(rating) {
  const next = TIERS.find((t) => t.min > rating);
  return next ? { id: next.id, min: next.min, pointsNeeded: next.min - rating } : null;
}

/**
 * Multiplayer Elo. Every pair of players is treated as a 1v1 (higher finish = win) and the
 * result is averaged over the n-1 opponents, so a 4-player game moves ratings about as much
 * as a 1v1. Returns { [userId]: integerDelta }.
 *
 * @param {{id:string, rating:number}[]} players
 * @param {string[]} ranking userIds, best first
 */
export function computeRatingChanges(players, ranking, k = K_FACTOR) {
  const n = players.length;
  const place = new Map(ranking.map((id, i) => [id, i]));
  const deltas = {};
  for (const a of players) {
    let sum = 0;
    for (const b of players) {
      if (a.id === b.id) continue;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const score = place.get(a.id) < place.get(b.id) ? 1 : 0;
      sum += score - expected;
    }
    deltas[a.id] = Math.round((k * sum) / (n - 1));
  }
  return deltas;
}

/** Weekly league points by finishing position (0 = winner). */
export const WEEKLY_POINTS = [30, 15, 5, 0, 0, 0, 0, 0];
export const weeklyPoints = (position) => WEEKLY_POINTS[position] ?? 0;

/** ISO-8601 week id in UTC, e.g. "2026-W47". Seasons run Monday 00:00 UTC -> next Monday. */
export function weekId(date = new Date()) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The instant the current season ends (next Monday 00:00 UTC). */
export function seasonEnd(date = new Date()) {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = date.getUTCDay() || 7;
  return new Date(midnight + (8 - day) * 86400000);
}

/** Season-end coin rewards for the top 3 of each tier's weekly board; higher leagues pay more. */
const BASE_COINS = [1000, 500, 250];
const TIER_MULTIPLIER = { bronze: 1, silver: 1.5, gold: 2, platinum: 3, diamond: 4, master: 5 };
export const REWARD_RANKS = BASE_COINS.length;
export const seasonReward = (tier, rank) => (BASE_COINS[rank - 1] ? Math.round(BASE_COINS[rank - 1] * TIER_MULTIPLIER[tier]) : 0);
