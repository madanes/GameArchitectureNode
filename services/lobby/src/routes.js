import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, authenticate, forbidden } from '@ipm/common';

const createSchema = z.object({
  game: z.string().default('ludo'),
  maxPlayers: z.number().int().min(2).max(8).default(4),
  isPrivate: z.boolean().default(false),
});
const matchSchema = z.object({ game: z.string().default('ludo'), maxPlayers: z.number().int().min(2).max(8).default(2) });

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
  r.post('/rooms/:id/start', asyncHandler(async (req, res) => res.json(await service.startRoom(req.user, req.params.id))));

  r.post('/quickmatch', validate(matchSchema), asyncHandler(async (req, res) => res.json(await service.quickMatch(req.user, req.body))));
  r.get('/quickmatch', asyncHandler(async (req, res) => res.json(await service.quickMatchStatus(req.user))));
  r.delete('/quickmatch', asyncHandler(async (req, res) => { await service.cancelQuickMatch(req.user); res.status(204).end(); }));
  return r;
}
