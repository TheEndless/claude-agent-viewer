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
 * Derives the parent session ID from a transcript file path.
 * Subagent paths contain a `/subagents/` segment; the directory immediately
 * before it is the parent session ID. Returns undefined for root sessions.
 */
export function parentSessionIdFromPath(filePath: string): string | undefined {
  const normalised = filePath.replace(/\\/g, '/');
  const idx = normalised.lastIndexOf('/subagents/');
  if (idx === -1) return undefined;
  const before = normalised.slice(0, idx);
  return before.slice(before.lastIndexOf('/') + 1);
}

/**
 * Populates `parentSessionId` and `subagents` on every agent in the map.
 * Safe to call repeatedly - resets all arrays before each pass so results
 * never accumulate across calls.
 */
export function buildTree(agents: Map<string, Agent>): void {
  for (const agent of agents.values()) {
    agent.subagents = [];
    agent.parentSessionId = undefined;
  }

  for (const agent of agents.values()) {
    const parentSessionId = parentSessionIdFromPath(agent.transcriptPath);
    if (!parentSessionId) continue;
    // Always set so orphan subagents are excluded from root before their
    // parent file arrives.
    agent.parentSessionId = parentSessionId;
    const parent = agents.get(parentSessionId);
    if (parent) {
      parent.subagents.push(agent);
    }
  }
}

/** Exported only for unit testing - use buildTree() directly in production code. */
export const buildTreeForTesting = buildTree;
