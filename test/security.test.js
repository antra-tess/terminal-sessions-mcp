// Security regressions against compiled production paths: npm test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { PersistentSessionServer } = require('../dist/src/server/session-server-v3');
const { SessionAPI } = require('../dist/src/server/websocket-api');
const TOKEN = 'test-token-0123456789abcdef';
const FILE_SECRET = 'test-file-0123456789abcdef';
const pause = ms => new Promise(r => setTimeout(r, ms));

function fixture(t, content = TOKEN + '\n', mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, content, { mode });
  return file;
}

test('private token file, precedence, one newline, and environment cleanup', t => {
  const { readAuthToken } = require('../dist/src/server/auth-token');
  const file = fixture(t, TOKEN + '\n\n');
  process.env.SESSION_SERVER_TOKEN = 'test-legacy-token';
  process.env.SESSION_SERVER_TOKEN_FILE = file;
  try {
    assert.equal(readAuthToken(), TOKEN + '\n');
    assert.equal(process.env.SESSION_SERVER_TOKEN, undefined);
    assert.equal(process.env.SESSION_SERVER_TOKEN_FILE, undefined);
    assert.equal(readAuthToken(TOKEN), TOKEN); // legacy argv
    process.env.SESSION_SERVER_TOKEN = TOKEN;
    assert.equal(readAuthToken(), TOKEN); // legacy env
  } finally {
    delete process.env.SESSION_SERVER_TOKEN;
    delete process.env.SESSION_SERVER_TOKEN_FILE;
  }
});

for (const kind of ['0644', 'symlink', 'wrong owner', 'empty', 'directory']) {
  test('unsafe token file refused: ' + kind, t => {
    const { readAuthToken } = require('../dist/src/server/auth-token');
    let file = fixture(t, kind === 'empty' ? '\n' : TOKEN, kind === '0644' ? 0o644 : 0o600);
    if (kind === 'symlink') { fs.symlinkSync(file, file + '-link'); file += '-link'; }
    if (kind === 'directory') file = path.dirname(file);
    if (kind === 'wrong owner') {
      // A non-root process cannot chown; substitute only the owner check's UID.
      const uid = process.getuid;
      process.getuid = () => uid() + 1;
      t.after(() => { process.getuid = uid; });
    }
    process.env.SESSION_SERVER_TOKEN = TOKEN;
    process.env.SESSION_SERVER_TOKEN_FILE = file;
    try {
      assert.throws(() => readAuthToken(), e => /token file/i.test(e.message) && !e.message.includes(TOKEN));
      assert.equal(process.env.SESSION_SERVER_TOKEN, undefined);
      assert.equal(process.env.SESSION_SERVER_TOKEN_FILE, undefined);
    } finally {
      delete process.env.SESSION_SERVER_TOKEN;
      delete process.env.SESSION_SERVER_TOKEN_FILE;
    }
  });
}

test('PTY env output and session logs exclude inherited and caller-supplied auth keys', async () => {
  const s = new PersistentSessionServer();
  process.env.SESSION_SERVER_TOKEN = TOKEN;
  process.env.SESSION_SERVER_TOKEN_FILE = FILE_SECRET;
  try {
    await s.createSession('security-env', { shell: '/bin/sh', env: {
      SESSION_SERVER_TOKEN: TOKEN, SESSION_SERVER_TOKEN_FILE: FILE_SECRET, SECURITY_VISIBLE: 'visible'
    } });
    const out = await s.execCommand('security-env', 'env', 5000);
    assert.ok(out.output.includes('SECURITY_VISIBLE=visible'));
    assert.ok(!out.output.includes(TOKEN));
    assert.ok(!out.output.includes(FILE_SECRET));
    const session = s.sessions.get('security-env');
    assert.ok(!JSON.stringify({ env: session.env, logs: session.logs, output: session.outputBuffer }).includes(TOKEN));
    assert.ok(!JSON.stringify({ env: session.env, logs: session.logs, output: session.outputBuffer }).includes(FILE_SECRET));
  } finally {
    delete process.env.SESSION_SERVER_TOKEN;
    delete process.env.SESSION_SERVER_TOKEN_FILE;
    await s.killAll(false);
  }
});

test('session.env removes auth keys from its result even if the shell supplies them', async () => {
  const s = new PersistentSessionServer();
  // Deterministic shell output also exercises the explicit result filter.
  s.execCommand = async () => ({ output: 'SESSION_SERVER_TOKEN=' + TOKEN +
    '\nSESSION_SERVER_TOKEN_FILE=' + FILE_SECRET + '\nVISIBLE=yes\n', exitCode: 0 });
  const env = await s.getEnvironment('synthetic');
  assert.equal(env.VISIBLE, 'yes');
  assert.equal(env.SESSION_SERVER_TOKEN, undefined);
  assert.equal(env.SESSION_SERVER_TOKEN_FILE, undefined);
});

test('session.env does not capture shell auth variables into session logs', async () => {
  const s = new PersistentSessionServer();
  try {
    await s.createSession('security-getenv', { shell: '/bin/sh' });
    await s.execCommand('security-getenv', 'export SESSION_SERVER_TOKEN=synthetic SESSION_SERVER_TOKEN_FILE=synthetic', 5000);
    // Clear the deliberate setup command's echoed output, then check only env output.
    const session = s.sessions.get('security-getenv');
    session.logs.length = 0;
    session.outputBuffer = '';
    await s.getEnvironment('security-getenv');
    assert.ok(!session.logs.join('\n').includes('SESSION_SERVER_TOKEN=synthetic'));
    assert.ok(!session.logs.join('\n').includes('SESSION_SERVER_TOKEN_FILE=synthetic'));
  } finally { await s.killAll(false); }
});

test('refused real WebSocket upgrade logs no query secrets', async () => {
  const api = new SessionAPI(0, '127.0.0.1', TOKEN);
  await once(api.httpServer, 'listening');
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  let ws;
  try {
    ws = new WebSocket('ws://127.0.0.1:' + api.httpServer.address().port + '/?token=' + TOKEN + '&other=' + FILE_SECRET,
      { origin: 'https://other.example' });
    await new Promise(resolve => { ws.on('error', resolve); });
    assert.ok(lines.some(l => l.includes('refused')));
    assert.ok(!lines.join('\n').includes(TOKEN));
    assert.ok(!lines.join('\n').includes(FILE_SECRET));
  } finally {
    console.error = original;
    if (ws) ws.terminate();
    await api.stop();
  }
});

test('headless session.screenshot refuses before loading puppeteer, through the API', async () => {
  const Module = require('node:module');
  const orig = Module._load;
  let loaded = false;
  Module._load = function(name, ...args) {
    if (name === 'puppeteer') { loaded = true; throw new Error('puppeteer must not load'); }
    return orig.call(this, name, ...args);
  };
  const api = new SessionAPI(0, '127.0.0.1', undefined, {}, true);
  try {
    await api.server.createSession('screenshot', { shell: '/bin/sh' });
    const reply = await api.handleMessage({}, { id: '1', method: 'session.screenshot', params: { sessionId: 'screenshot' } });
    assert.match(reply.result.error, /headless/i);
    assert.equal(loaded, false);
    // The server path is gated as well as the API path.
    const shot = await api.server.takeScreenshot('screenshot');
    assert.match(shot.error, /headless/i);
    assert.equal(loaded, false);
  } finally { Module._load = orig; await api.stop(); }
});

function childProcess(t, script, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('timed out'); await pause(20); }
}

for (const cli of [false, true]) {
  test('backend reads private token file via ' + (cli ? '--token-file' : 'env') + ' and scrubs environment', async t => {
    const file = fixture(t);
    const probe = path.join(path.dirname(file), 'probe.cjs');
    // Production startup, but replace listen only to inspect env and avoid opening a listener.
    fs.writeFileSync(probe, `require('http').Server.prototype.listen = function() {
      console.log('AUTH_ENV_CLEAN=' + (!('SESSION_SERVER_TOKEN' in process.env) && !('SESSION_SERVER_TOKEN_FILE' in process.env)));
      setImmediate(() => process.exit(0)); return this;
    };`);
    const c = childProcess(t, path.resolve('dist/src/server/start-session-server.js'), {
      SESSION_SERVER_HOST: '127.0.0.1', SESSION_SERVER_PORT: '0',
      SESSION_SERVER_TOKEN: '', SESSION_SERVER_TOKEN_FILE: cli ? undefined : file,
      NODE_OPTIONS: '--require=' + probe
    }, ['--headless', ...(cli ? ['--token-file', file] : [])]);
    const [code] = await c.closed;
    assert.equal(code, 0);
    assert.ok(c.stdout().includes('Token authentication enabled'));
    assert.ok(c.stdout().includes('AUTH_ENV_CLEAN=true'));
    assert.ok(!c.stdout().includes(TOKEN) && !c.stderr().includes(TOKEN));
  });
}

test('stdio shim authenticates from token file, scrubs env and never logs URL queries', async t => {
  const file = fixture(t);
  const probe = path.join(path.dirname(file), 'probe.cjs');
  fs.writeFileSync(probe, `process.on('exit', () => console.error('AUTH_ENV_CLEAN=' +
    (!('SESSION_SERVER_TOKEN' in process.env) && !('SESSION_SERVER_TOKEN_FILE' in process.env))));`);
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  t.after(() => new Promise(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(resolve); }));
  let token;
  wss.on('connection', (ws, req) => {
    token = new URL(req.url, 'http://localhost').searchParams.get('token');
    ws.on('message', d => { const { id } = JSON.parse(d); ws.send(JSON.stringify({ id, result: [] })); });
  });
  const c = childProcess(t, path.resolve('dist/src/mcp/mcp-stdio-server.js'), {
    SESSION_SERVER_TOKEN: '', SESSION_SERVER_TOKEN_FILE: file, MCP_DEBUG: '1',
    SESSION_SERVER_URL: 'ws://127.0.0.1:' + wss.address().port + '/?other=' + FILE_SECRET,
    NODE_OPTIONS: '--require=' + probe
  });
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listSessions', arguments: {} } }) + '\n');
  await until(() => c.stdout().includes('"id":1'));
  c.child.stdin.end();
  await c.closed;
  assert.equal(token, TOKEN);
  assert.ok(c.stderr().includes('AUTH_ENV_CLEAN=true'));
  assert.ok(!c.stderr().includes(TOKEN));
  assert.ok(!c.stderr().includes(FILE_SECRET));
});

for (const backend of [false, true]) {
  test((backend ? 'backend' : 'stdio shim') + ' refuses an invalid configured file instead of falling back to env', async t => {
    const file = fixture(t, TOKEN, 0o644);
    const probe = path.join(path.dirname(file), 'probe.cjs');
    fs.writeFileSync(probe, `require('http').Server.prototype.listen = function() {
      setImmediate(() => process.exit(0)); return this;
    };`);
    const c = childProcess(t, path.resolve(backend ?
      'dist/src/server/start-session-server.js' : 'dist/src/mcp/mcp-stdio-server.js'), {
      SESSION_SERVER_HOST: '127.0.0.1', SESSION_SERVER_PORT: '0',
      SESSION_SERVER_TOKEN: TOKEN, SESSION_SERVER_TOKEN_FILE: file,
      NODE_OPTIONS: '--require=' + probe
    }, backend ? ['--headless'] : []);
    c.child.stdin.end();
    const [code] = await c.closed;
    assert.notEqual(code, 0);
    assert.match(c.stderr(), /token file/i);
    assert.ok(!c.stderr().includes(TOKEN));
  });
}

test('GUI screenshot error retains diagnostics without disclosing its auth token', async () => {
  const s = new PersistentSessionServer();
  s.guiAuthToken = TOKEN;
  const Module = require('node:module');
  const orig = Module._load;
  try {
    await s.createSession('gui-error', { shell: '/bin/sh' });
    Module._load = function(name, ...args) {
      if (name === 'puppeteer') return { launch: async () => {
        throw new Error('navigation failed for http://127.0.0.1/?token=' + TOKEN);
      } };
      return orig.call(this, name, ...args);
    };
    const result = await s.takeScreenshot('gui-error');
    assert.equal(result.success, false);
    assert.match(result.error, /navigation failed/);
    assert.ok(!result.error.includes(TOKEN));
  } finally { Module._load = orig; await s.killAll(false); }
});


test('hostile Host and Origin values are omitted from refusal logs', () => {
  const { RequestGuard } = require('../dist/src/server/request-guard');
  const guard = new RequestGuard('127.0.0.1', 0, false);
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    for (const headers of [
      { host: 'hostile.example/?token=' + TOKEN + '&query=' + FILE_SECRET },
      { host: '127.0.0.1', origin: 'https://other.example/?token=' + TOKEN + '&query=' + FILE_SECRET }
    ]) {
      assert.equal(guard.check({
        headers, method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }
      }).ok, false);
    }
  } finally { console.error = original; }
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.includes('refused')));
  assert.ok(!lines.join('\n').includes(TOKEN));
  assert.ok(!lines.join('\n').includes(FILE_SECRET));
  assert.ok(!lines.join('\n').includes('hostile.example'));
  assert.ok(!lines.join('\n').includes('other.example'));
});

test('explicit private token file takes precedence over an argv token', t => {
  const { readAuthToken } = require('../dist/src/server/auth-token');
  const file = fixture(t);
  const argvToken = 'test-argv-0123456789abcdef';
  assert.equal(readAuthToken(argvToken, file), TOKEN);
});

test('invalid explicit token file refuses instead of falling back to an argv token', t => {
  const { readAuthToken } = require('../dist/src/server/auth-token');
  const file = fixture(t, TOKEN, 0o644);
  const argvToken = 'test-argv-0123456789abcdef';
  assert.throws(() => readAuthToken(argvToken, file), error =>
    /token file/i.test(error.message) &&
    !error.message.includes(TOKEN) && !error.message.includes(argvToken));
});

test('direct WebSocket API entry honors HEADLESS without opening a listener', async t => {
  const file = fixture(t);
  const probe = path.join(path.dirname(file), 'direct-entry-probe.cjs');
  const serverModule = path.resolve('dist/src/server/session-server-v3.js');
  fs.writeFileSync(probe, `
    require('http').Server.prototype.listen = function() { return this; };
    const sessions = require(${JSON.stringify(serverModule)});
    const Original = sessions.PersistentSessionServer;
    sessions.PersistentSessionServer = class extends Original {
      constructor(...args) {
        super(...args);
        setImmediate(async () => {
          const result = await this.takeScreenshot('absent');
          console.log(JSON.stringify(result));
          process.exit(0);
        });
      }
    };
  `);
  const c = childProcess(t, path.resolve('dist/src/server/websocket-api.js'), {
    HEADLESS: 'true', NODE_OPTIONS: '--require=' + probe
  });
  const [code] = await c.closed;
  assert.equal(code, 0);
  const result = JSON.parse(c.stdout());
  assert.equal(result.success, false);
  assert.match(result.error, /headless/i);
});
