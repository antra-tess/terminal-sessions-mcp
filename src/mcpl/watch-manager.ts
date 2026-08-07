/**
 * Watch Manager — Dynamic output watches for terminal sessions.
 *
 * Manages pattern watches (regex on output) and halt watches (silence detection).
 * Called by ChannelManager on each output chunk to evaluate matches.
 *
 * When a watch fires, returns metadata that ChannelManager merges into the
 * incoming message, including `triggerInference: true` for the host.
 */

import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface PatternWatch {
  type: 'pattern';
  id: string;
  sessionId: string;
  pattern: RegExp;
  patternSource: string;
  label?: string;
  once: boolean;
}

export interface HaltWatch {
  type: 'halt';
  id: string;
  sessionId: string;
  durationSeconds: number;
  label?: string;
  once: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export type Watch = PatternWatch | HaltWatch;

export interface WatchMatchResult {
  watchId: string;
  watchType: 'pattern' | 'halt';
  watchLabel?: string;
  patternMatch?: string;
  patternName?: string;
  haltDurationSeconds?: number;
}

export interface WatchInfo {
  id: string;
  type: 'pattern' | 'halt';
  sessionId: string;
  label?: string;
  once: boolean;
  pattern?: string;
  durationSeconds?: number;
}

const LINE_BUFFER_MAX = 20;

// ============================================================================
// WatchManager
// ============================================================================

export class WatchManager {
  private watches = new Map<string, Watch>();
  private lineBuffers = new Map<string, { lines: string[]; partial: string }>();

  /** Callback fired when a halt timer expires — ChannelManager wires this up. */
  onHaltFired?: (sessionId: string, match: WatchMatchResult) => void;

  // --------------------------------------------------------------------------
  // Add / Remove
  // --------------------------------------------------------------------------

  addPatternWatch(params: {
    sessionId: string;
    pattern: string;
    label?: string;
    once?: boolean;
  }): { watchId: string } {
    const id = randomUUID();
    const watch: PatternWatch = {
      type: 'pattern',
      id,
      sessionId: params.sessionId,
      pattern: new RegExp(params.pattern),
      patternSource: params.pattern,
      label: params.label,
      once: params.once ?? false,
    };
    this.watches.set(id, watch);
    console.error(`[Watch] Added pattern watch ${id} on ${params.sessionId}: /${params.pattern}/`);
    return { watchId: id };
  }

  addHaltWatch(params: {
    sessionId: string;
    durationSeconds: number;
    label?: string;
    once?: boolean;
  }): { watchId: string } {
    const id = randomUUID();
    const watch: HaltWatch = {
      type: 'halt',
      id,
      sessionId: params.sessionId,
      durationSeconds: params.durationSeconds,
      label: params.label,
      once: params.once ?? true,
      timer: null,
    };
    this.watches.set(id, watch);
    this.startHaltTimer(watch);
    console.error(`[Watch] Added halt watch ${id} on ${params.sessionId}: ${params.durationSeconds}s`);
    return { watchId: id };
  }

  removeWatch(watchId: string): { removed: boolean } {
    const watch = this.watches.get(watchId);
    if (!watch) return { removed: false };

    if (watch.type === 'halt' && watch.timer) {
      clearTimeout(watch.timer);
    }
    this.watches.delete(watchId);
    console.error(`[Watch] Removed watch ${watchId}`);
    return { removed: true };
  }

  listWatches(sessionId?: string): WatchInfo[] {
    const result: WatchInfo[] = [];
    for (const watch of this.watches.values()) {
      if (sessionId && watch.sessionId !== sessionId) continue;
      const info: WatchInfo = {
        id: watch.id,
        type: watch.type,
        sessionId: watch.sessionId,
        label: watch.label,
        once: watch.once,
      };
      if (watch.type === 'pattern') {
        info.pattern = watch.patternSource;
      } else {
        info.durationSeconds = watch.durationSeconds;
      }
      result.push(info);
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Evaluate output (called by ChannelManager on each chunk)
  // --------------------------------------------------------------------------

  evaluateOutput(sessionId: string, cleanedText: string): WatchMatchResult[] {
    // 1. Reset halt timers for this session
    this.resetHaltTimers(sessionId);

    // 2. Append to line buffer
    const buf = this.getOrCreateBuffer(sessionId);
    buf.partial += cleanedText;

    // Split into complete lines
    const parts = buf.partial.split('\n');
    buf.partial = parts.pop() ?? ''; // last element is the incomplete line
    const newLines = parts;

    // Keep rolling window
    buf.lines.push(...newLines);
    if (buf.lines.length > LINE_BUFFER_MAX) {
      buf.lines.splice(0, buf.lines.length - LINE_BUFFER_MAX);
    }

    // 3. Check pattern watches against new lines
    const matches: WatchMatchResult[] = [];
    const toRemove: string[] = [];

    for (const watch of this.watches.values()) {
      if (watch.type !== 'pattern') continue;
      if (watch.sessionId !== sessionId) continue;

      for (const line of newLines) {
        const m = watch.pattern.exec(line);
        if (m) {
          matches.push({
            watchId: watch.id,
            watchType: 'pattern',
            watchLabel: watch.label,
            patternMatch: m[0],
            patternName: watch.patternSource,
          });
          if (watch.once) {
            toRemove.push(watch.id);
          }
          break; // one match per watch per chunk
        }
      }
    }

    for (const id of toRemove) {
      this.watches.delete(id);
      console.error(`[Watch] Auto-removed once-watch ${id}`);
    }

    return matches;
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  onSessionExited(sessionId: string): void {
    for (const [id, watch] of this.watches) {
      if (watch.sessionId !== sessionId) continue;
      if (watch.type === 'halt' && watch.timer) {
        clearTimeout(watch.timer);
      }
      this.watches.delete(id);
    }
    this.lineBuffers.delete(sessionId);
    console.error(`[Watch] Cleaned up watches for session ${sessionId}`);
  }

  destroy(): void {
    for (const watch of this.watches.values()) {
      if (watch.type === 'halt' && watch.timer) {
        clearTimeout(watch.timer);
      }
    }
    this.watches.clear();
    this.lineBuffers.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private getOrCreateBuffer(sessionId: string): { lines: string[]; partial: string } {
    let buf = this.lineBuffers.get(sessionId);
    if (!buf) {
      buf = { lines: [], partial: '' };
      this.lineBuffers.set(sessionId, buf);
    }
    return buf;
  }

  private resetHaltTimers(sessionId: string): void {
    for (const watch of this.watches.values()) {
      if (watch.type !== 'halt') continue;
      if (watch.sessionId !== sessionId) continue;
      this.startHaltTimer(watch); // restart resets the existing timer
    }
  }

  private startHaltTimer(watch: HaltWatch): void {
    if (watch.timer) {
      clearTimeout(watch.timer);
    }
    watch.timer = setTimeout(() => {
      watch.timer = null;
      const match: WatchMatchResult = {
        watchId: watch.id,
        watchType: 'halt',
        watchLabel: watch.label,
        haltDurationSeconds: watch.durationSeconds,
      };
      console.error(`[Watch] Halt fired: ${watch.id} (${watch.durationSeconds}s silence on ${watch.sessionId})`);

      this.onHaltFired?.(watch.sessionId, match);

      if (watch.once) {
        this.watches.delete(watch.id);
        console.error(`[Watch] Auto-removed once-watch ${watch.id}`);
      } else {
        // Re-arm for non-once watches
        this.startHaltTimer(watch);
      }
    }, watch.durationSeconds * 1000);
  }
}
