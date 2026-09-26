import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { database } from '../database.js';
import {
    ConflictError,
    createScenario,
    getScenario,
    listRevisions,
    listScenarios,
    NotFoundError,
    updateScenario,
} from '../store.js';

if (process.env.RUN_DB_TESTS === 'true' && !process.env.TEST_DATABASE_URL) {
    try {
        process.loadEnvFile('.env.vercel.local');
    } catch {
        /* The caller may supply TEST_DATABASE_URL directly. */
    }
    process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}

test(
    'PostgreSQL isolates owners and preserves immutable scenario revisions',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const owner = `test-${randomUUID()}`;
        const stranger = `test-${randomUUID()}`;
        const input = {
            title: 'First architecture',
            region: 'us-east-1',
            workloadAssumptions: { requestsPerMonth: 1000 },
            configuration: { resources: [] },
        };
        try {
            const created = await createScenario(owner, input);
            assert.equal(created.currentRevision, 1);
            assert.equal((await listScenarios(owner)).length, 1);
            assert.equal((await listScenarios(stranger)).length, 0);
            await assert.rejects(getScenario(stranger, created.id), NotFoundError);
            const updated = await updateScenario(
                owner,
                created.id,
                { ...input, title: 'Revised architecture' },
                1,
            );
            assert.equal(updated.currentRevision, 2);
            await assert.rejects(updateScenario(owner, created.id, input, 1), ConflictError);
            const first = await getScenario(owner, created.id, 1);
            const second = await getScenario(owner, created.id, 2);
            assert.equal((first.snapshot as { title: string }).title, 'First architecture');
            assert.equal((second.snapshot as { title: string }).title, 'Revised architecture');
            assert.deepEqual(
                (await listRevisions(owner, created.id)).map((item) => item.revision),
                [2, 1],
            );
        } finally {
            await database().query('DELETE FROM workspaces WHERE owner_uid = ANY($1::text[])', [
                [owner, stranger],
            ]);
            await database().query('DELETE FROM app_users WHERE firebase_uid = ANY($1::text[])', [
                [owner, stranger],
            ]);
            await database().end();
        }
    },
);
