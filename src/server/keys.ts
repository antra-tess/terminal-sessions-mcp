/**
 * Named-key decoding for sendInput (tmux send-keys style).
 *
 * Raw control characters cannot pass through the MCP JSON tool layer, so
 * special keys are expressed as names and decoded to their terminal byte
 * sequences here.
 */

export const NAMED_KEYS: Record<string, string> = {
  'enter': '\r',
  'tab': '\t',
  'shift-tab': '\x1b[Z',
  'esc': '\x1b',
  'escape': '\x1b',
  'space': ' ',
  'backspace': '\x7f',
  'delete': '\x1b[3~',
  'up': '\x1b[A',
  'down': '\x1b[B',
  'right': '\x1b[C',
  'left': '\x1b[D',
  'home': '\x1b[H',
  'end': '\x1b[F',
  'pageup': '\x1b[5~',
  'pagedown': '\x1b[6~',
  'f1': '\x1bOP', 'f2': '\x1bOQ', 'f3': '\x1bOR', 'f4': '\x1bOS',
  'f5': '\x1b[15~', 'f6': '\x1b[17~', 'f7': '\x1b[18~', 'f8': '\x1b[19~',
  'f9': '\x1b[20~', 'f10': '\x1b[21~', 'f11': '\x1b[23~', 'f12': '\x1b[24~',
};

/**
 * Decode a single key name to its byte sequence.
 * Supports NAMED_KEYS (case-insensitive), C-a..C-z (Ctrl+letter),
 * and M-<char> (Alt/Meta, case-sensitive char).
 * @throws on unknown key names, listing the valid vocabulary.
 */
export function decodeKey(name: string): string {
  const k = name.toLowerCase();
  const named = NAMED_KEYS[k];
  if (named !== undefined) return named;
  const ctrl = /^c-([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const meta = /^m-(.)$/i.exec(name);
  if (meta) return `\x1b${meta[1]}`;
  throw new Error(
    `Unknown key '${name}'. Valid: ${Object.keys(NAMED_KEYS).join(', ')}, C-a..C-z, M-<char>`
  );
}

/**
 * Build the exact byte string to write to the PTY for a sendInput call.
 *
 * - `input` is passed through verbatim, followed by decoded `keys`.
 * - Enter (\r — what a real Enter key sends; correct for canonical-mode
 *   shells and raw-mode TUIs alike) is appended by default when no keys
 *   are given. When `keys` are given the caller controls the exact bytes,
 *   so Enter is only appended if `appendNewline` is explicitly true.
 */
export function buildInputData(input: string, appendNewline?: boolean, keys?: string[]): string {
  const { body, enter } = splitInputData(input, appendNewline, keys);
  return body + enter;
}

/**
 * Same as buildInputData, but keeps the trailing Enter separate:
 * `body` is the text plus decoded keys, `enter` is '\r' or ''.
 */
export function splitInputData(
  input: string,
  appendNewline?: boolean,
  keys?: string[]
): { body: string; enter: string } {
  const hasKeys = !!(keys && keys.length > 0);
  let body = input;
  if (hasKeys) {
    body += keys!.map(decodeKey).join('');
  }
  const shouldAppend = hasKeys ? appendNewline === true : appendNewline !== false;
  return { body, enter: shouldAppend ? '\r' : '' };
}

/** Upper bound for `enterDelayMs` (milliseconds). */
export const MAX_ENTER_DELAY_MS = 5000;

/**
 * Validate the optional `enterDelayMs` parameter of sendInput.
 * Returns undefined when absent (null/undefined), the number when it is a
 * finite number in 0..MAX_ENTER_DELAY_MS, and throws otherwise.
 */
export function validateEnterDelayMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_ENTER_DELAY_MS) {
    throw new Error(`enterDelayMs must be a number between 0 and ${MAX_ENTER_DELAY_MS}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** One PTY write: wait `delayMs` (after the previous write), then write `data`. */
export interface PlannedWrite {
  data: string;
  delayMs: number;
}

/**
 * Plan the PTY writes for a sendInput call.
 *
 * Without `enterDelayMs` this is a single write of buildInputData(...), i.e.
 * the text and the trailing Enter go out together (unchanged behaviour).
 *
 * With `enterDelayMs` set, and when Enter would be appended after a non-empty
 * body, the body is written first and '\r' goes out as a SEPARATE write
 * `enterDelayMs` later. Some TUIs (e.g. Claude Code) treat a fast, long chunk
 * as a bracketed paste and don't act on a '\r' that arrives in the same
 * write; a short pause before Enter makes them submit.
 */
export function planInputWrites(
  input: string,
  appendNewline?: boolean,
  keys?: string[],
  enterDelayMs?: number
): PlannedWrite[] {
  const { body, enter } = splitInputData(input, appendNewline, keys);
  if (enterDelayMs === undefined || !enter || !body) {
    return [{ data: body + enter, delayMs: 0 }];
  }
  return [
    { data: body, delayMs: 0 },
    { data: enter, delayMs: enterDelayMs }
  ];
}

/**
 * Execute planned writes in order, honouring each write's delay.
 * `isAlive` is consulted after every wait so nothing is written to a session
 * that exited while we were sleeping (throws in that case).
 */
export async function performInputWrites(
  writes: PlannedWrite[],
  write: (data: string) => void,
  options: { isAlive?: () => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (const w of writes) {
    if (w.delayMs > 0) {
      await sleep(w.delayMs);
      if (options.isAlive && !options.isAlive()) {
        throw new Error('Session exited before the delayed Enter could be sent');
      }
    }
    write(w.data);
  }
}

/**
 * A server that predates `enterDelayMs` ignores the parameter and still
 * answers { success: true }; new servers echo the value back. Fail loudly
 * instead of silently sending text+Enter in one write.
 */
export function assertEnterDelayHonoured(result: any, enterDelayMs?: number): void {
  if (enterDelayMs === undefined || enterDelayMs === null) return;
  if (!result || result.enterDelayMs === undefined) {
    throw new Error(
      'The session server ignored enterDelayMs (it predates this option). ' +
      'Restart/upgrade the session server, or omit enterDelayMs.'
    );
  }
}
