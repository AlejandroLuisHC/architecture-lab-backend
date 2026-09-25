import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import { FirebaseUnavailableError } from '../firebase.js';
import { createApp } from '../index.js';

async function withServer<T>(app: ReturnType<typeof createApp>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('account routes reject absent, malformed, and invalid tokens without reaching data stores', async () => {
  const verifiedTokens: string[] = [];
  const app = createApp({
    verifyIdToken: async (token) => {
      verifiedTokens.push(token);
      throw new Error('invalid token');
    },
  });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/me/scenarios`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'UNAUTHENTICATED');

    const malformed = await fetch(`${baseUrl}/me/scenarios`, { headers: { Authorization: 'Basic abc' } });
    assert.equal(malformed.status, 401);
    assert.equal((await malformed.json()).code, 'UNAUTHENTICATED');

    const invalid = await fetch(`${baseUrl}/me/scenarios`, { headers: { Authorization: 'Bearer expired-token' } });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).code, 'INVALID_TOKEN');
  });

  assert.deepEqual(verifiedTokens, ['expired-token']);
});

test('account routes report an unavailable identity provider as a service error', async () => {
  const app = createApp({ verifyIdToken: async () => { throw new FirebaseUnavailableError(); } });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/me/scenarios`, { headers: { Authorization: 'Bearer any-token' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'ACCOUNT_UNAVAILABLE');
  });
});
