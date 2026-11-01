// Bounded review regressions. Synthetic secrets only; no browser or PTY needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const TOKEN = "a/b+c'd";
const forms = [TOKEN, encodeURIComponent(TOKEN), new URLSearchParams({ token: TOKEN }).toString().slice(6)];
const root = path.resolve('dist');
const serverPath = path.join(root, 'src/server/session-server-v3.js');
const apiPath = path.join(root, 'src/server/websocket-api.js');
const startPath = path.join(root, 'src/server/start-session-server.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function child(t, script, args = [], env = {}, preload = '') {
  const dir = fixture(t);
  const probe = path.join(dir, 'preload.cjs');
  fs.writeFileSync(probe, preload);
  const clean = { ...process.env };
  for (const key of ['SESSION_SERVER_TOKEN', 'SESSION_SERVER_TOKEN_FILE', 'SESSION_SERVER_DISABLE_SCREENSHOT', 'HEADLESS', 'NODE_OPTIONS', 'SESSION_SERVER_URL']) delete clean[key];
  return spawnSync(process.execPath, ['--require', probe, script, ...args], {
    env: { ...clean, SESSION_SERVER_HOST: '127.0.0.1', SESSION_SERVER_PORT: '0', ...env },
    input: '', encoding: 'utf8', timeout: 5000
  });
}
const shotProbe = `
  // Keep the bundled GUI client from attempting an unrelated connection.
  require(${JSON.stringify(path.join(root, 'gui/src/server.js'))}).WebGUIServer = class {};
  require('http').Server.prototype.listen = function() { return this; };
  const Module = require('module');
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'puppeteer') { console.error('PUPPETEER_LOADED'); throw new Error('unexpected puppeteer load'); }
    return load.call(this, name, ...args);
  };
  const sessions = require(${JSON.stringify(serverPath)});
  const Original = sessions.PersistentSessionServer;
  sessions.PersistentSessionServer = class extends Original {
    constructor(...args) {
      super(...args);
      this.sessions.set('shot', {});
      setImmediate(async () => {
        console.log('SHOT=' + JSON.stringify(await this.takeScreenshot('shot')));
        process.exit(0);
      });
    }
  };
`;
const entries = ['session-server', 'direct websocket-api', 'library SessionAPI', 'library PersistentSessionServer'];
function entry(t, name, args, env) {
  let script = name === 'session-server' ? startPath : apiPath;
  if (name.startsWith('library')) {
    script = path.join(fixture(t), 'embed.cjs');
    const construct = name === 'library SessionAPI' ? "new api.SessionAPI(0, '127.0.0.1')" : 'new api.PersistentSessionServer()';
    fs.writeFileSync(script, `const api = require(${JSON.stringify(path.join(root, 'src/index.js'))}); ${construct};`);
  }
  return child(t, script, args, env, shotProbe);
}
for (const name of entries) {
  test(name + ': bare --disable-screenshot refuses before puppeteer', t => {
    const c = entry(t, name, ['--disable-screenshot'], { SESSION_SERVER_DISABLE_SCREENSHOT: 'false' });
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /SHOT=.*"success":false.*disabled/);
    assert.ok(!c.stderr.includes('PUPPETEER_LOADED'));
  });
  for (const value of ['yes', 'TRUE ', 'on']) {
    test(name + ': invalid screenshot env ' + JSON.stringify(value) + ' refuses startup', t => {
      const c = entry(t, name, [], { SESSION_SERVER_DISABLE_SCREENSHOT: value, SESSION_SERVER_TOKEN: TOKEN });
      assert.notEqual(c.status, 0);
      assert.match(c.stderr, /SESSION_SERVER_DISABLE_SCREENSHOT/);
      assert.ok(!c.stderr.includes(TOKEN));
      assert.ok(!c.stdout.includes('SHOT='));
      assert.ok(!c.stderr.includes('PUPPETEER_LOADED'));
    });
  }
  for (const value of ['garbage', '', 'true', '1', 'false', '0']) {
    test(name + ': rejects --disable-screenshot=' + value, t => {
      const c = entry(t, name, ['--disable-screenshot=' + value], {});
      assert.notEqual(c.status, 0);
      assert.match(c.stderr, /--disable-screenshot/);
      assert.ok(!c.stdout.includes('SHOT='));
      assert.ok(!c.stderr.includes('PUPPETEER_LOADED'));
    });
  }
}
for (const value of ['true', '1']) {
  test('env ' + value + ' disables screenshots before puppeteer', t => {
    const c = entry(t, 'session-server', [], { SESSION_SERVER_DISABLE_SCREENSHOT: value });
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /SHOT=.*disabled/);
    assert.ok(!c.stderr.includes('PUPPETEER_LOADED'));
  });
}
test('bare disable flag wins over invalid env', t => {
  const c = entry(t, 'session-server', ['--disable-screenshot'], { SESSION_SERVER_DISABLE_SCREENSHOT: 'invalid' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /SHOT=.*disabled/);
  assert.ok(!c.stderr.includes('PUPPETEER_LOADED'));
});
test('malformed disable form still refuses when bare flag is also present', t => {
  const c = entry(t, 'session-server', ['--disable-screenshot', '--disable-screenshot='], {});
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /--disable-screenshot/);
});
for (const value of [undefined, '', 'false', '0']) {
  test('headless backend reaches external GUI via guiPort when env is ' + JSON.stringify(value), async () => {
    const oldEnv = process.env.SESSION_SERVER_DISABLE_SCREENSHOT;
    if (value === undefined) delete process.env.SESSION_SERVER_DISABLE_SCREENSHOT;
    else process.env.SESSION_SERVER_DISABLE_SCREENSHOT = value;
    const { SessionAPI } = require('../dist/src/server/websocket-api');
    const api = new SessionAPI(0, '127.0.0.1', undefined, {}, true);
    await once(api.httpServer, 'listening');
    api.server.sessions.set('shot', {});
    const load = Module._load;
    let loaded = false, navigated;
    Module._load = function(name, ...args) {
      if (name === 'puppeteer') {
        loaded = true;
        return { launch: async () => ({ close: async () => {}, newPage: async () => ({
          setViewport: async () => {}, goto: async url => { navigated = url; throw new Error('external GUI navigation reached'); }
        }) }) };
      }
      return load.call(this, name, ...args);
    };
    try {
      const response = await api.handleMessage({}, { id: 'shot', method: 'session.screenshot', params: { sessionId: 'shot', guiPort: 43210 } });
      assert.equal(loaded, true);
      assert.equal(navigated, 'http://localhost:43210');
      assert.match(response.result.error, /external GUI navigation reached/);
    } finally {
      Module._load = load;
      api.server.sessions.delete('shot');
      await api.stop();
      if (oldEnv === undefined) delete process.env.SESSION_SERVER_DISABLE_SCREENSHOT;
      else process.env.SESSION_SERVER_DISABLE_SCREENSHOT = oldEnv;
    }
  });
}

const parseProbe = `
  process.on('exit', () => console.log('AUTH_ENV_CLEAN=' +
    (!('SESSION_SERVER_TOKEN' in process.env) && !('SESSION_SERVER_TOKEN_FILE' in process.env))));
  require(${JSON.stringify(apiPath)}).SessionAPI = class {
    constructor(port, host, token) { console.log('PARSED=' + JSON.stringify({host, token})); }
  };
`;
for (const [name, args] of [
  ['missing final path', ['--token-file']],
  ['next flag is not a path', ['--token-file', '--headless']],
  ['empty equals path', ['--token-file=']]
]) {
  test('token-file parser: ' + name + ' throws and scrubs auth env', t => {
    const c = child(t, startPath, args, { SESSION_SERVER_TOKEN: TOKEN, SESSION_SERVER_TOKEN_FILE: 'synthetic-path' }, parseProbe);
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /--token-file requires a path/);
    assert.match(c.stdout, /AUTH_ENV_CLEAN=true/);
    assert.ok(!c.stderr.includes(TOKEN));
    assert.ok(!c.stdout.includes('PARSED='));
  });
}
test('token-file parser: equals path preserves equals inside filename', t => {
  const file = path.join(fixture(t), 'token=a=b');
  fs.writeFileSync(file, TOKEN, { mode: 0o600 });
  const c = child(t, startPath, ['--headless', '--token-file=' + file], {}, parseProbe);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /AUTH_ENV_CLEAN=true/);
  const parsed = JSON.parse(c.stdout.split('PARSED=')[1].split('\n')[0]);
  assert.equal(parsed.token, TOKEN);
});
test('getArgValue preserves equals in both token and host', t => {
  const c = child(t, startPath, ['--headless', '--token=abc==', '--host=a=b'], {}, parseProbe);
  assert.equal(c.status, 0, c.stderr);
  const parsed = JSON.parse(c.stdout.split('PARSED=')[1].split('\n')[0]);
  assert.deepEqual(parsed, { host: 'a=b', token: 'abc==' });
  assert.match(c.stdout, /AUTH_ENV_CLEAN=true/);
});

for (const [i, form] of forms.entries()) {
  test('screenshot error redacts reserved token form ' + i + ' in real formatter', async () => {
    const { PersistentSessionServer } = require('../dist/src/server/session-server-v3');
    const server = new PersistentSessionServer();
    server.guiAuthToken = TOKEN;
    server.sessions.set('shot', {});
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'puppeteer') return { launch: async () => { throw new Error('navigation failed: ' + form); } };
      return load.call(this, name, ...args);
    };
    try {
      const result = await server.takeScreenshot('shot');
      assert.match(result.error, /navigation failed/);
      for (const secret of forms) assert.ok(!result.error.includes(secret));
    } finally { Module._load = load; server.sessions.delete('shot'); }
  });
}

test('MCP_DEBUG client error retains message but strips every query and token form', () => {
  const { RobustSessionClient } = require('../dist/src/client/websocket-client');
  const load = Module._load;
  const oldDebug = process.env.MCP_DEBUG;
  const lines = [];
  const log = console.error;
  let socket;
  Module._load = function(name, ...args) {
    if (name === 'ws') return class extends EventEmitter { constructor() { super(); socket = this; } close() {} };
    return load.call(this, name, ...args);
  };
  process.env.MCP_DEBUG = '1';
  console.error = (...args) => lines.push(args.join(' '));
  let client;
  try {
    for (const form of forms) {
      client = new RobustSessionClient('ws://127.0.0.1:3100/?other=synthetic-query-secret', TOKEN);
      socket.emit('error', new Error('ECONNREFUSED at ws://user:synthetic-password@127.0.0.1:3100/?token=' + form + '&other=synthetic-query-secret token outside URL: ' + form));
      client.close();
    }
    assert.equal(lines.filter(line => line.includes('ECONNREFUSED')).length, forms.length);
    for (const secret of [...forms, 'synthetic-query-secret', 'synthetic-password']) assert.ok(!lines.join('\n').includes(secret));
  } finally {
    if (client) client.close();
    Module._load = load;
    console.error = log;
    if (oldDebug === undefined) delete process.env.MCP_DEBUG; else process.env.MCP_DEBUG = oldDebug;
  }
});

test('MCP_DEBUG simple SessionClient sanitizes real connection-error diagnostics', async () => {
  const { SessionClient } = require('../dist/src/server/websocket-api');
  const load = Module._load;
  const oldDebug = process.env.MCP_DEBUG;
  const log = console.error;
  const lines = [];
  let socket, client;
  Module._load = function(name, ...args) {
    if (name === 'ws') return class extends EventEmitter { constructor() { super(); socket = this; } close() {} };
    return load.call(this, name, ...args);
  };
  process.env.MCP_DEBUG = '1';
  console.error = (...args) => lines.push(args.join(' '));
  try {
    client = new SessionClient('ws://127.0.0.1:3100/?token=' + encodeURIComponent(TOKEN));
    const rejected = assert.rejects(client.connected, /ECONNREFUSED/);
    socket.emit('error', new Error('ECONNREFUSED at ws://127.0.0.1/?token=' + forms[2] + '&other=synthetic-query-secret'));
    await rejected;
    assert.match(lines.join('\n'), /ECONNREFUSED/);
    for (const secret of [...forms, 'synthetic-query-secret']) assert.ok(!lines.join('\n').includes(secret));
  } finally {
    if (client) client.close();
    Module._load = load; console.error = log;
    if (oldDebug === undefined) delete process.env.MCP_DEBUG; else process.env.MCP_DEBUG = oldDebug;
  }
});

test('MCP_DEBUG robust client sanitizes synchronous connection errors too', () => {
  const { RobustSessionClient } = require('../dist/src/client/websocket-client');
  const load = Module._load, log = console.error;
  const oldDebug = process.env.MCP_DEBUG;
  const lines = [];
  let client;
  Module._load = function(name, ...args) {
    if (name === 'ws') return class { constructor() { throw new Error('connect failed at ws://127.0.0.1/?token=' + forms[2] + '&other=synthetic-query-secret'); } };
    return load.call(this, name, ...args);
  };
  process.env.MCP_DEBUG = '1';
  console.error = (...args) => lines.push(args.join(' '));
  try {
    client = new RobustSessionClient('ws://127.0.0.1:3100', TOKEN);
    assert.match(lines.join('\n'), /connect failed/);
    for (const secret of [...forms, 'synthetic-query-secret']) assert.ok(!lines.join('\n').includes(secret));
  } finally {
    if (client) client.close();
    Module._load = load; console.error = log;
    if (oldDebug === undefined) delete process.env.MCP_DEBUG; else process.env.MCP_DEBUG = oldDebug;
  }
});

for (const [name, host, port, expected] of [
  ['normal', '127.0.0.1', '43210', 'at 127.0.0.1:43210'],
  ['query injection', '127.0.0.1:43210/?token=synthetic-host-secret', '3100', 'at 127.0.0.1:43210'],
  ['invalid host', '[invalid?token=synthetic-host-secret', '3100', '(invalid address)'],
  ['invalid port', '127.0.0.1', 'synthetic-port-secret', '(invalid address)']
]) {
  test('shim fallback logs only parsed host:port: ' + name, t => {
    const preload = `
      require(${JSON.stringify(path.join(root, 'src/mcp/mcp-server.js'))}).ConnectomeTestingMCP = class {
        async listSessions() { return []; }
      };
    `;
    const dir = fixture(t), probe = path.join(dir, 'probe.cjs');
    fs.writeFileSync(probe, preload);
    const env = { ...process.env, SESSION_SERVER_HOST: host, SESSION_SERVER_PORT: port, NODE_OPTIONS: '' };
    delete env.SESSION_SERVER_URL; delete env.SESSION_SERVER_TOKEN; delete env.SESSION_SERVER_TOKEN_FILE;
    const c = spawnSync(process.execPath, ['--require', probe, path.join(root, 'src/mcp/mcp-stdio-server.js')], {
      env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listSessions', arguments: {} } }) + '\n', encoding: 'utf8', timeout: 5000
    });
    assert.equal(c.status, 0, c.stderr);
    assert.ok(c.stderr.includes(expected), c.stderr);
    assert.ok(!c.stderr.includes('synthetic-host-secret'));
    assert.ok(!c.stderr.includes('synthetic-port-secret'));
  });
}
