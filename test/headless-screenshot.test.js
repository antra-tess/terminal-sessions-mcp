// takeScreenshot drives a browser to the web GUI at localhost:3200, so it works only where a GUI answers there. The
// stdio server leaves it out of tools/list until the session server says a GUI has answered (server.info), then
// offers it for good, and the session server refuses a screenshot it can't take in plain words. Runs against the
// compiled output: `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3.js');
const { SessionAPI } = require('../dist/src/server/websocket-api.js');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const ANSWER_WITHIN_MS = 10000;
const ALL_TOOLS = ['launch', 'runCommand', 'listSessions', 'tailLogs', 'sendInput', 'sendSignal', 'killSession', 'killAll', 'searchLogs', 'takeScreenshot'];
const WITHOUT_SCREENSHOT = ALL_TOOLS.filter((name) => name !== 'takeScreenshot');
const LIST_CHANGED = 'notifications/tools/list_changed';

// A session server that answers server.info as `info` says, counting the asks, and every other method with null.
// answer() changes what it says from then on, and drop() ends every connection it holds.
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
  return {
    url,
    asks,
    answer: (next) => { info = next; },
    drop: () => { for (const ws of wss.clients) ws.terminate(); },
    nextConnection: () => once(wss, 'connection'),
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
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

// Spawns the stdio server with a JSON-RPC line client over its pipes. A request fails its test, rather than leaving it
// waiting forever, when no answer comes within ANSWER_WITHIN_MS or the server ends first. Notifications are kept in
// order of arrival, and nextNotification(method) waits for the next one of that method.
function startStdioServer(url) {
  const child = spawn(process.execPath, [serverJs], { env: { ...process.env, SESSION_SERVER_URL: url } });
  let buffer = '';
  let stderr = '';
  const waiting = new Map();
  const notifications = [];
  const notificationWaiters = [];
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (msg.id === undefined) {
        notifications.push(msg.method);
        for (const waiter of notificationWaiters.splice(0)) waiter(msg.method);
        continue;
      }
      waiting.get(msg.id)?.resolve(msg);
      waiting.delete(msg.id);
    }
  });
  let ended = null;
  child.once('close', (code, signal) => {
    ended = new Error(`server ended (code ${code}, signal ${signal}) before answering; its stderr: ${stderr.trim()}`);
    for (const pending of waiting.values()) pending.reject(ended);
    waiting.clear();
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    if (ended) return reject(ended);
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_WITHIN_MS} ms`));
    }, ANSWER_WITHIN_MS);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const nextNotification = (method) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${method} within ${ANSWER_WITHIN_MS} ms`)), ANSWER_WITHIN_MS);
    const waiter = (arrived) => {
      if (arrived !== method) return notificationWaiters.push(waiter);
      clearTimeout(timer);
      resolve();
    };
    notificationWaiters.push(waiter);
  });
  return { child, request, notifications, nextNotification };
}

async function listedTools(server) {
  const list = await server.request('tools/list');
  return list.result.tools.map((tool) => tool.name);
}

async function withStdioServer(url, body) {
  const server = startStdioServer(url);
  try {
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    server.capabilities = init.result.capabilities;
    await body(server);
  } finally {
    server.child.kill('SIGKILL');
  }
}

test('tools/list leaves out takeScreenshot while the session server says no GUI has answered', async () => {
  const fake = await fakeSessionServer({ guiSeen: false });
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(await listedTools(server), WITHOUT_SCREENSHOT);
    });
  } finally {
    await fake.close();
  }
});

test('tools/list offers takeScreenshot when the session server says a GUI has answered, with no list_changed', async () => {
  const fake = await fakeSessionServer({ guiSeen: true });
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(server.capabilities.tools, { listChanged: true });
      assert.deepEqual(await listedTools(server), ALL_TOOLS);
      assert.deepEqual(server.notifications, []);
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

test('with no session server, each tools/list leaves out takeScreenshot within a second, the second while the client reconnects', async () => {
  const url = `ws://127.0.0.1:${await closedPort()}`;
  await withStdioServer(url, async (server) => {
    for (const which of ['first', 'second']) {
      const started = performance.now();
      assert.deepEqual(await listedTools(server), WITHOUT_SCREENSHOT);
      const took = performance.now() - started;
      assert.ok(took < 1000, `the ${which} list took ${took} ms; the client's first reconnect waits 1000 ms`);
    }
  });
});

test('lists made together share one server.info ask', async () => {
  const fake = await fakeSessionServer({ guiSeen: false });
  try {
    await withStdioServer(fake.url, async (server) => {
      const lists = await Promise.all(Array.from({ length: 5 }, () => listedTools(server)));
      for (const names of lists) assert.deepEqual(names, WITHOUT_SCREENSHOT);
      assert.equal(fake.asks.serverInfo, 1);
    });
  } finally {
    await fake.close();
  }
});

test('once a GUI has answered, takeScreenshot is added with one list_changed and stays, whatever the session server says later', async () => {
  const fake = await fakeSessionServer({ guiSeen: false });
  try {
    await withStdioServer(fake.url, async (server) => {
      assert.deepEqual(await listedTools(server), WITHOUT_SCREENSHOT);

      // The session server has since seen a GUI; the stdio server learns it when its client reconnects.
      fake.answer({ guiSeen: true });
      const changed = server.nextNotification(LIST_CHANGED);
      let reconnected = fake.nextConnection();
      fake.drop();
      await reconnected;
      await changed;
      assert.deepEqual(await listedTools(server), ALL_TOOLS);

      // A session server that restarts with no GUI doesn't take it away again.
      fake.answer({ guiSeen: false });
      reconnected = fake.nextConnection();
      fake.drop();
      await reconnected;
      assert.deepEqual(await listedTools(server), ALL_TOOLS);
      assert.deepEqual(server.notifications, [LIST_CHANGED]);
    });
  } finally {
    await fake.close();
  }
});

test('a GUI answers when something accepts at its port on 127.0.0.1 or ::1, and not when nothing does', async () => {
  const server = new PersistentSessionServer();
  assert.equal(await server.guiAnswers({ guiPort: await closedPort() }), false);
  for (const host of ['127.0.0.1', '::1']) {
    const gui = net.createServer();
    try {
      gui.listen(0, host);
      await once(gui, 'listening');
    } catch (error) {
      // A host with no IPv6 loopback has nothing to show here; any other failure to listen is the test's own.
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) continue;
      throw error;
    }
    try {
      assert.equal(await server.guiAnswers({ guiPort: gui.address().port }), true, `a listener on ${host}`);
    } finally {
      await new Promise((resolve) => gui.close(resolve));
    }
  }
});

test('server.info says over the WebSocket API whether a GUI has answered at the port asked about since the server started', async () => {
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
    assert.deepEqual(await ask({ guiPort: await closedPort() }), { id: 'info', result: { guiSeen: false } });
    const gui = net.createServer();
    gui.listen(0, '127.0.0.1');
    await once(gui, 'listening');
    const guiPort = gui.address().port;
    try {
      assert.deepEqual(await ask({ guiPort }), { id: 'info', result: { guiSeen: true } });
    } finally {
      await new Promise((resolve) => gui.close(resolve));
    }
    assert.deepEqual(await ask({ guiPort }), { id: 'info', result: { guiSeen: true } }, 'still seen once the GUI has gone');
  } finally {
    ws.close();
    await api.stop();
  }
});

test('a screenshot with no GUI answering is refused in plain words, naming neither the URL, the token nor a server option', async () => {
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
    assert.equal(result.error.includes('--headless'), false);
  } finally {
    await server.killAll(false);
  }
});
