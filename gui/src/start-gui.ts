#!/usr/bin/env node

/**
 * Start Terminal Sessions Web GUI
 */

import { WebGUIServer } from './server';

const port = parseInt(process.env.GUI_PORT || '3200');

console.log('Starting Terminal Sessions Web GUI...\n');

const server = new WebGUIServer(port);

process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

