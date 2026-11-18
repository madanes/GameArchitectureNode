import { Router } from 'express';
import { asyncHandler, authenticate } from '@ipm/common';

export function buildRoutes({ service, config }) {
  const r = Router();
  r.use(authenticate(config.jwtSecret));
  r.get('/wallet', asyncHandler(async (req, res) => res.json(await service.wallet(req.user.id))));
  r.get('/ledger', asyncHandler(async (req, res) => res.json(await service.history(req.user.id))));
  r.get('/daily', asyncHandler(async (req, res) => res.json(await service.dailyStatus(req.user.id))));
  r.post('/daily/claim', asyncHandler(async (req, res) => res.json(await service.claimDaily(req.user.id))));
  r.get('/missions', asyncHandler(async (req, res) => res.json(await service.missions(req.user.id))));
  r.post('/missions/:id/claim', asyncHandler(async (req, res) => res.json(await service.claimMission(req.user.id, req.params.id))));
  return r;
}
