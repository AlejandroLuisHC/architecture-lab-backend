import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL && existsSync('.env.vercel.local')) process.loadEnvFile('.env.vercel.local');
if (process.env.DATABASE_URL) process.env.PROGRESS_STORE ??= 'postgres';

const { default: app } = await import('./index.js');

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Architecture Lab API listening on http://localhost:${port}`);
});
