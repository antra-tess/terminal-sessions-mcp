#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const ptyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');

// Check prebuilds (used when native compilation is skipped)
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
for (const platform of platforms) {
  fixPermission(path.join(ptyDir, 'prebuilds', platform, 'spawn-helper'));
}

// Check build/Release (used when compiled from source)
fixPermission(path.join(ptyDir, 'build', 'Release', 'spawn-helper'));

function fixPermission(helperPath) {
  try {
    const stat = fs.statSync(helperPath);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(helperPath, 0o755);
      console.log(`Fixed execute permission on ${path.relative(ptyDir, helperPath)}`);
    }
  } catch {
    // File may not exist for this platform
  }
}
