import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import test from 'node:test';
import app from './index.js';
import { initialConfiguration } from './lab.js';

test('guest API serves the lab, validates choices, and protects saved progress', async () => {
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const lesson = await fetch(`${base}/labs/serverless-web`);
    assert.equal(lesson.status, 200);
    const lessonBody = await lesson.json() as { lab: { version: number; steps: unknown[] } };
    assert.equal(lessonBody.lab.version, 1);
    assert.equal(lessonBody.lab.steps.length, 4);

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

    const progress = await fetch(`${base}/me/progress/serverless-web`);
    assert.equal(progress.status, 401);

    const unknown = await fetch(`${base}/labs/unknown`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
