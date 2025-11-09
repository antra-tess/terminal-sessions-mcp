/**
 * Basic usage example for terminal-sessions-mcp
 */

import { SessionClient } from '../src/server/websocket-api';

async function main() {
  // Connect to the session server
  const client = new SessionClient('ws://localhost:3100');
  
  console.log('Creating session...');
  await client.createSession({ id: 'example-session' });
  
  console.log('Executing command...');
  const result = await client.exec('example-session', 'echo "Hello from terminal session!"');
  console.log('Output:', result.output);
  
  console.log('Getting recent logs...');
  const logs = await client.getOutput('example-session', 10);
  console.log('Recent logs:', logs);
  
  console.log('Searching logs...');
  const matches = await client.searchLogs('example-session', 'Hello', 2);
  console.log('Matches:', matches);
  
  console.log('Listing sessions...');
  const sessions = await client.listSessions();
  console.log('Active sessions:', sessions);
  
  console.log('Cleaning up...');
  await client.killAll();
  
  client.close();
  console.log('Done!');
}

main().catch(console.error);

