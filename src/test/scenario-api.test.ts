import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import { database } from '../database.js';
import { createApp } from '../index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('scenario API enforces ownership and optimistic revision checks', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.PROGRESS_STORE = 'postgres';
  const owner = `api-owner-${randomUUID()}`;
  const stranger = `api-stranger-${randomUUID()}`;
  const app = createApp({ verifyIdToken: async (token) => ({ uid: token }) });
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const auth = (uid: string) => ({ Authorization: `Bearer ${uid}`, 'Content-Type': 'application/json' });
  const input = {
    title: 'First architecture',
    region: 'us-east-1',
    workloadAssumptions: { requestsPerMonth: 1000 },
    configuration: { resources: [] },
  };

  try {
    const createdResponse = await fetch(`${baseUrl}/me/scenarios`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify(input),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).scenario as { id: string; currentRevision: number };
    assert.equal(created.currentRevision, 1);

    const ownerRead = await fetch(`${baseUrl}/me/scenarios/${created.id}`, { headers: auth(owner) });
    assert.equal(ownerRead.status, 200);
    const strangerRead = await fetch(`${baseUrl}/me/scenarios/${created.id}`, { headers: auth(stranger) });
    assert.equal(strangerRead.status, 404);

    const strangerUpdate = await fetch(`${baseUrl}/me/scenarios/${created.id}`, {
      method: 'PUT', headers: auth(stranger), body: JSON.stringify({ ...input, expectedRevision: 1 }),
    });
    assert.equal(strangerUpdate.status, 404);

    const ownerUpdate = await fetch(`${baseUrl}/me/scenarios/${created.id}`, {
      method: 'PUT', headers: auth(owner), body: JSON.stringify({ ...input, title: 'Revised architecture', expectedRevision: 1 }),
    });
    assert.equal(ownerUpdate.status, 200);
    assert.equal((await ownerUpdate.json()).scenario.currentRevision, 2);

    const staleUpdate = await fetch(`${baseUrl}/me/scenarios/${created.id}`, {
      method: 'PUT', headers: auth(owner), body: JSON.stringify({ ...input, expectedRevision: 1 }),
    });
    assert.equal(staleUpdate.status, 409);
    assert.equal((await staleUpdate.json()).code, 'CONFLICT');

    const revisionsResponse = await fetch(`${baseUrl}/me/scenarios/${created.id}/revisions`, { headers: auth(owner) });
    assert.equal(revisionsResponse.status, 200);
    assert.deepEqual((await revisionsResponse.json()).revisions.map((revision: { revision: number }) => revision.revision), [2, 1]);

    const strangerRevisions = await fetch(`${baseUrl}/me/scenarios/${created.id}/revisions`, { headers: auth(stranger) });
    assert.equal(strangerRevisions.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await database().query('DELETE FROM workspaces WHERE owner_uid = ANY($1::text[])', [[owner, stranger]]);
    await database().query('DELETE FROM app_users WHERE firebase_uid = ANY($1::text[])', [[owner, stranger]]);
    await database().end();
  }
});
