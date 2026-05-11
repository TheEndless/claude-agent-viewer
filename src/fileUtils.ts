/**
 * fileUtils.ts
 *
 * Shared low-level file I/O helpers used by agentService and transcriptPanel.
 * Tracks active fs operation counts so diagnostics can distinguish our pool
 * usage from external sources (VS Code, other extensions).
 */

import * as fsp from 'fs/promises';
import * as fs from 'fs';

const activeCounts = new Map<string, number>();
const startedCounts = new Map<string, number>();

function inc(op: string): void {
  activeCounts.set(op, (activeCounts.get(op) ?? 0) + 1);
  startedCounts.set(op, (startedCounts.get(op) ?? 0) + 1);
}
function dec(op: string): void {
  activeCounts.set(op, Math.max(0, (activeCounts.get(op) ?? 0) - 1));
}

/** Wraps a promised fs operation so we can count active and total ops by type. */
export function trackedFs<T>(op: string, p: Promise<T>): Promise<T> {
  inc(op);
  return p.finally(() => dec(op));
}

/** Returns active counts (currently outstanding) and lifetime totals. */
export function getFsCounts(): { active: Record<string, number>; total: Record<string, number> } {
  return {
    active: Object.fromEntries(activeCounts),
    total: Object.fromEntries(startedCounts),
  };
}

/** Tracked wrappers around the fs/promises calls we use. */
export const tfs = {
  stat: (p: string) => trackedFs<fs.Stats>('stat', fsp.stat(p)),
  readdir: (p: string) => trackedFs<string[]>('readdir', fsp.readdir(p)),
  readdirTypes: (p: string) => trackedFs<fs.Dirent[]>('readdirTypes', fsp.readdir(p, { withFileTypes: true }) as Promise<fs.Dirent[]>),
  readFile: (p: string, enc: BufferEncoding) => trackedFs<string>('readFile', fsp.readFile(p, enc) as Promise<string>),
  writeFile: (p: string, data: string, enc: BufferEncoding) => trackedFs<void>('writeFile', fsp.writeFile(p, data, enc)),
};

/**
 * Opens `filePath` and reads up to `maxBytes` starting at `offset`, returning
 * the slice as a UTF-8 string. Uses a bounded read so large files are never
 * fully loaded for operations that only need a slice.
 */
export async function readFileSlice(filePath: string, offset: number, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return '';
  const handle = await trackedFs('open', fsp.open(filePath, 'r'));
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await trackedFs('read', handle.read(buf, 0, maxBytes, offset));
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await trackedFs('close', handle.close());
  }
}
