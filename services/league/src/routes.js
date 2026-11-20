import { Router } from 'express';
import { z } from 'zod';
import { TIERS } from '@gamearch/rating';
import { asyncHandler, validate, authenticate } from '@gamearch/common';

const boardQuery = z.object({
  scope: z.enum(['rating', 'week']).default('rating'),
  tier: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function buildRoutes({ service, config }) {
  const r = Router();
  r.use(authenticate(config.jwtSecret));
  r.get('/tiers', (_req, res) => res.json(TIERS));
  r.get('/rewards/me', asyncHandler(async (req, res) => res.json(await service.myRewards(req.user.id))));
  r.get('/:game/me', asyncHandler(async (req, res) => res.json(await service.profile(req.user.id, req.params.game))));
  r.get('/:game/leaderboard', validate(boardQuery, 'query'), asyncHandler(async (req, res) => res.json(await service.leaderboard(req.params.game, req.query))));
  return r;
}
