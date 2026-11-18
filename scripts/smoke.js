// End-to-end check through the gateway:  npm run smoke   (stack must be running)
//
//  A. room flow:      2 humans create/join/start a room and play a full game over WebSocket
//  B. quickmatch:     2 humans are matched by the matchmaker over WebSocket (no bots)
//  C. bot fill:       1 human queues alone -> bots are added -> game is played to the end
//  D. leagues:        ratings / tiers / weekly board changed as expected
//  E. rewards:        daily login (and double-claim rejection), missions, wallet
//  Tip: run the game service with BOT_DELAY_MS=50 (bots normally "think" ~1 s per action, so a 3-player game takes minutes)
//       and MM_BOT_FILL_SEC=3 on the lobby so scenario C does not wait 10 s.
//  F. AFK (optional): SMOKE_AFK=1 with TURN_TIMEOUT_MS<=1500 on the game service: nobody acts -> timeouts forfeit
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const WS = BASE.replace(/^http/, 'ws');
const suffix = Date.now().toString(36);
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, body, token, expect = [200, 201, 204]) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json };
}
const api = async (...a) => (await http(...a)).json;

async function register(name) {
  const r = await api('POST', '/auth/register', { username: `${name}_${suffix}`, email: `${name}_${suffix}@example.com`, password: 'password123' });
  return { ...r.user, token: r.accessToken };
}

class Client {
  constructor(player) {
    this.p = player; this.handlers = [];
    this.ws = new WebSocket(`${WS}/ws?token=${player.token}`);
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws connect failed')); });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); [...this.handlers].forEach((h) => h(m)); };
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  waitFor(type, ms = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(h); reject(new Error(`${this.p.username}: timed out waiting for '${type}'`)); }, ms);
      const h = (m) => {
        if (m.type === type) { clearTimeout(t); this.off(h); resolve(m); }
        else if (m.type === 'error') { clearTimeout(t); this.off(h); reject(new Error(`${this.p.username}: ${m.code} ${m.message}`)); }
      };
      this.handlers.push(h);
    });
  }
  off(h) { this.handlers = this.handlers.filter((x) => x !== h); }
  close() { this.ws.close(); }
}

/** Play a full game as `client` (join, then roll/move whenever it is our turn). Resolves with the final state. */
function autoplay(client, roomId) {
  return new Promise((resolve, reject) => {
    let last = -1;
    const h = (m) => {
      if (m.type === 'error' && !['NOT_YOUR_TURN', 'WRONG_PHASE'].includes(m.code)) return reject(new Error(`${client.p.username}: ${m.code} ${m.message}`));
      if (m.type !== 'joined' && m.type !== 'state') return;
      const s = m.state;
      if (s.status === 'finished') { client.off(h); return resolve(s); }
      if (s.version <= last || s.players[s.turn].userId !== client.p.id) return;
      last = s.version;
      if (s.phase === 'ROLL') return client.send({ type: 'roll', roomId });
      const tokens = s.players[s.turn].tokens;
      const legal = tokens.map((pos, i) => [pos === -1 ? 40 : pos, i, pos]).filter(([, , pos]) => pos !== 56 && (pos === -1 ? s.dice === 6 : pos + s.dice <= 56));
      legal.sort((a, b) => b[0] - a[0]);
      client.send({ type: 'move', roomId, token: legal[0][1] });
    };
    client.handlers.push(h);
    client.send({ type: 'join', roomId });
  });
}

// ---------------------------------------------------------------------------------------------------
console.log('A. room flow');
const [alice, bob] = [await register('alice'), await register('bob')];
const room = await api('POST', '/lobby/rooms', { game: 'ludo', maxPlayers: 2 }, alice.token);
await api('POST', `/lobby/rooms/${room.code}/join`, null, bob.token);
await api('POST', `/lobby/rooms/${room._id}/start`, {}, alice.token);
const [ca, cb] = [new Client(alice), new Client(bob)];
await Promise.all([ca.ready, cb.ready]);
const finalA = await Promise.race([autoplay(ca, room._id), autoplay(cb, room._id)]);
const winnerA = finalA.players.find((p) => p.rank === 1);
const loserA = finalA.players.find((p) => p.rank === 2);
console.log(`   game over after ${finalA.moveCount} moves; winner ${winnerA.username}`);
ca.close(); cb.close();

// ---------------------------------------------------------------------------------------------------
console.log('B. quickmatch between two humans (no bots)');
const [dave, erin] = [await register('dave'), await register('erin')];
const [cd, ce] = [new Client(dave), new Client(erin)];
await Promise.all([cd.ready, ce.ready]);
const foundD = cd.waitFor('match_found', 20000);
const foundE = ce.waitFor('match_found', 20000);
cd.send({ type: 'quickmatch', game: 'ludo', maxPlayers: 2 });
assert((await cd.waitFor('queued')).type === 'queued', 'queued ack');
ce.send({ type: 'quickmatch', game: 'ludo', maxPlayers: 2 });
const [mD, mE] = await Promise.all([foundD, foundE]);
assert(mD.roomId === mE.roomId, 'both players land in the same room');
assert(mD.players.every((p) => !p.isBot), 'no bots when two humans are available');
console.log(`   matched into room ${mD.roomId.slice(0, 8)}`);
const finalB = await Promise.race([autoplay(cd, mD.roomId), autoplay(ce, mD.roomId)]);
console.log(`   game over after ${finalB.moveCount} moves`);
cd.close(); ce.close();

// ---------------------------------------------------------------------------------------------------
console.log('C. bot fill: a lone player is matched against bots');
const frank = await register('frank');
const cf = new Client(frank);
await cf.ready;
const foundF = cf.waitFor('match_found', 40000);
cf.send({ type: 'quickmatch', game: 'ludo', maxPlayers: 3 });
const mF = await foundF;
const bots = mF.players.filter((p) => p.isBot);
assert(bots.length === 2, `expected 2 bots, got ${bots.length}`);
console.log(`   seated with ${bots.map((b) => b.username).join(' and ')}`);
const finalC = await autoplay(cf, mF.roomId);
console.log(`   game over after ${finalC.moveCount} moves; ranking: ${finalC.ranking.map((id) => finalC.players.find((p) => p.userId === id).username).join(' > ')}`);
cf.close();

// cancel works
const gina = await register('gina');
const cg = new Client(gina);
await cg.ready;
cg.send({ type: 'quickmatch', game: 'ludo', maxPlayers: 2 });
await cg.waitFor('queued');
cg.send({ type: 'cancel_quickmatch' });
await cg.waitFor('quickmatch_cancelled');
cg.close();

await sleep(2000); // let league / stats / rewards consume game.finished

// ---------------------------------------------------------------------------------------------------
console.log('D. leagues');
const winnerUser = winnerA.userId === alice.id ? alice : bob;
const loserUser = winnerUser === alice ? bob : alice;
const w = await api('GET', '/league/ludo/me', null, winnerUser.token);
const l = await api('GET', '/league/ludo/me', null, loserUser.token);
assert(w.rating === 1016 && l.rating === 984, `equal-rated 1v1 should be +16/-16, got ${w.rating}/${l.rating}`);
assert(w.tier === 'bronze' && w.nextTier.id === 'silver', 'new players start in bronze');
assert(w.season.points === 30 && l.season.points === 15, 'weekly points 30 / 15');
const frankLeague = await api('GET', '/league/ludo/me', null, frank.token);
assert(frankLeague.played === 1, 'bot games count as played');
console.log(`   winner ${w.rating} (${w.tier}), loser ${l.rating}; vs bots frank is ${frankLeague.rating} (bot games count half)`);
const board = await api('GET', '/league/ludo/leaderboard?scope=rating&limit=5', null, winnerUser.token);
assert(board.length >= 2 && board[0].rank === 1, 'rating leaderboard populated');
const stats = await api('GET', '/stats/leaderboard/ludo?limit=50', null, alice.token);
assert(!stats.some((r) => String(r.userId).startsWith('bot:')), 'bots never appear on leaderboards');

// ---------------------------------------------------------------------------------------------------
console.log('E. rewards');
const daily = await api('GET', '/rewards/daily', null, winnerUser.token);
assert(daily.canClaim && daily.nextReward.coins === 50, 'daily reward available');
const claim = await api('POST', '/rewards/daily/claim', null, winnerUser.token);
assert(claim.reward === 50 && claim.streak === 1 && claim.balance === 50, 'day-1 reward is 50 coins');
const again = await http('POST', '/rewards/daily/claim', null, winnerUser.token, [409]);
assert(again.status === 409, 'second claim on the same day is rejected');

const missions = await api('GET', '/rewards/missions', null, winnerUser.token);
const win1 = missions.missions.find((m) => m.id === 'win1');
assert(win1.completed && !win1.claimed, 'winning a game completes the "win a game" mission');
const loserMissions = await api('GET', '/rewards/missions', null, loserUser.token);
await http('POST', '/rewards/missions/win1/claim', null, loserUser.token, [409]); // cannot claim what you did not earn
assert(!loserMissions.missions.find((m) => m.id === 'win1').completed, 'loser has not completed win1');
const m = await api('POST', '/rewards/missions/win1/claim', null, winnerUser.token);
assert(m.reward === 150 && m.balance === 200, 'mission pays 150 coins on top of the daily 50');
await http('POST', '/rewards/missions/win1/claim', null, winnerUser.token, [409]);
const wallet = await api('GET', '/rewards/wallet', null, winnerUser.token);
assert(wallet.coins === 200, `wallet should hold 50 + 150, has ${wallet.coins}`);
console.log(`   daily +50, win mission +150 -> wallet ${wallet.coins}`);

// ---------------------------------------------------------------------------------------------------
if (process.env.SMOKE_AFK) {
  console.log('F. AFK: nobody acts, timers auto-play and finally forfeit');
  const [x, y] = [await register('xavi'), await register('yara')];
  const r = await api('POST', '/lobby/rooms', { game: 'ludo', maxPlayers: 2 }, x.token);
  await api('POST', `/lobby/rooms/${r.code}/join`, null, y.token);
  await api('POST', `/lobby/rooms/${r._id}/start`, {}, x.token);
  const cx = new Client(x);
  await cx.ready;
  cx.send({ type: 'join', roomId: r._id });
  const over = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('AFK game did not end')), 60000);
    cx.handlers.push((msg) => { if (msg.type === 'state' && msg.state.status === 'finished') { clearTimeout(t); resolve(msg); } });
  });
  assert(over.events.some((e) => e.type === 'forfeited'), 'a player was forfeited');
  console.log(`   ended by forfeit; ranking ${over.state.ranking.length} players`);
  cx.close();
}

console.log('SMOKE TEST PASSED');
process.exit(0);
