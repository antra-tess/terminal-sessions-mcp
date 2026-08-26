/**
 * Regression tests for timeout/teardown fixes:
 * - client request timeouts must always exceed the server-side wait
 * - graceful killSession must not burn its full fallback timeout
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');
const { RobustSessionClient } = require('../dist/src/client/websocket-client.js');

const server = new PersistentSessionServer();

after(async () => {
  await server.killAll(false);
});

test('graceful kill of an idle shell is fast (SIGHUP, not a burned 3s timeout)', async () => {
  await server.createSession('t-kill');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const start = Date.now();
  await server.killSession('t-kill', true);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1500, `graceful kill took ${elapsed}ms; must not burn the full 3s`);
});

test('client request timeout always exceeds the server-side wait', () => {
  const compute = RobustSessionClient.prototype['computeRequestTimeout'];
  const self = { requestTimeout: 10000 };
  // exec with no explicit timeout must cover the server's 30s default —
  // this used to be 10s, killing any 10-30s command client-side.
  assert.strictEqual(compute.call(self, 'session.exec', {}), 35000);
  assert.strictEqual(compute.call(self, 'session.exec', { timeout: 60000 }), 65000);
  assert.strictEqual(compute.call(self, 'session.exec', { timeout: -1 }), 5000);
  assert.ok(compute.call(self, 'service.start') > 15000, 'must exceed the 15s pattern poll');
  assert.strictEqual(compute.call(self, 'session.list'), 10000);
});
