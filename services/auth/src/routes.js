import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, authenticate } from '@gamearch/common';

const credentials = {
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
};
const registerSchema = z.object(credentials);
const loginSchema = z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(128) });
const tokenSchema = z.object({ refreshToken: z.string().length(64) });

export function buildRoutes({ service, config }) {
  const r = Router();
  r.post('/register', validate(registerSchema), asyncHandler(async (req, res) => res.status(201).json(await service.register(req.body))));
  r.post('/login', validate(loginSchema), asyncHandler(async (req, res) => res.json(await service.login(req.body))));
  r.post('/guest', asyncHandler(async (_req, res) => res.status(201).json(await service.guest())));
  r.post('/refresh', validate(tokenSchema), asyncHandler(async (req, res) => res.json(await service.refresh(req.body.refreshToken))));
  r.post('/logout', validate(tokenSchema), asyncHandler(async (req, res) => { await service.logout(req.body.refreshToken); res.status(204).end(); }));
  r.get('/me', authenticate(config.jwtSecret), asyncHandler(async (req, res) => res.json(await service.me(req.user.id))));
  return r;
}
