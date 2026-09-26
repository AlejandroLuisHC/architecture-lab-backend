import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateConfiguration, initialConfiguration, type LabConfiguration } from '../lab.js';

const configured: LabConfiguration = {
    resources: [
        { id: 'bucket-1', type: 's3Bucket', name: 'my-web-assets', blockPublicAccess: true },
        {
            id: 'distribution-1',
            type: 'cloudFrontDistribution',
            name: 'site-delivery',
            originBucketId: 'bucket-1',
            enabled: true,
            originAccessControl: true,
        },
        { id: 'function-1', type: 'lambdaFunction', name: 'app-function' },
        {
            id: 'route-1',
            type: 'apiRoute',
            name: 'items-route',
            path: '/api/items',
            method: 'ANY',
            lambdaId: 'function-1',
        },
        { id: 'table-1', type: 'dynamoTable', name: 'app-items', partitionKey: 'id' },
        {
            id: 'policy-1',
            type: 'iamPolicy',
            name: 'function-table-access',
            lambdaId: 'function-1',
            tableId: 'table-1',
            accessLevel: 'read-write',
        },
        {
            id: 'logs-1',
            type: 'cloudWatchLogGroup',
            name: '/aws/lambda/app-function',
            lambdaId: 'function-1',
            retentionDays: 7,
        },
        {
            id: 'alarm-1',
            type: 'cloudWatchAlarm',
            name: 'function-errors',
            lambdaId: 'function-1',
            metric: 'Errors',
        },
    ],
};

test('a connected sandbox architecture completes all four stages', () => {
    const result = evaluateConfiguration(configured);
    assert.equal(result.complete, true);
    assert.equal(result.steps.length, 4);
    assert.equal(result.passedChecks, result.totalChecks);
});

test('the empty sandbox gives actionable feedback for every stage', () => {
    const result = evaluateConfiguration(initialConfiguration);
    assert.equal(result.complete, false);
    assert.ok(result.steps.every((step) => !step.passed));
    assert.ok(result.steps.flatMap((step) => step.checks).every((item) => item.hint.length > 0));
});

test('a distribution cannot make a public or unrelated bucket a valid origin', () => {
    const configuration = structuredClone(configured);
    configuration.resources[0] = {
        id: 'bucket-1',
        type: 's3Bucket',
        name: 'my-web-assets',
        blockPublicAccess: false,
    };
    const result = evaluateConfiguration(configuration);
    assert.equal(result.steps[0].passed, false);
    assert.equal(result.steps[1].passed, true);
});

test('the API route must reference an existing function and use ANY', () => {
    const configuration = structuredClone(configured);
    const route = configuration.resources.find((resource) => resource.type === 'apiRoute');
    assert.ok(route && route.type === 'apiRoute');
    route.method = 'GET';
    route.lambdaId = 'missing-function';
    const result = evaluateConfiguration(configuration);
    assert.equal(result.steps[1].passed, false);
});

test('administrator permissions do not pass the least privilege check', () => {
    const configuration = structuredClone(configured);
    const policy = configuration.resources.find((resource) => resource.type === 'iamPolicy');
    assert.ok(policy && policy.type === 'iamPolicy');
    policy.accessLevel = 'admin';
    const result = evaluateConfiguration(configuration);
    assert.equal(result.steps[2].passed, false);
});

test('logs and alarms must target an existing function and use the required settings', () => {
    const configuration = structuredClone(configured);
    const alarm = configuration.resources.find((resource) => resource.type === 'cloudWatchAlarm');
    assert.ok(alarm && alarm.type === 'cloudWatchAlarm');
    alarm.metric = 'Invocations';
    const result = evaluateConfiguration(configuration);
    assert.equal(result.steps[3].passed, false);
});
