import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from './database.js';
import { evaluateConfiguration, lab, LAB_ID, LAB_VERSION, type LabConfiguration } from './lab.js';
import { scenarioInputSchema, serviceFor, validateScenarioGraph, type ScenarioInput } from './scenario.js';

export type ProgressInput = { version: number; configuration: LabConfiguration; currentStep: number };
export type StoredProgress = ProgressInput & {
  unlockedThroughStep: number; updatedAt: string; completedAt: string | null;
};
type ScenarioRow = { id: string; title: string; mode: string; region: string; origin: string; origin_metadata: object; workload_assumptions: object; current_revision: number; created_at: Date; updated_at: Date };
type AttemptRow = { id: string; scenario_id: string; module_version: number; current_step: number; unlocked_through_step: number; completed_at: Date | null; updated_at: Date };

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class LabVersionMismatchError extends ConflictError {}

const legacyProgressSchema = z.object({
  version: z.number().int(),
  configuration: z.object({ resources: z.array(z.unknown()) }),
  currentStep: z.number().int().min(0),
  unlockedThroughStep: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

async function publishModule(client: PoolClient) {
  const definition = JSON.stringify(lab);
  const hash = createHash('sha256').update(definition).digest('hex');
  await client.query(
    'INSERT INTO module_versions(module_id, version, definition, content_hash) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING',
    [LAB_ID, LAB_VERSION, definition, hash],
  );
  const result = await client.query<{ content_hash: string }>('SELECT content_hash FROM module_versions WHERE module_id=$1 AND version=$2', [LAB_ID, LAB_VERSION]);
  if (result.rows[0]?.content_hash !== hash) throw new ConflictError('The published lab definition changed without a version increase.');
}

async function personalWorkspace(client: PoolClient, uid: string): Promise<string> {
  await client.query('INSERT INTO app_users(firebase_uid) VALUES($1) ON CONFLICT DO NOTHING', [uid]);
  await client.query('INSERT INTO workspaces(id, owner_uid) VALUES($1,$2) ON CONFLICT(owner_uid) DO NOTHING', [randomUUID(), uid]);
  const result = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE owner_uid=$1', [uid]);
  return result.rows[0].id;
}

function snapshot(input: ScenarioInput) {
  return { title: input.title, region: input.region, workloadAssumptions: input.workloadAssumptions, configuration: input.configuration, relationships: validateScenarioGraph(input) };
}

async function writeResources(client: PoolClient, scenarioId: string, input: ScenarioInput) {
  const relationships = validateScenarioGraph(input);
  await client.query('DELETE FROM scenario_relationships WHERE scenario_id=$1', [scenarioId]);
  await client.query('DELETE FROM scenario_resources WHERE scenario_id=$1', [scenarioId]);
  for (const resource of input.configuration.resources) {
    await client.query(
      'INSERT INTO scenario_resources(scenario_id,id,service,resource_type,schema_version,name,region,config) VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb)',
      [scenarioId, resource.id, serviceFor(resource.type), resource.type, resource.name, input.region, JSON.stringify(resource)],
    );
  }
  for (const link of relationships) {
    await client.query('INSERT INTO scenario_relationships(scenario_id,source_id,target_id,kind) VALUES($1,$2,$3,$4)', [scenarioId, link.sourceId, link.targetId, link.kind]);
  }
}

async function createScenarioTx(client: PoolClient, workspaceId: string, input: ScenarioInput, mode: 'guided' | 'freeform', origin: 'created-in-sandbox' | 'imported' = 'created-in-sandbox', originMetadata: object = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO scenarios(id,workspace_id,title,mode,region,origin,origin_metadata,workload_assumptions,current_revision) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,1)',
    [id, workspaceId, input.title, mode, input.region, origin, JSON.stringify(originMetadata), JSON.stringify(input.workloadAssumptions)],
  );
  await writeResources(client, id, input);
  await client.query('INSERT INTO scenario_revisions(scenario_id,revision,snapshot) VALUES($1,1,$2::jsonb)', [id, JSON.stringify(snapshot(input))]);
  return id;
}

async function ownedScenario(client: PoolClient, uid: string, id: string, lock = false): Promise<ScenarioRow> {
  const result = await client.query<ScenarioRow>(
    `SELECT s.* FROM scenarios s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=$1 AND w.owner_uid=$2 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [id, uid],
  );
  if (!result.rows[0]) throw new NotFoundError('Scenario not found.');
  return result.rows[0];
}

async function updateScenarioTx(client: PoolClient, row: ScenarioRow, input: ScenarioInput): Promise<number> {
  const revision = row.current_revision + 1;
  await writeResources(client, row.id, input);
  await client.query('UPDATE scenarios SET title=$2,region=$3,workload_assumptions=$4::jsonb,current_revision=$5,updated_at=now() WHERE id=$1', [row.id, input.title, input.region, JSON.stringify(input.workloadAssumptions), revision]);
  await client.query('INSERT INTO scenario_revisions(scenario_id,revision,snapshot) VALUES($1,$2,$3::jsonb)', [row.id, revision, JSON.stringify(snapshot(input))]);
  return revision;
}

function calculatedProgress(input: ProgressInput, previous?: AttemptRow, importedCompletedAt?: string | null): StoredProgress {
  const evaluation = evaluateConfiguration(input.configuration);
  let validatedUnlock = 0;
  for (let index = 0; index < evaluation.steps.length - 1; index += 1) {
    if (!evaluation.steps[index].passed) break;
    validatedUnlock = index + 1;
  }
  const unlockedThroughStep = Math.max(previous?.unlocked_through_step ?? 0, validatedUnlock);
  return {
    ...input,
    currentStep: Math.min(input.currentStep, unlockedThroughStep),
    unlockedThroughStep,
    updatedAt: new Date().toISOString(),
    completedAt: evaluation.complete ? (importedCompletedAt ?? previous?.completed_at?.toISOString() ?? new Date().toISOString()) : null,
  };
}

async function latestAttempt(client: PoolClient, workspaceId: string, lock = false): Promise<AttemptRow | undefined> {
  const result = await client.query<AttemptRow>(
    `SELECT a.* FROM module_attempts a JOIN scenarios s ON s.id=a.scenario_id WHERE s.workspace_id=$1 AND a.module_id=$2 ORDER BY a.updated_at DESC, a.id DESC LIMIT 1 ${lock ? 'FOR UPDATE OF a' : ''}`,
    [workspaceId, LAB_ID],
  );
  return result.rows[0];
}

export async function getProgress(uid: string): Promise<StoredProgress | null> {
  return transaction(async (client) => {
    const workspaceId = await personalWorkspace(client, uid);
    const attempt = await latestAttempt(client, workspaceId);
    if (!attempt) return null;
    if (attempt.module_version !== LAB_VERSION) throw new LabVersionMismatchError('This saved run belongs to an older lab version. Start a new run to continue.');
    const revision = await client.query<{ snapshot: { configuration: LabConfiguration } }>('SELECT snapshot FROM scenario_revisions WHERE scenario_id=$1 AND revision=(SELECT current_revision FROM scenarios WHERE id=$1)', [attempt.scenario_id]);
    return { version: attempt.module_version, configuration: revision.rows[0].snapshot.configuration, currentStep: attempt.current_step, unlockedThroughStep: attempt.unlocked_through_step, updatedAt: attempt.updated_at.toISOString(), completedAt: attempt.completed_at?.toISOString() ?? null };
  });
}

export async function saveProgress(uid: string, input: ProgressInput): Promise<StoredProgress> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [uid]);
    await publishModule(client);
    const workspaceId = await personalWorkspace(client, uid);
    const previous = await latestAttempt(client, workspaceId, true);
    const current = previous?.module_version === LAB_VERSION ? previous : undefined;
    const progress = calculatedProgress(input, current);
    const scenarioInput: ScenarioInput = { title: lab.title, region: 'us-east-1', workloadAssumptions: {}, configuration: input.configuration };
    if (current) {
      const row = await ownedScenario(client, uid, current.scenario_id, true);
      await updateScenarioTx(client, row, scenarioInput);
      await client.query('UPDATE module_attempts SET current_step=$2,unlocked_through_step=$3,completed_at=$4,updated_at=$5 WHERE id=$1', [current.id, progress.currentStep, progress.unlockedThroughStep, progress.completedAt, progress.updatedAt]);
    } else {
      const scenarioId = await createScenarioTx(client, workspaceId, scenarioInput, 'guided');
      await client.query('INSERT INTO module_attempts(id,scenario_id,module_id,module_version,current_step,unlocked_through_step,completed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), scenarioId, LAB_ID, LAB_VERSION, progress.currentStep, progress.unlockedThroughStep, progress.completedAt, progress.updatedAt]);
    }
    return progress;
  });
}

export async function importLegacyProgress(uid: string, sourcePath: string, legacy: StoredProgress): Promise<'imported' | 'already-imported' | 'unsupported'> {
  if (!legacyProgressSchema.safeParse(legacy).success || legacy.version !== LAB_VERSION) return 'unsupported';
  const parsed = scenarioInputForLegacy(legacy);
  if (!parsed) return 'unsupported';
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [uid]);
    const existing = await client.query('SELECT 1 FROM legacy_imports WHERE source_path=$1', [sourcePath]);
    if (existing.rowCount) return 'already-imported';
    await publishModule(client);
    const workspaceId = await personalWorkspace(client, uid);
    const scenarioId = await createScenarioTx(client, workspaceId, parsed, 'guided', 'imported', { source: 'firestore-progress', sourcePath });
    const progress = calculatedProgress(legacy, undefined, legacy.completedAt);
    await client.query('INSERT INTO module_attempts(id,scenario_id,module_id,module_version,current_step,unlocked_through_step,completed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), scenarioId, LAB_ID, LAB_VERSION, Math.min(legacy.currentStep, progress.unlockedThroughStep), Math.max(legacy.unlockedThroughStep, progress.unlockedThroughStep), progress.completedAt, legacy.updatedAt]);
    await client.query('INSERT INTO legacy_imports(source_path,scenario_id) VALUES($1,$2)', [sourcePath, scenarioId]);
    return 'imported';
  });
}

function scenarioInputForLegacy(legacy: StoredProgress): ScenarioInput | null {
  const parsed = scenarioInputSchema.safeParse({ title: lab.title, region: 'us-east-1', configuration: legacy.configuration });
  if (!parsed.success) return null;
  try { validateScenarioGraph(parsed.data); return parsed.data; } catch { return null; }
}

export async function listScenarios(uid: string) {
  return transaction(async (client) => {
    const workspaceId = await personalWorkspace(client, uid);
    const result = await client.query<ScenarioRow & { module_id: string | null; module_version: number | null }>(
      'SELECT s.*,a.module_id,a.module_version FROM scenarios s LEFT JOIN module_attempts a ON a.scenario_id=s.id WHERE s.workspace_id=$1 ORDER BY s.updated_at DESC', [workspaceId],
    );
    return result.rows.map((row) => ({ id: row.id, title: row.title, mode: row.mode, region: row.region, origin: row.origin, currentRevision: row.current_revision, moduleId: row.module_id, moduleVersion: row.module_version, updatedAt: row.updated_at.toISOString() }));
  });
}

export async function createScenario(uid: string, input: ScenarioInput) {
  return transaction(async (client) => {
    const workspaceId = await personalWorkspace(client, uid);
    const id = await createScenarioTx(client, workspaceId, input, 'freeform');
    return { id, currentRevision: 1 };
  });
}

export async function getScenario(uid: string, id: string, revision?: number) {
  return transaction(async (client) => {
    const row = await ownedScenario(client, uid, id);
    const selectedRevision = revision ?? row.current_revision;
    const found = await client.query<{ snapshot: unknown; created_at: Date }>('SELECT snapshot,created_at FROM scenario_revisions WHERE scenario_id=$1 AND revision=$2', [id, selectedRevision]);
    if (!found.rows[0]) throw new NotFoundError('Revision not found.');
    const attempt = await client.query<AttemptRow & { module_id: string }>('SELECT * FROM module_attempts WHERE scenario_id=$1', [id]);
    return { id, title: row.title, mode: row.mode, region: row.region, origin: row.origin, originMetadata: row.origin_metadata, workloadAssumptions: row.workload_assumptions, currentRevision: row.current_revision, revision: selectedRevision, snapshot: found.rows[0].snapshot, revisionCreatedAt: found.rows[0].created_at.toISOString(), attempt: attempt.rows[0] ? { moduleId: attempt.rows[0].module_id, moduleVersion: attempt.rows[0].module_version, currentStep: attempt.rows[0].current_step, unlockedThroughStep: attempt.rows[0].unlocked_through_step, completedAt: attempt.rows[0].completed_at?.toISOString() ?? null } : null };
  });
}

export async function listRevisions(uid: string, id: string) {
  return transaction(async (client) => {
    await ownedScenario(client, uid, id);
    const result = await client.query<{ revision: number; created_at: Date }>('SELECT revision,created_at FROM scenario_revisions WHERE scenario_id=$1 ORDER BY revision DESC', [id]);
    return result.rows.map((row) => ({ revision: row.revision, createdAt: row.created_at.toISOString() }));
  });
}

export async function updateScenario(uid: string, id: string, input: ScenarioInput, expectedRevision: number) {
  return transaction(async (client) => {
    const row = await ownedScenario(client, uid, id, true);
    if (row.current_revision !== expectedRevision) throw new ConflictError('This scenario changed. Reload it before saving.');
    if (row.mode === 'guided') throw new ConflictError('Use the module progress route to edit a guided scenario.');
    return { id, currentRevision: await updateScenarioTx(client, row, input) };
  });
}
