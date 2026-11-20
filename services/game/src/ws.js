import { WebSocketServer } from 'ws';
import { verifyAccessToken } from '@gamearch/common';
import { getEngine } from '@gamearch/game-engines';

/**
 * Realtime layer. Sockets are local to this replica; cross-replica delivery goes through Redis
 * pub/sub (`game:{room}:events` for table updates, `user:{id}:events` for personal notifications),
 * so a player on replica A sees moves made by a player on replica B.
 *
 * Client -> server
 *   {type:'quickmatch', game?, maxPlayers?}   join the skill-based queue (bots fill empty seats if nobody is found)
 *   {type:'cancel_quickmatch'}
 *   {type:'join',roomId} {type:'roll',roomId} {type:'move',roomId,token} {type:'ping'}
 * Server -> client
 *   queued | quickmatch_cancelled | match_found | mm_timeout | joined | waiting | state | error | pong
 */
export function attachWebSocket({ server, manager, redis, bus, config, logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const rooms = new Map(); // roomId -> Set<ws>
  const users = new Map(); // userId -> Set<ws>

  const sub = redis.duplicate();
  sub.psubscribe('game:*:events', 'user:*:events');
  sub.on('pmessage', (_pattern, ch, raw) => {
    const [kind, id] = ch.split(':');
    const targets = kind === 'game' ? rooms.get(id) : users.get(id);
    for (const ws of targets ?? []) {
      if (ws.readyState !== ws.OPEN) continue;
      if (kind === 'user') { // a queue outcome ends the "queued" state
        const { type } = JSON.parse(raw);
        if (type === 'match_found' || type === 'mm_timeout') ws.queued = false;
      }
      ws.send(raw);
    }
  });

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const addTo = (map, key, ws) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(ws); };
  const removeFrom = (map, key, ws) => { const s = map.get(key); s?.delete(ws); if (s?.size === 0) map.delete(key); };
  const leaveAll = (ws) => ws.rooms.forEach((roomId) => removeFrom(rooms, roomId, ws));

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return socket.destroy();
    let user;
    try {
      const p = verifyAccessToken(url.searchParams.get('token') ?? '', config.jwtSecret);
      user = { id: p.sub, username: p.username };
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = user; wss.emit('connection', ws); });
  });

  async function handleQuickmatch(ws, msg) {
    const game = msg.game ?? 'ludo';
    const engine = getEngine(game);
    const maxPlayers = msg.maxPlayers ?? 2;
    if (!engine) return send(ws, { type: 'error', code: 'BAD_REQUEST', message: `Unknown game '${game}'` });
    if (!Number.isInteger(maxPlayers) || maxPlayers < engine.meta.minPlayers || maxPlayers > engine.meta.maxPlayers) {
      return send(ws, { type: 'error', code: 'BAD_REQUEST', message: `${game} supports ${engine.meta.minPlayers}-${engine.meta.maxPlayers} players` });
    }
    await bus.publish('events:mm', 'mm.join', { userId: ws.user.id, username: ws.user.username, game, maxPlayers });
    ws.queued = true;
    send(ws, { type: 'queued', game, maxPlayers });
  }

  async function handleJoin(ws, roomId) {
    // subscribe first so no update can slip between "read state" and "start listening"
    addTo(rooms, roomId, ws);
    ws.rooms.add(roomId);
    const state = await manager.getState(roomId);
    if (!state) return send(ws, { type: 'waiting', roomId }); // game not created yet; state is pushed when it is
    if (!state.players.some((p) => p.userId === ws.user.id)) {
      removeFrom(rooms, roomId, ws);
      ws.rooms.delete(roomId);
      return send(ws, { type: 'error', code: 'FORBIDDEN', message: 'You are not in this game' });
    }
    send(ws, { type: 'joined', roomId, state });
  }

  wss.on('connection', (ws) => {
    ws.rooms = new Set();
    ws.isAlive = true;
    addTo(users, ws.user.id, ws);
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return send(ws, { type: 'error', code: 'BAD_JSON' }); }
      try {
        switch (msg.type) {
          case 'ping': return send(ws, { type: 'pong' });
          case 'quickmatch': return await handleQuickmatch(ws, msg);
          case 'cancel_quickmatch':
            await bus.publish('events:mm', 'mm.cancel', { userId: ws.user.id });
            ws.queued = false;
            return send(ws, { type: 'quickmatch_cancelled' });
          case 'join': case 'roll': case 'move':
            if (typeof msg.roomId !== 'string') return send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'roomId required' });
            if (msg.type === 'join') return await handleJoin(ws, msg.roomId);
            await manager.act(msg.roomId, ws.user.id, { type: msg.type, token: msg.token });
            return; // result is broadcast via pub/sub to everyone, including the sender
          default: return send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
        }
      } catch (err) {
        send(ws, { type: 'error', code: err.code || 'INTERNAL', message: err.message });
        if (!err.code) logger.error({ err }, 'ws handler error');
      }
    });

    ws.on('close', () => {
      leaveAll(ws);
      removeFrom(users, ws.user.id, ws);
      if (ws.queued) bus.publish('events:mm', 'mm.cancel', { userId: ws.user.id }).catch(() => {}); // leaving the app leaves the queue
    });
  });

  // drop dead connections (NAT timeouts, crashed clients)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  return { close: () => { clearInterval(heartbeat); sub.disconnect(); wss.close(); } };
}
