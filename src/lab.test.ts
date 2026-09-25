import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateConfiguration, initialConfiguration, type LabConfiguration } from './lab.js';

const correctConfiguration: LabConfiguration = {
  storage: {
    bucketName: 'my-web-assets',
    blockPublicAccess: true,
    cloudFrontEnabled: true,
    originAccessControl: true,
  },
  api: { route: '/api/items', method: 'ANY', lambdaConnected: true },
  data: {
    tableName: 'app-items',
    partitionKey: 'id',
    lambdaTableConnected: true,
    permissions: 'read-write',
  },
  observability: { logsEnabled: true, retentionDays: 7, errorAlarmEnabled: true },
};

test('a fully configured architecture completes all four stages', () => {
  const result = evaluateConfiguration(correctConfiguration);
  assert.equal(result.complete, true);
  assert.equal(result.steps.length, 4);
  assert.equal(result.passedChecks, result.totalChecks);
});

test('the empty configuration gives actionable feedback for every stage', () => {
  const result = evaluateConfiguration(initialConfiguration);
  assert.equal(result.complete, false);
  assert.ok(result.steps.every((step) => !step.passed));
  assert.ok(result.steps.flatMap((step) => step.checks).every((check) => check.hint.length > 0));
});

test('public S3 and broad IAM access are rejected even when the rest is correct', () => {
  const configuration = structuredClone(correctConfiguration);
  configuration.storage.blockPublicAccess = false;
  configuration.data.permissions = 'admin';
  const result = evaluateConfiguration(configuration);
  assert.equal(result.complete, false);
  assert.equal(result.steps[0].passed, false);
  assert.equal(result.steps[2].passed, false);
  assert.equal(result.steps[1].passed, true);
  assert.equal(result.steps[3].passed, true);
});
