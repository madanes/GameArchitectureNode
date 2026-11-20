import jwt from 'jsonwebtoken';
import { unauthorized } from './errors.js';

const ISSUER = 'gamearch';

export const signAccessToken = (user, { secret, ttlSec }) =>
  jwt.sign({ username: user.username }, secret, { subject: user.id, expiresIn: ttlSec, issuer: ISSUER });

export const verifyAccessToken = (token, secret) => jwt.verify(token, secret, { issuer: ISSUER });

/** Express middleware: requires `Authorization: Bearer <jwt>`; sets req.user. Every service uses it (zero-trust). */
export const authenticate = (secret) => (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const p = verifyAccessToken(token, secret);
    req.user = { id: p.sub, username: p.username };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
};
