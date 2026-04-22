/**
 * agentTree.ts
 *
 * Builds the parent-child relationship between top-level agents and their
 * subagents. Subagents are identified by their transcript path containing
 * a "/subagents/" segment - the directory immediately before "/subagents/"
 * is the parent session ID.
 *
 * This module is intentionally free of vscode imports so it can be unit-tested
 * with plain vitest.
 */

import { Agent } from './types';

/**
 * Populates `parentSessionId` and `subagents` on every agent in the map.
 * Safe to call repeatedly - resets all arrays before each pass so results
 * never accumulate across calls.
 */
export function buildTree(agents: Map<string, Agent>): void {
  // Reset all subagent arrays so repeated calls don't accumulate
  for (const agent of agents.values()) {
    agent.subagents = [];
    agent.parentSessionId = undefined;
  }

  for (const agent of agents.values()) {
    // Subagent paths contain "/subagents/" - extract parent session ID from the
    // directory name that immediately precedes the "/subagents/" segment.
    const normalised = agent.transcriptPath.replace(/\\/g, '/');
    const subagentsIdx = normalised.lastIndexOf('/subagents/');
    if (subagentsIdx === -1) continue;

    const beforeSubagents = normalised.slice(0, subagentsIdx);
    const parentSessionId = beforeSubagents.slice(beforeSubagents.lastIndexOf('/') + 1);
    // Always set parentSessionId from path so orphan subagents are excluded from
    // the root list even before their parent file has been processed.
    agent.parentSessionId = parentSessionId;
    const parent = agents.get(parentSessionId);
    if (parent) {
      parent.subagents.push(agent);
    }
  }
}

/** Exported only for unit testing - use buildTree() directly in production code. */
export const buildTreeForTesting = buildTree;
