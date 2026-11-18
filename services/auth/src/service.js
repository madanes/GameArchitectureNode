import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { signAccessToken, conflict, unauthorized, isDuplicateKey } from '@ipm/common';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const publicUser = (u) => ({ id: u._id, username: u.username, isGuest: !!u.isGuest });

/**
 * Identity: accounts in Mongo (`auth.users`), refresh tokens in Redis.
 * Refresh tokens are random opaque strings, stored hashed, rotated on every use and revocable.
 */
export function createAuthService({ db, redis, config }) {
  const users = db.collection('users');
  const refreshKey = (token) => `auth:refresh:${sha256(token)}`;

  async function init() {
    await users.createIndex({ username: 1 }, { unique: true });
    await users.createIndex({ email: 1 }, { unique: true, sparse: true }); // guests have no email
  }

  async function issueTokens(user) {
    const accessToken = signAccessToken({ id: user._id, username: user.username }, { secret: config.jwtSecret, ttlSec: config.accessTtlSec });
    const refreshToken = randomBytes(32).toString('hex');
    await redis.set(refreshKey(refreshToken), user._id, 'EX', config.refreshTtlSec);
    return { user: publicUser(user), accessToken, refreshToken, expiresIn: config.accessTtlSec };
  }

  async function register({ username, email, password }) {
    const user = {
      _id: randomUUID(), username, email: email.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 10), isGuest: false, createdAt: new Date(),
    };
    try { await users.insertOne(user); } catch (err) {
      if (isDuplicateKey(err)) throw conflict('Username or email already taken');
      throw err;
    }
    return issueTokens(user);
  }

  async function login({ identifier, password }) {
    const user = await users.findOne({ $or: [{ username: identifier }, { email: identifier.toLowerCase() }] });
    // compare even when the user is missing to keep timing uniform
    const ok = await bcrypt.compare(password, user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidu');
    if (!user || !ok) throw unauthorized('Invalid credentials');
    return issueTokens(user);
  }

  async function guest() {
    const user = { _id: randomUUID(), username: `Guest-${randomBytes(3).toString('hex')}`, isGuest: true, createdAt: new Date() };
    await users.insertOne(user);
    return issueTokens(user);
  }

  async function refresh(token) {
    const key = refreshKey(token);
    const userId = await redis.getdel(key); // single use -> rotation
    if (!userId) throw unauthorized('Invalid refresh token');
    const user = await users.findOne({ _id: userId });
    if (!user) throw unauthorized('Invalid refresh token');
    return issueTokens(user);
  }

  const logout = (token) => redis.del(refreshKey(token));
  const me = async (id) => publicUser(await users.findOne({ _id: id }));

  return { init, register, login, guest, refresh, logout, me };
}
