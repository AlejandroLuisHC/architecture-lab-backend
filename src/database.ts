import { Pool, type PoolClient } from 'pg';

export class DatabaseUnavailableError extends Error {
    constructor() {
        super('Saved scenarios are unavailable because PostgreSQL is not configured.');
    }
}

let pool: Pool | undefined;

export function database(): Pool {
    if (!process.env.DATABASE_URL) throw new DatabaseUnavailableError();
    if (!pool) {
        const connection = new URL(process.env.DATABASE_URL);
        if (connection.searchParams.get('sslmode') === 'require')
            connection.searchParams.set('sslmode', 'verify-full');
        pool = new Pool({ connectionString: connection.toString(), max: 5 });
    }
    return pool;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database().connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
