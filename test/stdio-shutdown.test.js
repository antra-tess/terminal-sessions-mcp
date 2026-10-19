// The stdio MCP server must end on SIGINT, on SIGTERM and when its stdin
// closes (MCP's stdio shutdown), whatever state it is in: before any tool
// call, when no session server connection exists yet, and after one, when
// the open WebSocket would otherwise keep the process alive (#17). Spawns the
// compiled server against a fake session server on a loopback port. Runs
// against the compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const EXIT_WITHIN_MS = 2000;
const ANSWER_WITHIN_MS = 10000;

// A session server that answers session.list with no sessions. The stdio
// server's first tool call opens a WebSocket to it; that socket is what keeps
// the process alive once stdin is gone.
async function fakeSessionServer() {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const { id, method } = JSON.parse(data.toString());
      const result = method === 'session.list' ? [] : null;
      ws.send(JSON.stringify({ id, result }));
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { url, close: () => new Promise((resolve) => wss.close(() => resolve())) };
}

// Spawns the stdio server with a JSON-RPC line client over its pipes. Each
// test kills the child in its `finally`, before closing the fake session
// server, whose close waits for the child's WebSocket.
function startStdioServer(url) {
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, SESSION_SERVER_URL: url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const pending = waiting.get(msg.id);
      if (pending) { waiting.delete(msg.id); pending.resolve(msg); }
    }
  });
  // Kept for a failure's message; the first tool call logs its connection details here.
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // A request fails its test, rather than leaving it waiting forever, when
  // no answer comes within ANSWER_WITHIN_MS, or once the server has ended and
  // its output has all been read ('close').
  let ended = null;
  child.once('close', (code, signal) => {
    ended = new Error(`server ended (code ${code}, signal ${signal}) before answering; its stderr: ${stderr.trim()}`);
    for (const pending of waiting.values()) pending.reject(ended);
    waiting.clear();
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(ended); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_WITHIN_MS} ms`));
    }, ANSWER_WITHIN_MS);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, request, exited };
}

// Resolves to the exit (code, signal) when the child ends within the window,
// or to null when it is still running, in which case it is killed.
async function exitWithin(server, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([server.exited, timeout]);
  clearTimeout(timer);
  if (result === null) server.child.kill('SIGKILL');
  return result;
}

async function initialize(server) {
  const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'terminal-sessions-mcp');
}

// On Windows, child.kill() with a named signal terminates the process
// outright rather than delivering a signal the server could ignore, so the
// signal cases prove nothing there.
const signalsReachNode = process.platform !== 'win32';

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} before any tool call ends the server`, { skip: signalsReachNode ? false : 'Windows has no signals to ignore: child.kill() terminates the process directly' }, async () => {
    const fake = await fakeSessionServer();
    const server = startStdioServer(fake.url);
    try {
      await initialize(server);
      const list = await server.request('tools/list');
      assert.ok(list.result.tools.length > 0);
      server.child.kill(signal);
      const exit = await exitWithin(server, EXIT_WITHIN_MS);
      assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after ${signal}`);
    } finally {
      server.child.kill('SIGKILL');
      await fake.close();
    }
  });
}

test('a closed stdin ends the server after a tool call has opened the session server connection', async () => {
  const fake = await fakeSessionServer();
  const server = startStdioServer(fake.url);
  try {
    await initialize(server);
    const call = await server.request('tools/call', { name: 'listSessions', arguments: {} });
    assert.equal(call.error, undefined, 'listSessions against the fake session server succeeds');
    server.child.stdin.end();
    const exit = await exitWithin(server, EXIT_WITHIN_MS);
    assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after stdin closed`);
    assert.equal(exit.code, 0);
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});

test('a closed stdin ends the server before any tool call', async () => {
  const fake = await fakeSessionServer();
  const server = startStdioServer(fake.url);
  try {
    await initialize(server);
    server.child.stdin.end();
    const exit = await exitWithin(server, EXIT_WITHIN_MS);
    assert.ok(exit, `server still running ${EXIT_WITHIN_MS}ms after stdin closed`);
    assert.equal(exit.code, 0);
  } finally {
    server.child.kill('SIGKILL');
    await fake.close();
  }
});
