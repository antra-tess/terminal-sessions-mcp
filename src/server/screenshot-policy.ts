/** Explicit screenshot opt-out, shared by every server construction path. */
export function screenshotsDisabled(): boolean {
  if (process.argv.some(arg => arg.startsWith('--disable-screenshot='))) {
    throw new Error('--disable-screenshot supports only the bare flag (no value)');
  }
  // An explicit CLI opt-out wins even over an invalid environment setting.
  if (process.argv.includes('--disable-screenshot')) return true;
  const value = process.env.SESSION_SERVER_DISABLE_SCREENSHOT;
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new Error('SESSION_SERVER_DISABLE_SCREENSHOT must be true, 1, false, 0, or unset');
}
