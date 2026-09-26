import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../index.js';

test('guest analysis returns findings and honest coverage without saving a cloud resource', async () => {
    const server = createApp({ verifyIdToken: async (token) => ({ uid: token }) }).listen(0);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    try {
        const response = await fetch(`${base}/sandbox/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                region: 'us-east-1',
                workloadAssumptions: {
                    requestsPerMonth: 1000,
                    averageDurationMs: 300,
                    storageGb: 10,
                    availabilityTarget: 99.9,
                },
                configuration: {
                    resources: [
                        {
                            id: 'db',
                            type: 'awsResource',
                            schemaVersion: 1,
                            service: 'aurora',
                            name: 'orders',
                            settings: { publiclyAccessible: true },
                        },
                    ],
                },
            }),
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
            analysis: {
                findings: Array<{ id: string }>;
                estimate: { monthlyLow: number | null; coverage: string };
                performance: { summary: string };
            };
        };
        assert.ok(body.analysis.findings.some((finding) => finding.id === 'public-resource-db'));
        assert.equal(body.analysis.estimate.monthlyLow, null);
        assert.match(body.analysis.estimate.coverage, /unavailable/);
        assert.match(body.analysis.performance.summary, /no cloud workload was run/);

        const invalid = await fetch(`${base}/sandbox/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                region: 'us-east-1',
                workloadAssumptions: {
                    requestsPerMonth: -1,
                    averageDurationMs: 300,
                    storageGb: 10,
                    availabilityTarget: 99.9,
                },
                configuration: { resources: [] },
            }),
        });
        assert.equal(invalid.status, 400);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});
