import { isDuplicateKey, withLock, notFound, badRequest } from '@gamearch/common';
import { listGames } from '@gamearch/game-engines';
import {
  INITIAL_RATING, BOT_GAME_FACTOR, TIERS, tierFor, nextTier, computeRatingChanges, weeklyPoints, weekId, seasonEnd, seasonReward, REWARD_RANKS,
} from '@gamearch/rating';

const mmrKey = (game) => `league:mmr:${game}`; // read by lobby matchmaking (published read-model)
const boardKey = (game, season, tier) => `league:week:${game}:${season}:${tier}`;
const seasonKey = (game) => `league:season:${game}`;
const BOARD_TTL_SEC = 60 * 60 * 24 * 35;

/**
 * League service. Owns ratings (MMR), tiers (leagues), weekly seasons and season rewards.
 *
 *  - MMR: multiplayer Elo, updated from every `game.finished` event (stored in Mongo, mirrored in Redis ZSET).
 *  - Tier: derived from MMR (bronze..master).
 *  - Season: ISO week (Mon 00:00 UTC). Each match earns weekly points on the board of the player's tier.
 *  - Rollover: top 3 of each tier board get coins -> `league.reward` events (a wallet service can consume them).
 */
export function createLeagueService({ db, redis, bus, logger }) {
  const ratings = db.collection('ratings');
  const processed = db.collection('processed_matches');
  const rewards = db.collection('rewards');
  const games = () => listGames().map((g) => g.id);
  const assertGame = (game) => { if (!games().includes(game)) throw notFound(`Unknown game '${game}'`); };

  async function init() {
    await ratings.createIndex({ userId: 1, game: 1 }, { unique: true });
    await ratings.createIndex({ game: 1, rating: -1 });
    await rewards.createIndex({ userId: 1, createdAt: -1 });
    // Redis is a cache of Mongo here: rebuild the MMR index if Redis was wiped.
    for (const game of games()) {
      if ((await redis.zcard(mmrKey(game))) === 0) {
        const rows = await ratings.find({ game }).toArray();
        if (rows.length) await redis.zadd(mmrKey(game), ...rows.flatMap((r) => [r.rating, r.userId]));
      }
    }
  }

  async function ensureRating(userId, game, username) {
    await ratings.updateOne(
      { userId, game },
      { $setOnInsert: { rating: INITIAL_RATING, peak: INITIAL_RATING, played: 0, wins: 0, createdAt: new Date() }, $set: { username } },
      { upsert: true },
    );
    return ratings.findOne({ userId, game });
  }

  /** Idempotent: a redelivered event is ignored (processed_matches has a unique _id). */
  async function onGameFinished({ matchId, game, ranking, players }) {
    if (!games().includes(game) || ranking.length < 2) return;
    try { await processed.insertOne({ _id: matchId, at: new Date() }); } catch (err) { if (isDuplicateKey(err)) return; throw err; }
    try {
      const info = new Map(players.map((p) => [p.userId, p]));
      // Games with bots still move ratings (bots carry the rating they were matched at) but count less,
      // so farming bots is not an efficient way up the ladder. Bots themselves are never stored.
      const scale = players.some((p) => p.isBot) ? BOT_GAME_FACTOR : 1;
      const before = await Promise.all(ranking.map(async (id) => (info.get(id)?.isBot
        ? { userId: id, rating: info.get(id).rating ?? INITIAL_RATING, isBot: true }
        : ensureRating(id, game, info.get(id)?.username))));
      const raw = computeRatingChanges(before.map((r) => ({ id: r.userId, rating: r.rating })), ranking);
      const deltas = Object.fromEntries(Object.entries(raw).map(([id, d]) => [id, Math.round(d * scale)]));
      const season = weekId();

      for (const [position, userId] of ranking.entries()) {
        const prev = before.find((r) => r.userId === userId);
        if (prev.isBot) continue;
        const after = await ratings.findOneAndUpdate(
          { userId, game },
          { $inc: { rating: deltas[userId], played: 1, wins: position === 0 ? 1 : 0 }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
        let rating = after.rating;
        if (rating < 0) { await ratings.updateOne({ userId, game }, { $set: { rating: 0 } }); rating = 0; }
        await ratings.updateOne({ userId, game }, { $max: { peak: rating }, $set: { tier: tierFor(rating) } });
        await redis.zadd(mmrKey(game), rating, userId);

        const board = boardKey(game, season, tierFor(prev.rating)); // points count for the league the player *played* in
        await redis.zincrby(board, Math.floor(weeklyPoints(position) * scale), userId);
        await redis.expire(board, BOARD_TTL_SEC);
      }
      logger.info({ matchId, game, deltas }, 'ratings updated');
    } catch (err) {
      await processed.deleteOne({ _id: matchId }); // let the redelivery retry
      throw err;
    }
  }

  const userNames = async (game, ids) => new Map((await ratings.find({ game, userId: { $in: ids } }).toArray()).map((r) => [r.userId, r]));

  async function profile(userId, game) {
    assertGame(game);
    const r = (await ratings.findOne({ userId, game })) ?? { rating: INITIAL_RATING, peak: INITIAL_RATING, played: 0, wins: 0 };
    const tier = tierFor(r.rating);
    const season = weekId();
    const key = boardKey(game, season, tier);
    const [points, rank, size, overall] = await Promise.all([
      redis.zscore(key, userId), redis.zrevrank(key, userId), redis.zcard(key), redis.zrevrank(mmrKey(game), userId),
    ]);
    return {
      game, rating: r.rating, peak: r.peak, tier, nextTier: nextTier(r.rating), played: r.played, wins: r.wins,
      overallRank: overall === null ? null : overall + 1,
      season: { id: season, endsAt: seasonEnd().toISOString(), tier, points: Number(points ?? 0), rank: rank === null ? null : rank + 1, players: size },
    };
  }

  async function leaderboard(game, { scope, tier, limit }) {
    assertGame(game);
    if (tier && !TIERS.some((t) => t.id === tier)) throw badRequest('Unknown tier');
    const key = scope === 'week' ? boardKey(game, weekId(), tier ?? 'bronze') : mmrKey(game);
    const rows = await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
    const ids = rows.filter((_, i) => i % 2 === 0);
    const docs = await userNames(game, ids);
    return ids.map((userId, i) => ({
      rank: i + 1, userId, username: docs.get(userId)?.username, score: Number(rows[i * 2 + 1]),
      tier: docs.get(userId)?.tier ?? tierFor(docs.get(userId)?.rating ?? INITIAL_RATING),
    }));
  }

  const myRewards = (userId) => rewards.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();

  /** Close the previous week if the calendar moved on: pay rewards, announce, start the new season. */
  async function rollover() {
    return withLock(redis, 'league:rollover:lock', async () => {
      const current = weekId();
      for (const game of games()) {
        const stored = await redis.get(seasonKey(game));
        if (!stored) { await redis.set(seasonKey(game), current); continue; }
        if (stored === current) continue;
        await closeSeason(game, stored);
        await redis.set(seasonKey(game), current);
      }
    }, { retries: 1 });
  }

  async function closeSeason(game, season) {
    for (const { id: tier } of TIERS) {
      const top = await redis.zrevrange(boardKey(game, season, tier), 0, REWARD_RANKS - 1, 'WITHSCORES');
      for (let i = 0; i * 2 < top.length; i++) {
        const userId = top[i * 2];
        const points = Number(top[i * 2 + 1]);
        const rank = i + 1;
        const coins = seasonReward(tier, rank);
        if (points <= 0 || coins <= 0) continue;
        const _id = `${game}:${season}:${tier}:${userId}`;
        try {
          await rewards.insertOne({ _id, userId, game, season, tier, rank, points, coins, createdAt: new Date() });
        } catch (err) { if (isDuplicateKey(err)) continue; throw err; }
        await bus.publish('events:league', 'league.reward', { userId, game, season, tier, rank, coins, reason: 'season_rank' });
      }
    }
    await bus.publish('events:league', 'league.season_ended', { game, season });
    logger.info({ game, season }, 'season closed');
  }

  return { init, onGameFinished, profile, leaderboard, myRewards, rollover, closeSeason };
}
