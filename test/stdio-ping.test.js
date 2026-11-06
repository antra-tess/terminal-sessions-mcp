const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const serverJs = join(__dirname, '..', 'dist', 'src', 'mcp', 'mcp-stdio-server.js');

test('stdio answers an MCP ping with an empty result', () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ];
  const output = execFileSync(process.execPath, [serverJs], {
    encoding: 'utf8',
    input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    timeout: 10000,
  });
  const replies = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies.slice(1), [{ jsonrpc: '2.0', id: 2, result: {} }]);
});
