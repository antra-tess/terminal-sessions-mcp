import * as fs from 'fs';

const AUTH_ENVIRONMENT_KEYS = ['SESSION_SERVER_TOKEN', 'SESSION_SERVER_TOKEN_FILE'] as const;

/** Remove the fixed authentication keys; this is not secure erasure. */
export function clearAuthEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of AUTH_ENVIRONMENT_KEYS) delete env[key];
}

/**
 * Read a validated private token file. These checks and
 * deleting environment keys are not secure erasure and do not protect against
 * other processes running under the same UID.
 */
function readTokenFile(path: string): string {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(path);
    const privateFile = (s: fs.Stats) =>
      s.isFile() && (s.mode & 0o077) === 0 &&
      typeof process.getuid === 'function' && s.uid === process.getuid();
    if (!privateFile(before)) throw new Error();
    // On platforms without O_NOFOLLOW, lstat plus descriptor identity checks
    // reject symlinks/replacements; fstat and read still use the same fd.
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const token = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!token) throw new Error();
    return token;
  } catch {
    // Do not include file contents, paths, or underlying errors in diagnostics.
    throw new Error('Unsafe or unreadable token file: require a nonempty regular file owned by the current UID with no group or other permissions');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** File input takes precedence over legacy argv/env token input. */
export function readAuthToken(argvToken?: string, argvFile?: string): string | undefined {
  try {
    const file = argvFile ?? process.env.SESSION_SERVER_TOKEN_FILE;
    return file !== undefined ? readTokenFile(file) : argvToken || process.env.SESSION_SERVER_TOKEN;
  } finally {
    clearAuthEnvironment();
  }
}

/** Fixed authentication keys must never be inherited by a terminal shell. */
export function withoutAuthEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  clearAuthEnvironment(clean);
  return clean;
}
