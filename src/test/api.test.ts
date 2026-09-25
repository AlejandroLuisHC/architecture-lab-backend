import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import app from '../index.js';
import { initialConfiguration } from '../lab.js';

test('guest API serves the lab, validates choices, and protects saved progress', async () => {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const lesson = await fetch(`${base}/labs/serverless-web`);
    assert.equal(lesson.status, 200);
    const lessonBody = await lesson.json() as { lab: { version: number; steps: unknown[]; serviceCatalog: unknown[] } };
    assert.equal(lessonBody.lab.version, 2);
    assert.equal(lessonBody.lab.steps.length, 4);
    assert.equal(lessonBody.lab.serviceCatalog.length, 6);

    const validation = await fetch(`${base}/labs/serverless-web/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: initialConfiguration }),
    });
    assert.equal(validation.status, 200);
    const validationBody = await validation.json() as {
      evaluation: { complete: boolean; steps: Array<{ checks: Array<{ hint: string }> }> };
    };
    assert.equal(validationBody.evaluation.complete, false);
    assert.ok(validationBody.evaluation.steps[0].checks[0].hint.length > 0);

    const malformed = await fetch(`${base}/labs/serverless-web/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: { resources: [{ id: 'bad', type: 'unknown' }] } }),
    });
    assert.equal(malformed.status, 400);

    const progress = await fetch(`${base}/me/progress/serverless-web`);
    assert.equal(progress.status, 401);

    const scenarios = await fetch(`${base}/me/scenarios`);
    assert.equal(scenarios.status, 401);

    const unknown = await fetch(`${base}/labs/unknown`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
