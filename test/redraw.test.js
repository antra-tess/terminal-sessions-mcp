// Tests for the Redraw action: PTY size nudge + restore (SIGWINCH for the
// foreground program) and its serialization with real resizes.
// Runs against the compiled output: `npm test` (builds first, then node --test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRedrawNudge, performRedraw, REDRAW_NUDGE_MS } = require('../dist/src/server/redraw');
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3');

function fakePty(cols = 120, rows = 30) {
  const calls = [];
  const pty = {
    cols, rows,
    resize(c, r) { calls.push([c, r]); this.cols = c; this.rows = r; }
  };
  return { pty, calls };
}

test('planRedrawNudge: one row less, else one column less, never 0', () => {
  assert.deepEqual(planRedrawNudge({ cols: 120, rows: 30 }), { cols: 120, rows: 29 });
  assert.deepEqual(planRedrawNudge({ cols: 80, rows: 1 }), { cols: 79, rows: 1 });
  assert.deepEqual(planRedrawNudge({ cols: 1, rows: 1 }), { cols: 1, rows: 2 });
});

test('performRedraw: nudge, wait, restore — final size equals the original', async () => {
  const { pty, calls } = fakePty(130, 38);
  const sleeps = [];
  const result = await performRedraw(pty, { sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(calls, [[130, 37], [130, 38]]);
  assert.deepEqual(sleeps, [REDRAW_NUDGE_MS]);
  assert.deepEqual(result, { cols: 130, rows: 38 });
  assert.equal(pty.cols, 130); assert.equal(pty.rows, 38);
});

test('performRedraw: the size is restored even when the wait fails', async () => {
  const { pty, calls } = fakePty(100, 20);
  await assert.rejects(performRedraw(pty, { sleep: async () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(calls, [[100, 19], [100, 20]]);
});

test('performRedraw: real timer keeps the nudge short', async () => {
  const { pty, calls } = fakePty();
  const t0 = Date.now();
  await performRedraw(pty, { nudgeMs: 30 });
  assert.ok(Date.now() - t0 >= 25);
  assert.deepEqual(calls, [[120, 29], [120, 30]]);
});

// --- server level: redraw and resize never interleave ------------------------
function fakeServer() {
  const server = new PersistentSessionServer();
  const { pty, calls } = fakePty(120, 30);
  const session = { id: 'fake', isAlive: true, lastActivity: new Date(), shell: Object.assign(pty, { write() {}, kill() {} }) };
  server.sessions.set('fake', session); // private in TS, plain property at runtime
  return { server, pty, calls, session, cleanup: () => server.sessions.delete('fake') };
}

test('server: a resize during a redraw nudge is applied after the restore and wins', async () => {
  const { server, pty, calls, cleanup } = fakeServer();
  try {
    const redraw = server.redrawSession('fake');
    assert.deepEqual(calls, [[120, 29]]); // nudged synchronously
    const resize = server.resizeSession('fake', 165, 36); // arrives mid-nudge
    assert.deepEqual(calls, [[120, 29]]); // ...and waits
    assert.deepEqual(await redraw, { cols: 120, rows: 30 });
    await resize;
    assert.deepEqual(calls, [[120, 29], [120, 30], [165, 36]]);
    assert.equal(pty.cols, 165); assert.equal(pty.rows, 36);
    assert.equal(server.resizeChains.size, 0);
  } finally {
    cleanup();
  }
});

test('server: a redraw after a resize uses the new size; a plain resize is still synchronous', async () => {
  const { server, pty, calls, cleanup } = fakeServer();
  try {
    const p = server.resizeSession('fake', 90, 24);
    assert.deepEqual(calls, [[90, 24]]);
    await p;
    assert.deepEqual(await server.redrawSession('fake'), { cols: 90, rows: 24 });
    assert.deepEqual(calls, [[90, 24], [90, 23], [90, 24]]);
    assert.equal(pty.rows, 24);
  } finally {
    cleanup();
  }
});

test('server: two quick redraws run one after the other, never nested', async () => {
  const { server, calls, cleanup } = fakeServer();
  try {
    await Promise.all([server.redrawSession('fake'), server.redrawSession('fake')]);
    assert.deepEqual(calls, [[120, 29], [120, 30], [120, 29], [120, 30]]);
  } finally {
    cleanup();
  }
});

test('server: a failing PTY resize does not leave the chain stuck', async () => {
  const { server, pty, cleanup } = fakeServer();
  try {
    pty.resize = () => { throw new Error('EBADF'); };
    await assert.rejects(server.redrawSession('fake'), /Failed to redraw session: EBADF/);
    await assert.rejects(server.resizeSession('fake', 10, 10), /Failed to resize session: EBADF/);
    assert.equal(server.resizeChains.size, 0);
    assert.throws(() => server.redrawSession('nope'), /not found/);
  } finally {
    cleanup();
  }
});
