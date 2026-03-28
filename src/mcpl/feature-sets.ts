/**
 * Feature Set Declarations for Terminal Sessions MCPL
 *
 * Declares MCPL capabilities for terminal session management.
 */

import type { FeatureSetDeclaration, McplServerCapabilities } from './types';

export function buildFeatureSets(): Record<string, FeatureSetDeclaration> {
  return {
    'terminal.sessions': {
      description: 'Real-time terminal session output and management',
      uses: ['channels.publish', 'channels.observe', 'pushEvents', 'tools'],
    },
    'terminal.context': {
      description: 'Terminal session log injection before inference',
      uses: ['contextHooks.beforeInference'],
    },
  };
}

export function buildServerCapabilities(): McplServerCapabilities {
  const featureSets = buildFeatureSets();

  return {
    version: '0.4',
    pushEvents: true,
    contextHooks: {
      beforeInference: true,
      afterInference: false,
    },
    featureSets,
    channels: {
      register: true,
      publish: true,
      lifecycle: true,
    },
  };
}
