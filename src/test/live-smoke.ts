import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authService } from '../firebase.js';
import { database } from '../database.js';
import { LAB_VERSION } from '../lab.js';

if (!process.argv.includes('--run')) throw new Error('Pass --run to perform a live smoke check.');
for (const file of ['.env', '.env.vercel.local', '../architecture-lab-frontend/.env.local']) {
    try {
        process.loadEnvFile(file);
    } catch {
        /* Explicit environment variables also work. */
    }
}

const apiKey = process.env.VITE_FIREBASE_API_KEY;
const baseUrl = process.env.SMOKE_API_URL;
if (!apiKey || !baseUrl || !process.env.DATABASE_URL)
    throw new Error('Firebase API key, SMOKE_API_URL, and DATABASE_URL are required.');

const auth = authService();
const users: string[] = [];
async function testToken(uid: string): Promise<string> {
    await auth.createUser({ uid });
    users.push(uid);
    const customToken = await auth.createCustomToken(uid);
    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey!)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        },
    );
    if (!response.ok) throw new Error(`Firebase sign-in failed: ${response.status}`);
    const body = (await response.json()) as { idToken: string };
    return body.idToken;
}

async function call(path: string, token: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

try {
    const ownerUid = `smoke-${randomUUID()}`;
    const strangerUid = `smoke-${randomUUID()}`;
    const ownerToken = await testToken(ownerUid);
    const strangerToken = await testToken(strangerUid);

    const saved = await call('/me/progress/serverless-web', ownerToken, 'PUT', {
        version: LAB_VERSION,
        configuration: { resources: [] },
        currentStep: 0,
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.body.progress as { version: number }).version, LAB_VERSION);
    const loaded = await call('/me/progress/serverless-web', ownerToken);
    assert.equal(loaded.status, 200);
    assert.deepEqual((loaded.body.progress as { configuration: object }).configuration, { resources: [] });
    const otherProgress = await call('/me/progress/serverless-web', strangerToken);
    assert.equal(otherProgress.status, 200);
    assert.equal(otherProgress.body.progress, null);

    const created = await call('/me/scenarios', ownerToken, 'POST', {
        title: 'Smoke test',
        region: 'us-east-1',
        configuration: { resources: [] },
    });
    assert.equal(created.status, 201);
    const scenarioId = (created.body.scenario as { id: string }).id;
    assert.equal((await call(`/me/scenarios/${scenarioId}`, strangerToken)).status, 404);
    const changed = await call(`/me/scenarios/${scenarioId}`, ownerToken, 'PUT', {
        title: 'Smoke test revised',
        region: 'us-east-1',
        configuration: { resources: [] },
        expectedRevision: 1,
    });
    assert.equal(changed.status, 200);
    assert.equal((changed.body.scenario as { currentRevision: number }).currentRevision, 2);
    assert.equal((await call(`/me/scenarios/${scenarioId}/revisions/1`, ownerToken)).status, 200);
    assert.equal(
        (
            await call(`/me/scenarios/${scenarioId}`, ownerToken, 'PUT', {
                title: 'Stale',
                region: 'us-east-1',
                configuration: { resources: [] },
                expectedRevision: 1,
            })
        ).status,
        409,
    );

    const persisted = await database().query<{ count: string }>(
        'SELECT count(*)::text AS count FROM module_attempts a JOIN scenarios s ON s.id=a.scenario_id JOIN workspaces w ON w.id=s.workspace_id WHERE w.owner_uid=$1',
        [ownerUid],
    );
    assert.equal(Number(persisted.rows[0].count), 1);
    console.log(
        'Live smoke check passed: Firebase token, PostgreSQL progress, scenario ownership, revisions, and conflict response.',
    );
} finally {
    if (users.length) {
        await database().query('DELETE FROM workspaces WHERE owner_uid = ANY($1::text[])', [users]);
        await database().query('DELETE FROM app_users WHERE firebase_uid = ANY($1::text[])', [users]);
        await Promise.all(users.map((uid) => auth.deleteUser(uid)));
    }
    await database().end();
}
