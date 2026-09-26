import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeArchitecture, analysisRequestSchema } from '../analysis.js';
import { estimateMonthlyCost } from '../pricing.js';
import { scenarioInputSchema, validateScenarioGraph } from '../scenario.js';

const workloadAssumptions = {
    requestsPerMonth: 100_000,
    averageDurationMs: 250,
    storageGb: 20,
    availabilityTarget: 99.9,
};

test('freeform AWS resources preserve typed details and explicit connections', () => {
    const input = scenarioInputSchema.parse({
        title: 'Web service',
        region: 'us-east-1',
        workloadAssumptions,
        configuration: {
            resources: [
                {
                    id: 'vpc',
                    type: 'awsResource',
                    schemaVersion: 1,
                    service: 'vpc',
                    name: 'app-network',
                    settings: { cidrBlock: '10.0.0.0/16', availabilityZones: 2 },
                },
                {
                    id: 'ec2',
                    type: 'awsResource',
                    schemaVersion: 1,
                    service: 'ec2',
                    name: 'app-server',
                    settings: { instanceType: 't3.micro', instanceCount: 1 },
                },
            ],
        },
        relationships: [{ sourceId: 'ec2', targetId: 'vpc', kind: 'attached-to' }],
    });
    assert.deepEqual(validateScenarioGraph(input), [
        { sourceId: 'ec2', targetId: 'vpc', kind: 'attached-to' },
    ]);
    assert.equal(
        input.configuration.resources[1].type === 'awsResource' &&
            input.configuration.resources[1].settings.instanceType,
        't3.micro',
    );
});

test('rules identify exposed storage, broad access, missing monitoring, and single-instance risk', async () => {
    const parsed = analysisRequestSchema.parse({
        region: 'us-east-1',
        workloadAssumptions,
        configuration: {
            resources: [
                { id: 'bucket', type: 's3Bucket', name: 'public-files', blockPublicAccess: false },
                { id: 'fn', type: 'lambdaFunction', name: 'handler' },
                {
                    id: 'policy',
                    type: 'iamPolicy',
                    name: 'admin-policy',
                    lambdaId: 'fn',
                    tableId: 'table',
                    accessLevel: 'admin',
                },
                {
                    id: 'ec2',
                    type: 'awsResource',
                    schemaVersion: 1,
                    service: 'ec2',
                    name: 'single-server',
                    settings: { instanceType: 't3.micro', instanceCount: 1 },
                },
            ],
        },
    });
    const graph = scenarioInputSchema.parse({
        title: 'Analysis draft',
        region: parsed.region,
        workloadAssumptions: parsed.workloadAssumptions,
        configuration: parsed.configuration,
    });
    const result = await analyzeArchitecture({ ...parsed, relationships: validateScenarioGraph(graph) });
    assert.ok(
        result.findings.some((finding) => finding.id === 'public-bucket' && finding.severity === 'critical'),
    );
    assert.ok(
        result.findings.some((finding) => finding.id === 'admin-policy' && finding.severity === 'critical'),
    );
    assert.ok(result.findings.some((finding) => finding.id === 'missing-logs'));
    assert.ok(result.findings.some((finding) => finding.id === 'single-instance-ec2'));
    assert.equal(
        result.performance.assumptions.some((item) => item.includes('no cloud workload was run')),
        false,
    );
});

test('unsupported price coverage is reported instead of inventing a price', async () => {
    const input = analysisRequestSchema.parse({
        region: 'us-east-1',
        workloadAssumptions,
        configuration: {
            resources: [
                {
                    id: 'database',
                    type: 'awsResource',
                    schemaVersion: 1,
                    service: 'aurora',
                    name: 'orders',
                    settings: { publiclyAccessible: false },
                },
            ],
        },
    });
    const result = await analyzeArchitecture(input);
    assert.equal(result.estimate.monthlyLow, null);
    assert.match(result.estimate.coverage, /unavailable/);
    assert.match(result.estimate.assumptions.join(' '), /storage charges are outside current price coverage/);
});

test('analysis flags service links whose roles do not fit the target service', async () => {
    const input = analysisRequestSchema.parse({
        region: 'us-east-1',
        workloadAssumptions,
        configuration: {
            resources: [
                {
                    id: 'api',
                    type: 'apiRoute',
                    name: 'orders',
                    path: '/orders',
                    method: 'GET',
                    lambdaId: 'missing',
                },
                {
                    id: 'db',
                    type: 'awsResource',
                    schemaVersion: 1,
                    service: 'aurora',
                    name: 'orders-db',
                    settings: {},
                },
            ],
        },
        relationships: [{ sourceId: 'api', targetId: 'db', kind: 'routes-to' }],
    });
    const result = await analyzeArchitecture(input);
    assert.ok(
        result.findings.some(
            (finding) =>
                finding.category === 'compatibility' &&
                finding.title === 'Connection does not match the selected service roles',
        ),
    );
});

test('live price-list products produce a dated EC2 and Lambda usage estimate', async () => {
    const originalFetch = globalThis.fetch;
    const effectiveDate = '2026-09-01T00:00:00Z';
    globalThis.fetch = async (input) => {
        const lambda = String(input).includes('AWSLambda');
        const file = lambda
            ? {
                  publicationDate: effectiveDate,
                  products: {
                      requests: {
                          sku: 'requests',
                          product: {
                              attributes: { location: 'US East (N. Virginia)', group: 'AWS-Lambda-Requests' },
                          },
                      },
                      duration: {
                          sku: 'duration',
                          product: {
                              attributes: { location: 'US East (N. Virginia)', group: 'AWS-Lambda-Duration' },
                          },
                      },
                  },
                  terms: {
                      OnDemand: {
                          requests: {
                              term1: {
                                  effectiveDate,
                                  priceDimensions: {
                                      requestRate: { unit: 'Requests', pricePerUnit: { USD: '0.0000002' } },
                                  },
                              },
                          },
                          duration: {
                              term2: {
                                  effectiveDate,
                                  priceDimensions: {
                                      durationRate: {
                                          unit: 'Lambda-GB-Second',
                                          pricePerUnit: { USD: '0.0000166667' },
                                      },
                                  },
                              },
                          },
                      },
                  },
              }
            : {
                  publicationDate: effectiveDate,
                  products: {
                      micro: {
                          sku: 'micro',
                          product: {
                              attributes: {
                                  location: 'US East (N. Virginia)',
                                  instanceType: 't3.micro',
                                  operatingSystem: 'Linux',
                                  tenancy: 'Shared',
                                  preInstalledSw: 'NA',
                                  capacitystatus: 'Used',
                              },
                          },
                      },
                  },
                  terms: {
                      OnDemand: {
                          micro: {
                              term3: {
                                  effectiveDate,
                                  priceDimensions: {
                                      hourly: { unit: 'Hrs', pricePerUnit: { USD: '0.0116' } },
                                  },
                              },
                          },
                      },
                  },
              };
        return new Response(JSON.stringify(file), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        const result = await estimateMonthlyCost(
            {
                resources: [
                    {
                        id: 'vm',
                        type: 'awsResource',
                        schemaVersion: 1,
                        service: 'ec2',
                        name: 'web',
                        settings: { instanceType: 't3.micro' },
                    },
                    { id: 'fn', type: 'lambdaFunction', name: 'handler', memoryMiB: 512 },
                ],
            },
            'us-east-1',
            workloadAssumptions,
            true,
        );
        assert.equal(result.catalog.length, 2);
        assert.equal(result.effectiveAt, effectiveDate);
        assert.equal(result.monthlyLow, 8.7);
        assert.match(result.coverage, /2 modeled compute resources priced/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
