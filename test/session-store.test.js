import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/server/session-store.js';

test('a PIN authorizes exactly one live session and the active cast outlives the PIN', () => {
  let clock = 10;
  const store = new SessionStore({ now: () => clock, ttlMs: 100, activeTtlMs: 1_000 });
  const session = store.create();
  const result = store.authorize(session.code);

  assert.equal(result.ok, true);
  assert.equal(result.session.authorized, true);
  assert.equal(store.authorize(session.code).ok, false);
  assert.equal(session.code, undefined);
  clock = 111;
  assert.equal(store.get(session.id), session);
});

test('rejects unknown and expired PINs', () => {
  let clock = 0;
  const store = new SessionStore({ now: () => clock, ttlMs: 10 });
  const session = store.create();
  assert.equal(store.authorize('000000').reason, 'invalid_or_expired');
  clock = 11;
  assert.equal(store.authorize(session.code).reason, 'invalid_or_expired');
});
