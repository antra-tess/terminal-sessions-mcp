/**
 * Service management example
 */

import { SessionClient } from '../src/server/websocket-api';

async function main() {
  const client = new SessionClient('ws://localhost:3100');
  
  console.log('Starting a web server...');
  const result = await client.startService({
    name: 'test-server',
    command: 'python3 -m http.server 8080',
    readyPatterns: ['Serving HTTP'],
    errorPatterns: ['Error', 'Failed']
  });
  
  console.log('Service status:', result.status);
  console.log('Startup logs:', result.logs);
  
  if (result.status === 'ready') {
    console.log('Server is ready! Waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('Getting recent output...');
    const logs = await client.getOutput('test-server', 20);
    console.log('Server logs:', logs);
    
    console.log('Stopping server...');
    await client.sendSignal('test-server', 'SIGINT');
    
    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  client.close();
  console.log('Done!');
}

main().catch(console.error);

