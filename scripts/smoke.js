// End-to-end check through the gateway:  npm run smoke   (stack must be running)
// register 2 players -> create room -> join -> start -> play a full game over WebSocket -> check leaderboard.
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const WS = BASE.replace(/^http/, 'ws');

const api = async (method, path, body, token) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const suffix = Date.now().toString(36);
const players = [];
for (const n of ['alice', 'bob']) {
  const r = await api('POST', '/auth/register', { username: `${n}_${suffix}`, email: `${n}_${suffix}@example.com`, password: 'password123' });
  players.push({ ...r.user, token: r.accessToken });
}
console.log('registered', players.map((p) => p.username).join(', '));

const room = await api('POST', '/lobby/rooms', { game: 'ludo', maxPlayers: 2 }, players[0].token);
await api('POST', `/lobby/rooms/${room.code}/join`, null, players[1].token);
await api('POST', `/lobby/rooms/${room._id}/start`, null, players[0].token);
console.log('room started', room.code);

const finished = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('game did not finish in time')), 120000);
  let rolls = 0;
  players.forEach((p) => {
    const ws = new WebSocket(`${WS}/ws?token=${p.token}`);
    const play = (state) => {
      if (state.status === 'finished') { clearTimeout(timer); resolve(state); return; }
      if (state.players[state.turn].userId !== p.id) return;
      if (state.phase === 'ROLL') { rolls++; ws.send(JSON.stringify({ type: 'roll', roomId: room._id })); return; }
      // pick the most advanced legal token
      const me = state.players[state.turn];
      const legal = me.tokens.map((pos, i) => [pos, i]).filter(([pos]) => pos !== 56 && (pos === -1 ? state.dice === 6 : pos + state.dice <= 56));
      legal.sort((a, b) => b[0] - a[0]);
      ws.send(JSON.stringify({ type: 'move', roomId: room._id, token: legal[0][1] }));
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', roomId: room._id }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'error') return reject(new Error(`${p.username}: ${m.code} ${m.message}`));
      if (m.type === 'joined' || m.type === 'state') play(m.state);
    };
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message}`));
  });
});

const final = await finished;
const winner = final.players.find((p) => p.rank === 1);
console.log(`game over after ${final.moveCount} moves; winner: ${winner.username}`);

await new Promise((r) => setTimeout(r, 1500)); // let the stats service consume game.finished
const lb = await api('GET', '/stats/leaderboard/ludo?limit=5', null, players[0].token);
console.log('leaderboard', lb);
const mine = await api('GET', '/stats/me', null, players[0].token);
console.log('alice stats', mine);
if (!lb.some((r) => r.userId === winner.userId)) throw new Error('winner missing from leaderboard');
console.log('SMOKE TEST PASSED');
process.exit(0);
