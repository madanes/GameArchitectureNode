import { isDuplicateKey, conflict, notFound } from '@ipm/common';
import {
  DAILY_CYCLE, dailyCoins, MISSIONS, getMission, dayKey, nextReset, streakAfterClaim, liveStreak, progressFromGame,
} from './definitions.js';

/**
 * Rewards: the coin wallet, daily login streak and daily missions.
 *
 * Every coin movement goes through credit(), which writes a ledger row whose _id is an idempotency
 * key (e.g. `daily:2026-11-18:<user>`), so retries and event redeliveries can never pay twice.
 */
export function createRewardsService({ db, logger }) {
  const wallets = db.collection('wallets'); // { _id: userId, coins }
  const ledger = db.collection('ledger'); // { _id: idempotencyKey, userId, amount, reason, createdAt }
  const daily = db.collection('daily_login'); // { _id: userId, lastClaimDate, streak, totalClaims }
  const missionDocs = db.collection('mission_progress'); // { _id: `${userId}:${day}`, progress:{games,wins,captures}, claimed:{missionId:true} }
  const processed = db.collection('processed_matches');

  async function init() {
    await ledger.createIndex({ userId: 1, createdAt: -1 });
    await missionDocs.createIndex({ userId: 1, day: -1 });
  }

  /** @returns {Promise<boolean>} true if coins were added, false if this key was already paid. */
  async function credit(userId, amount, key, reason, meta = {}) {
    try {
      await ledger.insertOne({ _id: key, userId, amount, reason, meta, createdAt: new Date() });
    } catch (err) { if (isDuplicateKey(err)) return false; throw err; }
    try {
      await wallets.updateOne({ _id: userId }, { $inc: { coins: amount }, $set: { updatedAt: new Date() } }, { upsert: true });
    } catch (err) {
      await ledger.deleteOne({ _id: key }); // nothing was paid: allow a retry
      throw err;
    }
    return true;
  }

  const wallet = async (userId) => ({ coins: (await wallets.findOne({ _id: userId }))?.coins ?? 0 });
  const history = (userId) => ledger.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();

  // ---- daily login ------------------------------------------------------------------------------

  async function dailyStatus(userId) {
    const today = dayKey();
    const doc = await daily.findOne({ _id: userId });
    const next = streakAfterClaim(doc?.lastClaimDate, doc?.streak ?? 0, today);
    return {
      today, canClaim: next !== null, streak: liveStreak(doc?.lastClaimDate, doc?.streak ?? 0, today),
      nextReward: next === null ? null : { day: ((next - 1) % DAILY_CYCLE.length) + 1, coins: dailyCoins(next) },
      cycle: DAILY_CYCLE, nextResetAt: nextReset().toISOString(),
    };
  }

  async function claimDaily(userId) {
    const today = dayKey();
    const doc = await daily.findOne({ _id: userId });
    const streak = streakAfterClaim(doc?.lastClaimDate, doc?.streak ?? 0, today);
    if (streak === null) throw conflict('Daily reward already claimed today');
    // Compare-and-set on the previous claim date: two concurrent claims cannot both win.
    try {
      const res = await daily.updateOne(
        doc ? { _id: userId, lastClaimDate: doc.lastClaimDate } : { _id: userId },
        { $set: { lastClaimDate: today, streak }, $inc: { totalClaims: 1 } },
        { upsert: !doc },
      );
      if (doc && res.matchedCount === 0) throw conflict('Daily reward already claimed today');
    } catch (err) {
      if (isDuplicateKey(err)) throw conflict('Daily reward already claimed today');
      throw err;
    }
    const coins = dailyCoins(streak);
    try {
      await credit(userId, coins, `daily:${today}:${userId}`, 'daily_login', { streak });
    } catch (err) { // roll the claim back so the player can try again
      await daily.updateOne({ _id: userId }, { $set: { lastClaimDate: doc?.lastClaimDate ?? null, streak: doc?.streak ?? 0 } });
      throw err;
    }
    return { reward: coins, streak, day: ((streak - 1) % DAILY_CYCLE.length) + 1, balance: (await wallet(userId)).coins };
  }

  // ---- missions ---------------------------------------------------------------------------------

  async function missions(userId) {
    const day = dayKey();
    const doc = await missionDocs.findOne({ _id: `${userId}:${day}` });
    return {
      day, resetsAt: nextReset().toISOString(),
      missions: MISSIONS.map((m) => {
        const progress = Math.min(doc?.progress?.[m.metric] ?? 0, m.target);
        return { id: m.id, title: m.title, target: m.target, progress, completed: progress >= m.target, claimed: !!doc?.claimed?.[m.id], coins: m.coins };
      }),
    };
  }

  async function claimMission(userId, missionId) {
    const m = getMission(missionId);
    if (!m) throw notFound('Unknown mission');
    const day = dayKey();
    const _id = `${userId}:${day}`;
    const marked = await missionDocs.findOneAndUpdate(
      { _id, [`progress.${m.metric}`]: { $gte: m.target }, [`claimed.${m.id}`]: { $ne: true } },
      { $set: { [`claimed.${m.id}`]: true } },
    );
    if (!marked) {
      const doc = await missionDocs.findOne({ _id });
      throw conflict(doc?.claimed?.[m.id] ? 'Mission reward already claimed' : 'Mission not completed yet');
    }
    try {
      await credit(userId, m.coins, `mission:${day}:${m.id}:${userId}`, 'mission', { mission: m.id });
    } catch (err) {
      await missionDocs.updateOne({ _id }, { $unset: { [`claimed.${m.id}`]: '' } });
      throw err;
    }
    return { mission: m.id, reward: m.coins, balance: (await wallet(userId)).coins };
  }

  // ---- event consumers (idempotent) ---------------------------------------------------------------

  /** Count a finished game towards every human player's missions for the day it finished. */
  async function onGameFinished({ matchId, ranking, players, stats }, ts) {
    try { await processed.insertOne({ _id: matchId, at: new Date() }); } catch (err) { if (isDuplicateKey(err)) return; throw err; }
    try {
      const day = dayKey(new Date(ts || Date.now()));
      const bots = new Set(players.filter((p) => p.isBot).map((p) => p.userId));
      for (const [position, userId] of ranking.entries()) {
        if (bots.has(userId)) continue;
        const p = progressFromGame(position, stats?.[userId]);
        await missionDocs.updateOne(
          { _id: `${userId}:${day}` },
          { $setOnInsert: { userId, day }, $inc: { 'progress.games': p.games, 'progress.wins': p.wins, 'progress.captures': p.captures } },
          { upsert: true },
        );
      }
    } catch (err) {
      await processed.deleteOne({ _id: matchId });
      throw err;
    }
  }

  /** League season rewards (from the league service) are paid into the wallet. */
  async function onLeagueReward({ userId, game, season, tier, rank, coins }) {
    const paid = await credit(userId, coins, `season:${game}:${season}:${tier}:${userId}`, 'season_rank', { game, season, tier, rank });
    if (paid) logger.info({ userId, coins, season, tier, rank }, 'season reward paid');
  }

  return { init, wallet, history, dailyStatus, claimDaily, missions, claimMission, onGameFinished, onLeagueReward };
}
