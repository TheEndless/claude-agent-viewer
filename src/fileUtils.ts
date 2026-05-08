/**
 * fileUtils.ts
 *
 * Shared low-level file I/O helpers used by agentService and transcriptPanel.
 */

import * as fsp from 'fs/promises';

/**
 * Opens `filePath` and reads up to `maxBytes` starting at `offset`, returning
 * the slice as a UTF-8 string. Uses a bounded read so large files are never
 * fully loaded for operations that only need a slice.
 */
export async function readFileSlice(filePath: string, offset: number, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return '';
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
