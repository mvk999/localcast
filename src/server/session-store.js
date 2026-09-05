import crypto from 'node:crypto';

export const SESSION_TTL_MS = 2 * 60 * 1000;
export const ACTIVE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class SessionStore {
  #sessions = new Map();

  constructor({ now = () => Date.now(), ttlMs = SESSION_TTL_MS, activeTtlMs = ACTIVE_SESSION_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.activeTtlMs = activeTtlMs;
  }

  create() {
    this.prune();
    let code;
    do {
      code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    } while ([...this.#sessions.values()].some((session) => session.code === code && session.state === 'waiting'));

    const createdAt = this.now();
    const session = {
      id: crypto.randomBytes(18).toString('base64url'),
      code,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      authorized: false,
      state: 'waiting',
      tvSocket: undefined,
      senderSocket: undefined
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  authorize(code) {
    this.prune();
    const session = [...this.#sessions.values()].find((item) => item.state === 'waiting' && item.code === code);
    if (!session) return { ok: false, reason: 'invalid_or_expired' };
    session.authorized = true;
    session.code = undefined; // A successful PIN can never be used again.
    session.state = 'authorized';
    session.expiresAt = this.now() + this.activeTtlMs;
    return { ok: true, session };
  }

  get(id) {
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt <= this.now()) return undefined;
    return session;
  }

  invalidate(id) {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    session.authorized = false;
    session.code = undefined;
    session.state = 'closed';
    this.#sessions.delete(id);
    return session;
  }

  prune() {
    const expired = [];
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= this.now()) {
        session.state = 'expired';
        this.#sessions.delete(session.id);
        expired.push(session);
      }
    }
    return expired;
  }
}
