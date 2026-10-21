import test from 'node:test';
import assert from 'node:assert/strict';

test('client identity stays stable when browser storage is unavailable', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { throw new Error('Storage disabled'); },
  } });
  try {
    const { getOrCreateClientId, getClientHeaders } = await import('./clientSession.ts');
    const clientId = getOrCreateClientId();
    assert.equal(getOrCreateClientId(), clientId);
    assert.equal(getClientHeaders()['X-Client-Id'], clientId);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});
