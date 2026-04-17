import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execP = promisify(exec);

export interface AgentProcessMatch {
  pid: number;
  command: string;
}

export async function findAgentPids(cwd: string): Promise<AgentProcessMatch[]> {
  if (process.platform === 'win32') {
    // Windows support deferred — ps/lsof approach is POSIX-only.
    return [];
  }
  const candidates = await listClaudeProcesses();
  const matched: AgentProcessMatch[] = [];
  await Promise.all(
    candidates.map(async (c) => {
      const pidCwd = await getCwdForPid(c.pid);
      if (pidCwd && path.resolve(pidCwd) === path.resolve(cwd)) matched.push(c);
    }),
  );
  return matched;
}

export function killAgent(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

async function listClaudeProcesses(): Promise<AgentProcessMatch[]> {
  try {
    const { stdout } = await execP('ps -Ao pid=,args=');
    const out: AgentProcessMatch[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const args = match[2];
      if (!looksLikeClaude(args)) continue;
      out.push({ pid, command: args });
    }
    return out;
  } catch {
    return [];
  }
}

function looksLikeClaude(args: string): boolean {
  const lower = args.toLowerCase();
  if (!lower.includes('claude')) return false;
  // Exclude our own extension host or editor processes that merely mention the word.
  if (lower.includes('code helper') || lower.includes('extensionhost')) return false;
  return true;
}

async function getCwdForPid(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execP(`lsof -a -p ${pid} -d cwd -F n`);
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
    return null;
  } catch {
    return null;
  }
}

