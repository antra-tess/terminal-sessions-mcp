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
  // keys go with the text; Enter (explicit appendNewline) still comes last
  assert.deepEqual(planInputWrites('hello', true, ['Tab'], 100), [
    { data: 'hello\t', delayMs: 0 },
    { data: '\r', delayMs: 100 }
  ]);
  // a delay of 0 still splits the writes
  assert.deepEqual(planInputWrites('hi', undefined, undefined, 0), [
    { data: 'hi', delayMs: 0 },
    { data: '\r', delayMs: 0 }
  ]);
});

test('planInputWrites: the delay is ignored when no Enter would be appended or there is no text', () => {
  assert.deepEqual(planInputWrites('partial', false, undefined, 150), [{ data: 'partial', delayMs: 0 }]);
  assert.deepEqual(planInputWrites('x', undefined, ['Tab'], 150), [{ data: 'x\t', delayMs: 0 }]);
  // nothing to separate: just Enter
  assert.deepEqual(planInputWrites('', undefined, undefined, 150), [{ data: '\r', delayMs: 0 }]);
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

test('server.sendInput: rejects an out-of-range delay before writing anything', async () => {
  const { server, writes, cleanup } = fakeServer();
  try {
    await assert.rejects(server.sendInput('fake', 'x', undefined, undefined, 6000), /between 0 and 5000/);
    assert.deepEqual(writes, []);
  } finally {
    cleanup();
  }
});

test('assertEnterDelayHonoured: old servers that ignore enterDelayMs are reported', () => {
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true }, undefined));
  assert.doesNotThrow(() => assertEnterDelayHonoured({ success: true, enterDelayMs: 150 }, 150));
  assert.throws(() => assertEnterDelayHonoured({ success: true }, 150), /ignored enterDelayMs/);
  assert.throws(() => assertEnterDelayHonoured(undefined, 0), /ignored enterDelayMs/);
});
