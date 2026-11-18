import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, authenticate, forbidden } from '@ipm/common';

const createSchema = z.object({
  game: z.string().default('ludo'),
  maxPlayers: z.number().int().min(2).max(8).default(4),
  isPrivate: z.boolean().default(false),
});
const startSchema = z.object({ fillWithBots: z.boolean().default(false) });

/** Room management over REST. Quick-match is realtime and lives on the WebSocket (see docs/websocket-protocol.md). */
export function buildRoutes({ service, config }) {
  const r = Router();
  r.get('/games', (_req, res) => res.json(service.listGames()));
  r.use(authenticate(config.jwtSecret));

  r.get('/rooms', asyncHandler(async (req, res) => res.json(await service.listOpen(req.query.game))));
  r.post('/rooms', validate(createSchema), asyncHandler(async (req, res) => res.status(201).json(await service.createRoom(req.user, req.body))));
  r.get('/rooms/:id', asyncHandler(async (req, res) => {
    const room = await service.getRoom(req.params.id);
    // private rooms are only visible to their members
    if (room.isPrivate && !room.players.some((p) => p.userId === req.user.id)) throw forbidden();
    res.json(room);
  }));
  r.post('/rooms/:idOrCode/join', asyncHandler(async (req, res) => res.json(await service.joinRoom(req.user, req.params.idOrCode))));
  r.post('/rooms/:id/leave', asyncHandler(async (req, res) => res.json(await service.leaveRoom(req.user, req.params.id))));
  r.post('/rooms/:id/start', validate(startSchema), asyncHandler(async (req, res) => res.json(await service.startRoom(req.user, req.params.id, req.body))));
  return r;
}
