// MCPL RFC-008: every tool in tools/list carries `_meta["mcpl/class"]`.
// Spawns the compiled stdio server; tools/list needs no session server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const SERVER = path.join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');
const KNOWN = new Set(['comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control']);

function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    // SIGKILL: the server ignores SIGTERM until its first tool call.
    const stop = () => { child.stdin.end(); child.kill('SIGKILL'); };
    const timer = setTimeout(() => { stop(); reject(new Error('no tools/list response')); }, 10_000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 2) return;
      clearTimeout(timer);
      stop();
      resolve(msg.result.tools);
    });
    child.on('error', reject);
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

test('tools/list: every tool declares known RFC-008 classes', async () => {
  const tools = await listTools();
  assert.ok(tools.length >= 10);
  for (const tool of tools) {
    const classes = tool._meta && tool._meta['mcpl/class'];
    assert.ok(Array.isArray(classes) && classes.length > 0, `${tool.name} has no class`);
    for (const c of classes) assert.ok(KNOWN.has(c), `${tool.name}: unknown class ${c}`);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t._meta['mcpl/class']]));
  assert.deepEqual(byName.runCommand, ['shell']);
  assert.deepEqual(byName.sendInput, ['shell']);
  // A rendering of session output, not a desktop capture; outputPath writes a file.
  assert.deepEqual(byName.takeScreenshot, ['shell', 'files']);
});
