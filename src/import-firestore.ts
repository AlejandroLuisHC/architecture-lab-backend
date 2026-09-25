import { database } from './database.js';
import { legacyFirestore } from './firebase.js';
import { LAB_ID } from './lab.js';
import { importLegacyProgress, type StoredProgress } from './store.js';

for (const file of ['.env', '.env.vercel.local']) {
  try { process.loadEnvFile(file); } catch { /* Environment may be provided by the shell. */ }
}

const apply = process.argv.includes('--apply');
const documents = await legacyFirestore().collectionGroup('labs').get();
const matching = documents.docs.filter((doc) => doc.id === LAB_ID && doc.ref.path.startsWith('progress/'));
const counts = { source: matching.length, imported: 0, alreadyImported: 0, unsupported: 0 };

for (const doc of matching) {
  const uid = doc.ref.parent.parent?.id;
  if (!uid || !apply) continue;
  const result = await importLegacyProgress(uid, doc.ref.path, doc.data() as StoredProgress);
  if (result === 'imported') counts.imported += 1;
  else if (result === 'already-imported') counts.alreadyImported += 1;
  else counts.unsupported += 1;
}

if (apply) {
  const databaseCount = await database().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM legacy_imports WHERE source_path LIKE $1', [`progress/%/labs/${LAB_ID}`],
  );
  console.log(JSON.stringify({ ...counts, databaseCount: Number(databaseCount.rows[0].count), verified: counts.unsupported === 0 && Number(databaseCount.rows[0].count) === counts.source }, null, 2));
  if (counts.unsupported > 0 || Number(databaseCount.rows[0].count) !== counts.source) process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ...counts, message: 'Dry run. Pass --apply to import.' }, null, 2));
}
await database().end();
