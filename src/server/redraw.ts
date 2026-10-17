/**
 * "Redraw": make the foreground program repaint its whole screen.
 *
 * TUIs (Claude Code, vim, htop, ...) draw by diff and skip cells they believe
 * are already correct, so a viewer whose terminal state diverged (attached
 * mid-stream, history replayed at another width, dropped frames) shows holes.
 * A window-size change makes them repaint everything, so we nudge the PTY by
 * one row (or column), wait a moment and put the original size back. Only the
 * PTY is touched; the viewer's own grid never changes.
 */

export interface PtyLike {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * How long the PTY stays at the nudged size before it is restored.
 * A program only learns the new size when it gets to handle SIGWINCH; one
 * that is busy until after the restore sees no change and doesn't repaint.
 * Measured with a program busy 150 of every 160 ms: a 60 ms hold reached it
 * 0/20 times, 100 ms 15/20, 150 ms 20/20.
 */
export const REDRAW_NUDGE_MS = 150;

/** The temporary size used to provoke the repaint: one row less, else one column less. */
export function planRedrawNudge(size: TerminalSize): TerminalSize {
  if (size.rows > 1) return { cols: size.cols, rows: size.rows - 1 };
  if (size.cols > 1) return { cols: size.cols - 1, rows: size.rows };
  return { cols: size.cols, rows: size.rows + 1 };
}

/**
 * Nudge the PTY and restore its size. Resolves with the restored size.
 * The original size is restored even if the wait fails; if the restore itself
 * fails the error propagates (the caller can retry a plain resize).
 */
export async function performRedraw(
  pty: PtyLike,
  options: { nudgeMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<TerminalSize> {
  const original = { cols: pty.cols, rows: pty.rows };
  const nudge = planRedrawNudge(original);
  const nudgeMs = options.nudgeMs ?? REDRAW_NUDGE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  pty.resize(nudge.cols, nudge.rows);
  try {
    await sleep(nudgeMs);
  } finally {
    pty.resize(original.cols, original.rows);
  }
  return original;
}
