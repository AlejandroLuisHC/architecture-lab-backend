import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { database, transaction } from './database.js';

if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL) {
    for (const file of ['.env', '.env.vercel.local']) {
        try {
            process.loadEnvFile(file);
        } catch {
            /* Environment may be provided by the shell. */
        }
    }
}

const files = readdirSync('migrations')
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
for (const file of files) {
    const applied = await transaction(async (client) => {
        await client.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
        );
        await client.query('SELECT pg_advisory_xact_lock(149237801)');
        const found = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
        if (found.rowCount) return false;
        await client.query(readFileSync(join('migrations', file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
        return true;
    });
    console.log(`${applied ? 'Applied' : 'Already applied'} ${file}`);
}
await database().end();
