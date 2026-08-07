/**
 * Channel Manager — Maps terminal sessions to MCPL channels.
 *
 * Channel ID format: terminal:{sessionId}
 *
 * Channels are dynamic — registered as sessions are created,
 * removed when sessions exit/are killed.
 *
 * Handles registration, open/close lifecycle, incoming message batching,
 * publish routing (send input to terminal), and channel listing.
 */

import type {
  ChannelDescriptor,
  ChannelIncomingMessage,
  McplTextContent,
  ChannelsPublishParams,
  ChannelsOpenParams,
  ChannelsCloseParams,
  ChannelsListResult,
} from './types';
import type { McplClient } from './client';
import type { RobustSessionClient } from '../client/websocket-client';
import type { WatchManager, WatchMatchResult } from './watch-manager';
import { cleanTerminalOutput } from '../utils/ansi-clean';

const DEFAULT_BATCH_WINDOW_MS = 500;
const CHANNEL_PREFIX = 'terminal:';

export class ChannelManager {
  private allChannels = new Map<string, ChannelDescriptor>();
  private openChannels = new Set<string>();
  private batchBuffer: ChannelIncomingMessage[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchWindowMs: number;
  private outputCounter = 0;
  private watchManager: WatchManager | null = null;

  constructor(
    private mcplClient: McplClient,
    private sessionClient: RobustSessionClient,
    batchWindowMs?: number,
  ) {
    this.batchWindowMs = batchWindowMs ??
      (parseInt(process.env.MCPL_BATCH_WINDOW_MS || '', 10) || DEFAULT_BATCH_WINDOW_MS);
  }

  /**
   * Set the WatchManager instance for dynamic output watches.
   * Wires the halt-fired callback to emit synthetic incoming messages.
   */
  setWatchManager(wm: WatchManager): void {
    this.watchManager = wm;
    wm.onHaltFired = (sessionId, match) => {
      this.emitSyntheticHaltMessage(sessionId, match);
    };
  }

  /**
   * Build a channel ID from a session ID.
   */
  static channelId(sessionId: string): string {
    return `${CHANNEL_PREFIX}${sessionId}`;
  }

  /**
   * Extract session ID from a channel ID.
   */
  static sessionId(channelId: string): string {
    return channelId.slice(CHANNEL_PREFIX.length);
  }

  /**
   * Register all existing sessions as channels on startup.
   */
  async registerExistingSessions(): Promise<void> {
    try {
      const sessions = await this.sessionClient.listSessions();
      if (!sessions || !Array.isArray(sessions)) return;

      const channels: ChannelDescriptor[] = [];
      for (const session of sessions) {
        const descriptor = this.buildDescriptor(session.id, session.name);
        this.allChannels.set(descriptor.id, descriptor);
        channels.push(descriptor);
      }

      if (channels.length > 0) {
        try {
          await this.mcplClient.registerChannels(channels);
          console.error(`[MCPL] Registered ${channels.length} existing session channels`);
        } catch (error) {
          console.error('[MCPL] Failed to register existing channels:', error);
        }
      }
    } catch (error) {
      console.error('[MCPL] Failed to list existing sessions:', error);
    }
  }

  /**
   * Called when a new session is created.
   * Registers a new channel and notifies the host via channels/changed.
   */
  onSessionCreated(sessionId: string, name?: string): void {
    const descriptor = this.buildDescriptor(sessionId, name);
    this.allChannels.set(descriptor.id, descriptor);
    this.mcplClient.sendChannelsChanged([descriptor]);
    console.error(`[MCPL] Channel added: ${descriptor.id}`);
  }

  /**
   * Called when a session exits or is killed.
   * Removes the channel and notifies the host via channels/changed.
   */
  onSessionExited(sessionId: string): void {
    const channelId = ChannelManager.channelId(sessionId);
    this.watchManager?.onSessionExited(sessionId);
    if (this.allChannels.delete(channelId)) {
      this.openChannels.delete(channelId);
      this.mcplClient.sendChannelsChanged(undefined, [channelId]);
      console.error(`[MCPL] Channel removed: ${channelId}`);
    }
  }

  /**
   * Subscribe to real-time session output via the WebSocket client.
   * Forwards output as MCPL incoming messages.
   */
  subscribeToOutput(): void {
    // Subscribe to all session output with no replay
    this.sessionClient.request('session.subscribe', { all: true, replay: 0 }).catch(err => {
      console.error('[MCPL] Failed to subscribe to session output:', err);
    });

    // Listen for session:output events
    this.sessionClient.on('session:output', (event: any) => {
      const sessionId = event.sessionId;
      const channelId = ChannelManager.channelId(sessionId);

      if (!this.openChannels.has(channelId)) return;

      const rawOutput: string = event.payload?.output || event.payload?.data || '';
      if (!rawOutput) return;

      const cleaned = cleanTerminalOutput(rawOutput);
      if (!cleaned) return;

      // Evaluate watches against cleaned output
      const watchMatches = this.watchManager?.evaluateOutput(sessionId, cleaned) ?? [];

      const metadata: Record<string, unknown> = { source: 'terminal', sessionId };

      // If any watch matched, merge first match metadata + trigger flag
      if (watchMatches.length > 0) {
        const first = watchMatches[0];
        metadata.triggerInference = true;
        metadata.watchId = first.watchId;
        metadata.watchType = first.watchType;
        if (first.watchLabel) metadata.watchLabel = first.watchLabel;
        if (first.patternMatch) metadata.patternMatch = first.patternMatch;
        if (first.patternName) metadata.patternName = first.patternName;
      }

      const message: ChannelIncomingMessage = {
        channelId,
        messageId: `output-${++this.outputCounter}`,
        author: { id: 'terminal', name: sessionId },
        timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: cleaned }],
        metadata,
      };

      this.batchBuffer.push(message);
      this.scheduleBatchFlush();
    });

    // Listen for session:exit events
    this.sessionClient.on('session:exit', (event: any) => {
      const sessionId = event.sessionId;
      if (sessionId) {
        this.onSessionExited(sessionId);
      }
    });
  }

  /**
   * Handle channels/open from the host.
   */
  openChannel(params: ChannelsOpenParams): { channel: ChannelDescriptor } {
    // Find channel by type and address
    for (const [id, descriptor] of this.allChannels) {
      if (descriptor.type === params.type) {
        const matchesAddress = !params.address ||
          Object.entries(params.address).every(([k, v]) => descriptor.address?.[k] === v);
        if (matchesAddress) {
          this.openChannels.add(id);
          return { channel: descriptor };
        }
      }
    }
    throw new Error(`No channel found matching type=${params.type}`);
  }

  /**
   * Handle channels/close from the host.
   */
  closeChannel(params: ChannelsCloseParams): { closed: boolean } {
    const existed = this.openChannels.delete(params.channelId);
    return { closed: existed };
  }

  /**
   * Handle channels/list from the host.
   */
  listChannels(): ChannelsListResult {
    return { channels: Array.from(this.allChannels.values()) };
  }

  /**
   * Handle channels/publish from the host — send input to a terminal session.
   */
  async publish(params: ChannelsPublishParams): Promise<{ delivered: boolean }> {
    const channelId = params.channelId;
    if (!channelId.startsWith(CHANNEL_PREFIX)) {
      throw new Error(`Unknown channel format: ${channelId}`);
    }

    const sessionId = ChannelManager.sessionId(channelId);
    const textContent = params.content
      .filter((c): c is McplTextContent => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    if (!textContent) {
      return { delivered: false };
    }

    // Check if it's a signal command
    if (textContent.startsWith('SIGNAL:')) {
      const signal = textContent.slice('SIGNAL:'.length).trim();
      await this.sessionClient.sendSignal(sessionId, signal);
      return { delivered: true };
    }

    // Otherwise send as input
    await this.sessionClient.sendInput(sessionId, textContent);
    return { delivered: true };
  }

  /**
   * Get the set of currently open channel IDs.
   */
  getOpenChannels(): Set<string> {
    return this.openChannels;
  }

  /**
   * Get a channel descriptor by ID.
   */
  getChannel(id: string): ChannelDescriptor | undefined {
    return this.allChannels.get(id);
  }

  /**
   * Cleanup timers.
   */
  destroy(): void {
    this.watchManager?.destroy();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  // -- Private --

  private emitSyntheticHaltMessage(sessionId: string, match: WatchMatchResult): void {
    const channelId = ChannelManager.channelId(sessionId);
    if (!this.openChannels.has(channelId)) return;

    const message: ChannelIncomingMessage = {
      channelId,
      messageId: `halt-${++this.outputCounter}`,
      author: { id: 'terminal', name: sessionId },
      timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: `[halt watch] No output for ${match.haltDurationSeconds}s on session ${sessionId}` }],
      metadata: {
        source: 'terminal',
        sessionId,
        triggerInference: true,
        watchId: match.watchId,
        watchType: 'halt',
        ...(match.watchLabel && { watchLabel: match.watchLabel }),
        haltDurationSeconds: match.haltDurationSeconds,
      },
    };

    this.mcplClient.sendIncoming([message]).catch(err => {
      console.error('[MCPL] Failed to send synthetic halt message:', err);
    });
  }

  private buildDescriptor(sessionId: string, name?: string): ChannelDescriptor {
    const channelId = ChannelManager.channelId(sessionId);
    return {
      id: channelId,
      type: 'terminal',
      label: name ? `${name} (${sessionId})` : sessionId,
      direction: 'bidirectional',
      address: { sessionId },
      metadata: { name },
    };
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) return; // already scheduled
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, this.batchWindowMs);
  }

  private async flushBatch(): Promise<void> {
    if (this.batchBuffer.length === 0) return;

    const messages = this.batchBuffer.splice(0);

    try {
      await this.mcplClient.sendIncoming(messages);
    } catch (error) {
      console.error('[MCPL] Failed to send incoming messages to host:', error);
    }
  }
}
