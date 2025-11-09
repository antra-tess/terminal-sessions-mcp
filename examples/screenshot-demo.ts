/**
 * Terminal Screenshot Demo
 * 
 * Demonstrates capturing visual terminal output
 */

import { SessionClient } from '../src/server/websocket-api';

async function main() {
  const client = new SessionClient('ws://localhost:3100');
  
  console.log('Creating a colorful terminal session...');
  await client.createSession({ id: 'demo-colors' });
  
  // Generate some colorful output
  console.log('Generating colorful content...');
  await client.exec('demo-colors', 'echo -e "\\033[31mRed Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[32mGreen Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[33mYellow Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[34mBlue Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[35mMagenta Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[36mCyan Text\\033[0m"');
  await client.exec('demo-colors', 'echo -e "\\033[1;37mBright White\\033[0m"');
  await client.exec('demo-colors', 'ls -la --color=auto | head -15');
  
  console.log('Taking screenshot...');
  const screenshot = await client.takeScreenshot('demo-colors', {
    lines: 30,
    outputPath: './demo-terminal-screenshot.png',
    width: 1000,
    height: 600
  });
  
  if (screenshot.success && screenshot.path) {
    console.log('✅ Screenshot saved to:', screenshot.path);
  } else {
    console.log('❌ Screenshot failed:', screenshot.error);
  }
  
  // Clean up
  await client.killAll();
  client.close();
  
  console.log('Done! Check demo-terminal-screenshot.png');
}

main().catch(console.error);

