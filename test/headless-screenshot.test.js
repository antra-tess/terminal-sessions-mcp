// takeScreenshot drives a browser to the web GUI at localhost:3200, so it works only where a GUI answers there. The
// stdio server leaves it out of tools/list when the session server says none does (server.info), and the session
// server refuses a screenshot it can't take in plain words. Runs against the compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');
const { SessionAPI } = require('../dist/src/server/websocket-api.js');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const ALL_TOOLS = ['launch', 'runCommand', 'listSessions', 'tailLogs', 'sendInput', 'sendSignal', 'killSession', 'killAll', 'searchLogs', 'takeScreenshot'];

// A session server that answers server.info as `info` says, counting the asks, and every other method with null.
async function fakeSessionServer(info) {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const asks = { serverInfo: 0 };
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const { id, method } = JSON.parse(data.toString());
      if (method !== 'server.info') return ws.send(JSON.stringify({ id, result: null }));
      asks.serverInfo++;
      ws.send(JSON.stringify(info === 'unknown' ? { id, error: 'Unknown method: server.info' } : { id, result: info }));
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { url, asks, close: () => new Promise((resolve) => wss.close(() => resolve())) };
}

// A loopback port nothing listens on: one the kernel just handed out and that has been closed again.
async function closedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startStdioServer(url) {
  const child = spawn(process.execPath, [serverJs], { env: { ...process.env, SESSION_SERVER_URL: url } });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request };
}

async function listedTools(server) {
  const list = await server.request('tools/list');
  return list.result.tools.map((tool) => tool.name);
}

async function withStdioServer(url, body) {
  const server = startStdioServer(url);
  try {
    await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    await body(server);
  } finally {
    server.child.kill('SIGKILL');
  }
}

test('tools/list leaves out takeScreenshot when the session server says no GUI answers', async () => {
  const fake = await fakeSessionServer({ gui: false });
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(await listedTools(server), ALL_TOOLS.filter((name) => name !== 'takeScreenshot'));
    });
  } finally {
    await fake.close();
  }
});

test('tools/list offers takeScreenshot when the session server says its GUI answers', async () => {
  const fake = await fakeSessionServer({ gui: true });
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(await listedTools(server), ALL_TOOLS);
    });
  } finally {
    await fake.close();
  }
});

test('tools/list offers all ten when the session server does not know server.info', async () => {
  const fake = await fakeSessionServer('unknown');
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(await listedTools(server), ALL_TOOLS);
    });
  } finally {
    await fake.close();
  }
});

test('with no session server, each tools/list offers all ten within a second, the second while the client reconnects', async () => {
  const url = `ws://127.0.0.1:${await closedPort()}`;
  await withStdioServer(url, async (server) => {
    for (const which of ['first', 'second']) {
      const started = Date.now();
      assert.deepEqual(await listedTools(server), ALL_TOOLS);
      const took = Date.now() - started;
      assert.ok(took < 1000, `the ${which} list took ${took} ms; the client's first reconnect waits 1000 ms`);
    }
  });
});

test('lists made together share one server.info ask', async () => {
  const fake = await fakeSessionServer({ gui: false });
  try {
    await withStdioServer(fake.url, async (server) => {
      const lists = await Promise.all(Array.from({ length: 5 }, () => listedTools(server)));
      for (const names of lists) assert.equal(names.includes('takeScreenshot'), false);
      assert.equal(fake.asks.serverInfo, 1);
    });
  } finally {
    await fake.close();
  }
});

test('a GUI answers when something accepts at its port on 127.0.0.1 or ::1, and not when nothing does', async () => {
  const server = Object.create(PersistentSessionServer.prototype);
  assert.equal(await server.guiAnswers({ guiPort: await closedPort() }), false);
  for (const host of ['127.0.0.1', '::1']) {
    const gui = net.createServer();
    try {
      gui.listen(0, host);
      await once(gui, 'listening');
    } catch (error) {
      if (host === '::1') continue; // a host with no IPv6 loopback has nothing to show here
      throw error;
    }
    try {
      assert.equal(await server.guiAnswers({ guiPort: gui.address().port }), true, `a listener on ${host}`);
    } finally {
      await new Promise((resolve) => gui.close(resolve));
    }
  }
});

test('server.info reports over the WebSocket API whether a GUI answers at the port asked about', async () => {
  const api = new SessionAPI(0, '127.0.0.1');
  await once(api.httpServer, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${api.httpServer.address().port}`);
  try {
    await once(ws, 'open');
    const ask = async (params) => {
      ws.send(JSON.stringify({ id: 'info', method: 'server.info', params }));
      const [data] = await once(ws, 'message');
      return JSON.parse(data.toString());
    };
    assert.deepEqual(await ask({ guiPort: await closedPort() }), { id: 'info', result: { gui: false } });
    const gui = net.createServer();
    gui.listen(0, '127.0.0.1');
    await once(gui, 'listening');
    try {
      assert.deepEqual(await ask({ guiPort: gui.address().port }), { id: 'info', result: { gui: true } });
    } finally {
      await new Promise((resolve) => gui.close(resolve));
    }
  } finally {
    ws.close();
    await api.stop();
  }
});

test('a screenshot with no GUI answering is refused in plain words, naming neither the URL nor the token', async () => {
  const server = new PersistentSessionServer();
  server.guiAuthToken = 'token-that-must-not-appear';
  try {
    await server.createSession('t-shot');
    const guiPort = await closedPort();
    const result = await server.takeScreenshot('t-shot', { guiPort });
    assert.equal(result.success, false);
    assert.match(result.error, new RegExp(`^No GUI answers at localhost:${guiPort}`));
    assert.equal(result.error.includes('token-that-must-not-appear'), false);
    assert.equal(result.error.includes('http://'), false);
  } finally {
    await server.killAll(false);
  }
});
