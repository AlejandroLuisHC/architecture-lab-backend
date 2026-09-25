import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { default: app } = await import('./index.js');

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Architecture Lab API listening on http://localhost:${port}`);
});
