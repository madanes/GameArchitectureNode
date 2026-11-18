/**
 * Pure matchmaking rules (no I/O) - unit tested in ../test/matching.test.js
 *
 * A ticket is { id, mmr, since } (since = ms epoch the player started waiting).
 * The acceptable MMR spread starts at `base` and widens by `growthPerSec` for every second the
 * longest-waiting player in a group has waited, so fast matches stay fair and nobody waits forever.
 */
export const DEFAULTS = { base: 100, growthPerSec: 25, botAfterMs: 10_000 };

export const allowedSpread = (waitMs, o = DEFAULTS) => o.base + (o.growthPerSec * waitMs) / 1000;

/**
 * Greedy sliding window over tickets sorted by MMR.
 * @returns {{ matches: object[][], rest: object[] }}
 */
export function findMatches(tickets, size, now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = [...tickets].sort((a, b) => a.mmr - b.mmr);
  const matches = [];
  let i = 0;
  while (i + size <= list.length) {
    const win = list.slice(i, i + size);
    const longestWait = Math.max(...win.map((t) => now - t.since));
    if (win[win.length - 1].mmr - win[0].mmr <= allowedSpread(longestWait, o)) {
      matches.push(win);
      list.splice(i, size);
    } else {
      i++;
    }
  }
  return { matches, rest: list };
}

/**
 * Nobody suitable showed up: once the longest-waiting player has waited `botAfterMs`, seat them
 * (plus any humans within range) and fill every empty seat with a bot of similar rating.
 * @returns {{ humans: object[], botRatings: number[] } | null}
 */
export function planBotFill(tickets, size, now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const oldest = [...tickets].sort((a, b) => a.since - b.since)[0];
  if (!oldest || now - oldest.since < o.botAfterMs) return null;
  const range = allowedSpread(now - oldest.since, o);
  const humans = [oldest, ...tickets
    .filter((t) => t !== oldest && Math.abs(t.mmr - oldest.mmr) <= range)
    .sort((a, b) => Math.abs(a.mmr - oldest.mmr) - Math.abs(b.mmr - oldest.mmr))]
    .slice(0, size);
  const avg = Math.round(humans.reduce((s, t) => s + t.mmr, 0) / humans.length);
  // small deterministic spread so the bots are not all identical
  const botRatings = Array.from({ length: size - humans.length }, (_, i) => Math.max(0, avg + ((i % 2 ? 1 : -1) * 15 * (i + 1))));
  return { humans, botRatings };
}

export const BOT_NAMES = ['Aria', 'Blaze', 'Cleo', 'Dash', 'Echo', 'Finn', 'Gizmo', 'Hana', 'Ivy', 'Jett', 'Kira', 'Luna', 'Milo', 'Nova', 'Orion', 'Pixel'];
