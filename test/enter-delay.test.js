// Tests for sendInput's optional enterDelayMs: the trailing Enter goes out as
// a separate, later write. Runs against the compiled output (`npm test`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitInputData,
  planInputWrites,
  performInputWrites,
  validateEnterDelayMs,
  assertEnterDelayHonoured,
  enterDelayApplies,
  MAX_ENTER_DELAY_MS
} = require('../dist/src/server/keys');

test('splitInputData: body and enter are kept apart', () => {
  assert.deepEqual(splitInputData('hello'), { body: 'hello', enter: '\r' });
  assert.deepEqual(splitInputData('hello', false), { body: 'hello', enter: '' });
  assert.deepEqual(splitInputData('hello', undefined, ['Tab']), { body: 'hello\t', enter: '' });
  assert.deepEqual(splitInputData('hello', true, ['Tab']), { body: 'hello\t', enter: '\r' });
});

test('planInputWrites: without enterDelayMs it is one write (unchanged behaviour)', () => {
  assert.deepEqual(planInputWrites('ls'), [{ data: 'ls\r', delayMs: 0 }]);
  assert.deepEqual(planInputWrites('ls', false), [{ data: 'ls', delayMs: 0 }]);
  assert.deepEqual(planInputWrites('', undefined, ['Enter']), [{ data: '\r', delayMs: 0 }]);
});

test('planInputWrites: with enterDelayMs the Enter is a separate, later write', () => {
  assert.deepEqual(planInputWrites('hello world', undefined, undefined, 150), [
    { data: 'hello world', delayMs: 0 },
    { data: '\r', delayMs: 150 }
  ]);
  // keys wait too: an Enter given as a key is delayed like an appended one
  assert.deepEqual(planInputWrites('hello', undefined, ['Enter'], 200), [
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 200 }
  ]);
  assert.deepEqual(planInputWrites('hello', true, ['Tab'], 100), [
    { data: 'hello', delayMs: 0 },
    { data: '\t\r', delayMs: 100 }
  ]);
  // a delay of 0 still splits the writes
  assert.deepEqual(planInputWrites('hi', undefined, undefined, 0), [
    { data: 'hi', delayMs: 0 },
    { data: '\r', delayMs: 0 }
  ]);
});

test('planInputWrites: the delay is ignored when nothing follows the text or there is no text', () => {
  assert.deepEqual(planInputWrites('partial', false, undefined, 150), [{ data: 'partial', delayMs: 0 }]);
  // nothing to separate: just Enter / just keys
  assert.deepEqual(planInputWrites('', undefined, undefined, 150), [{ data: '\r', delayMs: 0 }]);
  assert.deepEqual(planInputWrites('', undefined, ['Enter'], 150), [{ data: '\r', delayMs: 0 }]);
});

test('enterDelayApplies: only when a delay is set and text is followed by keys/Enter', () => {
  assert.equal(enterDelayApplies('x'), false);
  assert.equal(enterDelayApplies('x', undefined, undefined, 150), true);
  assert.equal(enterDelayApplies('x', false, undefined, 150), false);
  assert.equal(enterDelayApplies('x', undefined, ['Enter'], 150), true);
  assert.equal(enterDelayApplies('', undefined, ['Enter'], 150), false);
});

test('performInputWrites: writes in order, waits before the Enter, \\r last', async () => {
  const events = [];
  const sleep = async ms => { events.push(`sleep:${ms}`); };
  await performInputWrites(
    planInputWrites('hello', undefined, undefined, 150),
    data => events.push(`write:${JSON.stringify(data)}`),
    { sleep }
  );
  assert.deepEqual(events, ['write:"hello"', 'sleep:150', 'write:"\\r"']);
});

test('performInputWrites: real timers — text immediately, Enter after the delay', async () => {
  const writes = [];
  const start = Date.now();
  const done = performInputWrites(
    planInputWrites('hello', undefined, undefined, 60),
    data => writes.push({ data, at: Date.now() - start })
  );
  // the text is written synchronously, before the promise settles
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data, 'hello');
  await done;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data, '\r');
  assert.ok(writes[1].at >= 50, `Enter came after ${writes[1].at}ms, expected >= ~60ms`);
});

test('performInputWrites: no delay means a single synchronous write', async () => {
  const writes = [];
  let slept = false;
  const p = performInputWrites(planInputWrites('ls'), d => writes.push(d), { sleep: async () => { slept = true; } });
  assert.deepEqual(writes, ['ls\r']);
  await p;
  assert.equal(slept, false);
});

test('performInputWrites: Enter is not written to a session that died while waiting', async () => {
  const writes = [];
  let alive = true;
  await assert.rejects(
    performInputWrites(
      planInputWrites('hello', undefined, undefined, 10),
      d => writes.push(d),
      { isAlive: () => alive, sleep: async () => { alive = false; } }
    ),
    /exited before the delayed Enter/
  );
  assert.deepEqual(writes, ['hello']);
});

test('validateEnterDelayMs: accepts 0..5000 and absent, rejects the rest', () => {
  assert.equal(validateEnterDelayMs(undefined), undefined);
  assert.equal(validateEnterDelayMs(null), undefined);
  assert.equal(validateEnterDelayMs(0), 0);
  assert.equal(validateEnterDelayMs(150), 150);
  assert.equal(validateEnterDelayMs(MAX_ENTER_DELAY_MS), 5000);
  for (const bad of [-1, 5001, NaN, Infinity, '150', true, {}]) {
    assert.throws(() => validateEnterDelayMs(bad), /enterDelayMs must be a number between 0 and 5000/);
  }
});

// --- server level: inputs to one session never interleave -------------------
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3');

function fakeServer() {
  const server = new PersistentSessionServer();
  const writes = [];
  const session = {
    id: 'fake',
    isAlive: true,
    lastActivity: new Date(),
    shell: { write: d => writes.push(d), kill: () => {} }
  };
  server.sessions.set('fake', session); // private in TS, plain property at runtime
  const cleanup = () => server.sessions.delete('fake');
  return { server, session, writes, cleanup };
}

test('server.sendInput: a plain call queues behind a pending delayed Enter', async () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    const first = server.sendInput('fake', 'first', undefined, undefined, 40);
    assert.deepEqual(writes, ['first']); // text written synchronously
    const second = server.sendInput('fake', 'second');
    assert.deepEqual(writes, ['first']); // second must wait for first's Enter
    await Promise.all([first, second]);
    assert.deepEqual(writes, ['first', '\r', 'second\r']);
  } finally {
    cleanup();
  }
});

test('server.sendInput: without a delay the write is synchronous and nothing is left queued', async () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    const p = server.sendInput('fake', 'ls');
    assert.deepEqual(writes, ['ls\r']);
    await p;
    assert.equal(server.inputChains.size, 0);
  } finally {
    cleanup();
  }
});

test('server.sendInput: a queued call fails if the session died meanwhile, later calls still run', async () => {
  const { server, session, writes, cleanup } = fakeServer();
  try {
    const first = server.sendInput('fake', 'first', undefined, undefined, 20);
    const second = server.sendInput('fake', 'second');
    session.isAlive = false;
    await assert.rejects(first, /exited before the delayed Enter/);
    await assert.rejects(second, /not available/);
    assert.deepEqual(writes, ['first']);
    assert.equal(server.inputChains.size, 0);
  } finally {
    cleanup();
  }
});

test('server.sendInput: rejects an out-of-range delay before writing anything', () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    assert.throws(() => server.sendInput('fake', 'x', undefined, undefined, 6000), /between 0 and 5000/);
    assert.deepEqual(writes, []);
  } finally {
    cleanup();
  }
});

test('assertEnterDelayHonoured: old servers that ignore enterDelayMs are reported, saying the input went in', () => {
  const call = (input, appendNewline, keys, enterDelayMs) => ({ input, appendNewline, keys, enterDelayMs });
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true }, call('echo A')));
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true, enterDelayMs: 150 }, call('echo A', undefined, undefined, 150)));
  assert.throws(() => assertEnterDelayHonoured({ success: true }, call('echo A', undefined, undefined, 150)),
    /ignored enterDelayMs .* so it has been sent\. Restart or upgrade the session server to use the delay\./);
  assert.throws(() => assertEnterDelayHonoured(undefined, call('echo A', undefined, ['Enter'], 0)), /has been sent/);
  // no Enter would be appended: the delay changes nothing, so nothing to complain about
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true }, call('partial', false, undefined, 300)));
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true }, call('', undefined, ['Enter'], 300)));
});

// --- validation is synchronous, as on main ----------------------------------
test('server.sendInput: unknown session / bad delay / unknown key throw synchronously (no rejected promise)', () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    assert.throws(() => server.sendInput('nope', 'x'), /Session nope not available/);
    assert.throws(() => server.sendInput('fake', 'x', undefined, undefined, 6000), /between 0 and 5000/);
    assert.throws(() => server.sendInput('fake', 'x', undefined, ['Bogus']), /Unknown key 'Bogus'/);
    assert.deepEqual(writes, []);
    assert.equal(server.inputChains.size, 0);
  } finally {
    cleanup();
  }
});

// --- execCommand waits for a pending Enter ----------------------------------
test('server.execCommand: a command issued during a pending delayed Enter is typed after it', async () => {
  const { server, session, writes, cleanup } = fakeServer();
  Object.assign(session, { commandQueue: [], isProcessingCommand: false, logs: [], outputBuffer: '', tempFiles: [] });
  try {
    const input = server.sendInput('fake', 'echo A', undefined, undefined, 60);
    assert.deepEqual(writes, ['echo A']);
    const cmd = server.execCommand('fake', 'echo B', 150); // resolves via its own timeout (-1), fine for this test
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(writes, ['echo A']); // not typed over the pending line
    await input;
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(writes.slice(0, 3), ['echo A', '\r', 'echo B\n']);
    const result = await cmd;
    assert.equal(result.exitCode, -1);
  } finally {
    cleanup();
  }
});

test('server.sendSignal: Ctrl+C stays immediate during a pending Enter', async () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    const input = server.sendInput('fake', 'sleep 5', undefined, undefined, 40);
    server.sendSignal('fake', 'SIGINT');
    assert.deepEqual(writes, ['sleep 5', '\x03']);
    await input;
    assert.deepEqual(writes, ['sleep 5', '\x03', '\r']);
  } finally {
    cleanup();
  }
});
