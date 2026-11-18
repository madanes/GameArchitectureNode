import { WebSocketServer } from 'ws';
import { verifyAccessToken } from '@ipm/common';

/**
 * Realtime layer. Sockets are local to this replica; cross-replica delivery goes through Redis
 * pub/sub, so a player on replica A sees moves made by a player on replica B.
 *
 * Client -> server: {type:'join',roomId} {type:'roll',roomId} {type:'move',roomId,token} {type:'ping'}
 * Server -> client: {type:'joined'|'waiting'|'state'|'error'|'pong', ...}
 */
export function attachWebSocket({ server, manager, redis, config, logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const rooms = new Map(); // roomId -> Set<ws>

  const sub = redis.duplicate();
  sub.psubscribe('game:*:events');
  sub.on('pmessage', (_pattern, ch, raw) => {
    const roomId = ch.split(':')[1];
    for (const ws of rooms.get(roomId) ?? []) if (ws.readyState === ws.OPEN) ws.send(raw);
  });

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const leaveAll = (ws) => {
    for (const roomId of ws.rooms) {
      const set = rooms.get(roomId);
      set?.delete(ws);
      if (set?.size === 0) rooms.delete(roomId);
    }
  };

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

  wss.on('connection', (ws) => {
    ws.rooms = new Set();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return send(ws, { type: 'error', code: 'BAD_JSON' }); }
      try {
        if (msg.type === 'ping') return send(ws, { type: 'pong' });
        if (typeof msg.roomId !== 'string') return send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'roomId required' });

        if (msg.type === 'join') {
          // subscribe first so no update can slip between "read state" and "start listening"
          if (!rooms.has(msg.roomId)) rooms.set(msg.roomId, new Set());
          rooms.get(msg.roomId).add(ws);
          ws.rooms.add(msg.roomId);
          const state = await manager.getState(msg.roomId);
          if (!state) return send(ws, { type: 'waiting', roomId: msg.roomId }); // game not created yet; state is pushed when it is
          if (!state.players.some((p) => p.userId === ws.user.id)) {
            leaveAll(ws);
            return send(ws, { type: 'error', code: 'FORBIDDEN', message: 'You are not in this game' });
          }
          return send(ws, { type: 'joined', roomId: msg.roomId, state });
        }
        if (msg.type === 'roll' || msg.type === 'move') {
          await manager.act(msg.roomId, ws.user.id, { type: msg.type, token: msg.token });
          return; // result is broadcast via pub/sub to everyone, including the sender
        }
        send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
      } catch (err) {
        send(ws, { type: 'error', code: err.code || 'INTERNAL', message: err.message });
        if (!err.code) logger.error({ err }, 'ws handler error');
      }
    });
    ws.on('close', () => leaveAll(ws));
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
