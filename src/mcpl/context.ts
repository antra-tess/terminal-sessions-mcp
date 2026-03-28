/**
 * Context Provider — Handles context/beforeInference.
 *
 * Injects recent terminal output from open channels into the inference context.
 * Fetches last N log lines from each open terminal session.
 */

import type {
  BeforeInferenceParams,
  BeforeInferenceResult,
  McplContextInjection,
} from './types';
import type { ChannelManager } from './channels';
import type { RobustSessionClient } from '../client/websocket-client';
import { cleanTerminalOutput } from '../utils/ansi-clean';

const DEFAULT_HISTORY_SIZE = 50;

export class ContextProvider {
  private historySize: number;

  constructor(
    private channelManager: ChannelManager,
    private sessionClient: RobustSessionClient,
    historySize?: number,
  ) {
    this.historySize = historySize ??
      (parseInt(process.env.MCPL_CONTEXT_HISTORY_SIZE || '', 10) || DEFAULT_HISTORY_SIZE);
  }

  /**
   * Handle context/beforeInference — return context injections for open channels.
   */
  async handleBeforeInference(_params: BeforeInferenceParams): Promise<BeforeInferenceResult> {
    const injections: McplContextInjection[] = [];
    const openChannels = this.channelManager.getOpenChannels();

    for (const channelId of openChannels) {
      try {
        const injection = await this.getTerminalContext(channelId);
        if (injection) {
          injections.push(injection);
        }
      } catch (error) {
        console.error(`[MCPL] Failed to get context for channel ${channelId}:`, error);
      }
    }

    return {
      featureSet: 'terminal.context',
      contextInjections: injections,
    };
  }

  private async getTerminalContext(channelId: string): Promise<McplContextInjection | null> {
    if (!channelId.startsWith('terminal:')) return null;

    const sessionId = channelId.slice('terminal:'.length);

    try {
      const logs: string[] = await this.sessionClient.getOutput(sessionId, this.historySize);
      if (!logs || logs.length === 0) return null;

      // Clean each line and join
      const cleaned = logs
        .map(line => cleanTerminalOutput(line))
        .filter(line => line.length > 0)
        .join('\n');

      if (!cleaned) return null;

      return {
        namespace: channelId,
        position: 'beforeUser',
        content: `Recent output from terminal session "${sessionId}" (last ${logs.length} lines):\n${cleaned}`,
      };
    } catch (error) {
      console.error(`[MCPL] Failed to fetch output for session ${sessionId}:`, error);
      return null;
    }
  }
}
