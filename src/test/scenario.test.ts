import assert from 'node:assert/strict';
import test from 'node:test';
import { derivedRelationships, scenarioInputSchema, validateScenarioGraph } from '../scenario.js';

const configuration = {
  resources: [
    { id: 'bucket', type: 's3Bucket', name: 'site-assets', blockPublicAccess: true },
    { id: 'cdn', type: 'cloudFrontDistribution', name: 'site', originBucketId: 'bucket', enabled: true, originAccessControl: true },
    { id: 'fn', type: 'lambdaFunction', name: 'getItems' },
    { id: 'route', type: 'apiRoute', name: 'items', path: '/api/items', method: 'GET', lambdaId: 'fn' },
  ],
} as const;

test('valid resource references become typed graph links', () => {
  const parsed = scenarioInputSchema.parse({ title: 'Site', region: 'us-east-1', configuration });
  assert.deepEqual(derivedRelationships(parsed.configuration), [
    { sourceId: 'cdn', targetId: 'bucket', kind: 'uses-origin' },
    { sourceId: 'route', targetId: 'fn', kind: 'invokes' },
  ]);
  assert.equal(validateScenarioGraph(parsed).length, 2);
});

test('invalid references remain draft settings rather than becoming graph links', () => {
  const broken = { resources: [...configuration.resources.slice(0, 2), { id: 'broken', type: 'apiRoute', name: 'broken', path: '/broken', method: 'GET', lambdaId: 'missing' }] };
  const parsed = scenarioInputSchema.parse({ title: 'Site', region: 'us-east-1', configuration: broken });
  assert.deepEqual(validateScenarioGraph(parsed), [{ sourceId: 'cdn', targetId: 'bucket', kind: 'uses-origin' }]);
});

test('explicit dangling, inconsistent, and duplicate relationships are rejected', () => {
  const base = scenarioInputSchema.parse({ title: 'Site', region: 'us-east-1', configuration });
  assert.throws(() => validateScenarioGraph({ ...base, relationships: [{ sourceId: 'cdn', targetId: 'missing', kind: 'uses-origin' }] }));
  assert.throws(() => validateScenarioGraph({ ...base, relationships: [{ sourceId: 'cdn', targetId: 'fn', kind: 'uses-origin' }] }));
  const valid = derivedRelationships(base.configuration);
  assert.throws(() => validateScenarioGraph({ ...base, relationships: [...valid, valid[0]] }));
});

test('duplicate resource IDs are rejected', () => {
  const parsed = scenarioInputSchema.parse({ title: 'Site', region: 'us-east-1', configuration: { resources: [configuration.resources[0], configuration.resources[0]] } });
  assert.throws(() => validateScenarioGraph(parsed));
});
