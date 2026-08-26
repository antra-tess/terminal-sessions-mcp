/**
 * Regression tests for command-completion detection (the "doesn't notice the
 * command ended / waits for the full timeout" family of bugs).
 *
 * These run against the compiled build (npm test builds first) and use real
 * PTYs, so they are integration tests; each asserts on wall-clock behavior
 * with generous margins to stay robust on slow CI machines.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');

let server;

before(() => {
  server = new PersistentSessionServer();
});

after(async () => {
  await server.killAll(false);
});

test('fast command resolves promptly with clean output', async () => {
  await server.createSession('t-fast');
  const start = Date.now();
  const result = await server.execCommand('t-fast', 'echo hello-world', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(Date.now() - start < 3000, 'should resolve well before the timeout');
  assert.match(result.output, /hello-world/);
  assert.ok(!result.output.includes('<<<EXIT'), 'markers must be stripped');
  assert.ok(!result.output.includes("tsm-cmd"), 'wrapper echo must be stripped');
});

test('exit codes propagate through the marker', async () => {
  const result = await server.execCommand('t-fast', 'sh -c "exit 42"', 10000);
  assert.strictEqual(result.exitCode, 42);
});

test('env and cwd persist across the temp-file exec path', async () => {
  await server.execCommand('t-fast', 'export TSMCP_TEST=persisted; cd /', 10000);
  const env = await server.execCommand('t-fast', 'echo "$TSMCP_TEST"', 10000);
  assert.match(env.output, /persisted/);
  const pwd = await server.execCommand('t-fast', 'pwd', 10000);
  assert.match(pwd.output, /^\/\s*$/m);
});

test('shell death resolves the in-flight command instead of hanging until timeout', async () => {
  await server.createSession('t-exit');
  const start = Date.now();
  const result = await server.execCommand('t-exit', 'exit', 8000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `resolved in ${elapsed}ms; must not wait out the 8s timeout`);
  assert.ok(!result.output.includes('<<<EXIT'));
});

test('shell death fails queued commands instead of hanging', async () => {
  await server.createSession('t-exit-q');
  const [first, second] = await Promise.all([
    server.execCommand('t-exit-q', 'exit', 8000),
    server.execCommand('t-exit-q', 'echo never-runs', 8000)
  ]);
  assert.strictEqual(second.exitCode, -1);
  assert.match(second.output, /session exited/);
});

test('a stdin-reading command times out without the marker being fed to it', async () => {
  await server.createSession('t-read');
  const start = Date.now();
  const result = await server.execCommand('t-read', 'read x', 1500);
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, -1, 'stdin reader cannot complete; must time out');
  assert.ok(elapsed >= 1400 && elapsed < 4000, `timed out at ${elapsed}ms`);
  // Nothing was typed into `read` behind the caller's back: it is still
  // waiting, and the session can be unblocked explicitly.
  server.sendInput('t-read', '', true); // plain Enter -> read returns
  const follow = await server.execCommand('t-read', 'echo unblocked', 8000);
  assert.strictEqual(follow.exitCode, 0);
  assert.match(follow.output, /unblocked/);
});

test('marker-shaped text in command/output cannot cause premature completion', async () => {
  await server.createSession('t-fake');
  const start = Date.now();
  const result = await server.execCommand(
    't-fake',
    'printf "see <<<EXIT:7>>> and <<<EXIT:abc:0>>> here\\n"; sleep 0.4; echo done',
    10000
  );
  const elapsed = Date.now() - start;
  assert.strictEqual(result.exitCode, 0);
  assert.ok(elapsed >= 380, `resolved at ${elapsed}ms; must wait for the real completion`);
  assert.match(result.output, /done/);
});

test('a timed-out command does not corrupt the next command (stale-marker cascade)', async () => {
  await server.createSession('t-cascade');
  const timedOut = await server.execCommand('t-cascade', 'sleep 1', 300);
  assert.strictEqual(timedOut.exitCode, -1);
  // sleep is still running; the next command queues behind it in the tty and
  // must resolve with ITS OWN result, not sleep's stale marker.
  const next = await server.execCommand('t-cascade', 'echo after-cascade', 8000);
  assert.strictEqual(next.exitCode, 0);
  assert.match(next.output, /after-cascade/);
  assert.ok(!next.output.includes('<<<EXIT'), 'stale markers must be stripped');
});

test('single-line commands longer than the tty canonical buffer survive', async () => {
  // macOS line discipline truncates canonical-mode input at 1024 bytes; the
  // temp-file path sidesteps the line editor entirely.
  await server.createSession('t-long');
  const payload = 'x'.repeat(3000);
  const result = await server.execCommand('t-long', `echo ${payload} | wc -c`, 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /3001/); // payload + newline
});

test('session logs stay free of exec plumbing lines', async () => {
  await server.createSession('t-logs');
  await server.execCommand('t-logs', 'echo log-hygiene', 10000);
  const logs = server.getOutput('t-logs');
  const joined = logs.join('\n');
  assert.match(joined, /\$ echo log-hygiene/, 'issued command should be logged');
  assert.match(joined, /^log-hygiene/m, 'command output should be logged');
  assert.ok(!joined.includes('tsm-cmd'), 'wrapper echoes must not be logged');
  assert.ok(!/<<<EXIT:[0-9a-z]+:\d+>>>/.test(joined), 'markers must not be logged');
});

test('multi-line commands (heredocs) still work through the temp-file path', async () => {
  await server.createSession('t-ml');
  const result = await server.execCommand('t-ml', 'cat <<EOF\nline-one\nline-two\nEOF', 10000);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.output, /line-one/);
  assert.match(result.output, /line-two/);
});
