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
    return findAgentPidsWin32(cwd);
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

// ── POSIX ────────────────────────────────────────────────────────────────────

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

// ── Windows ──────────────────────────────────────────────────────────────────

// PowerShell script with inline C# that reads each process's CurrentDirectory
// out of its PEB via NtQueryInformationProcess + ReadProcessMemory.
// Key offsets (both architectures):
//   PEB.ProcessParameters:              +0x20 (x64), +0x10 (x86)
//   RTL_USER_PROCESS_PARAMETERS
//     .CurrentDirectory.DosPath.Length: +0x38 (x64), +0x24 (x86)
//     .CurrentDirectory.DosPath.Buffer: +0x40 (x64), +0x28 (x86)
const WIN32_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class _AvProcUtil {
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pbi, int s, out int r);
    [StructLayout(LayoutKind.Sequential)]
    struct PBI { public IntPtr a, PebBase, b, c, UniqueId, d; }
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint a, bool b, int pid);
    [DllImport("kernel32.dll")]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] buf, int s, out IntPtr r);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    public static string GetCwd(int pid) {
        IntPtr hp = OpenProcess(0x410u, false, pid);
        if (hp == IntPtr.Zero) return null;
        try {
            var pbi = new PBI(); int n;
            if (NtQueryInformationProcess(hp, 0, ref pbi, Marshal.SizeOf(pbi), out n) != 0) return null;
            bool x64 = IntPtr.Size == 8;
            var pb = new byte[x64 ? 0x28 : 0x14]; IntPtr rd;
            if (!ReadProcessMemory(hp, pbi.PebBase, pb, pb.Length, out rd)) return null;
            IntPtr pp = x64 ? new IntPtr(BitConverter.ToInt64(pb, 0x20))
                             : new IntPtr(BitConverter.ToInt32(pb, 0x10));
            int off = x64 ? 0x38 : 0x24;
            var cb = new byte[off + (x64 ? 16 : 8)];
            if (!ReadProcessMemory(hp, pp, cb, cb.Length, out rd)) return null;
            ushort len = BitConverter.ToUInt16(cb, off);
            IntPtr bp = x64 ? new IntPtr(BitConverter.ToInt64(cb, off + 8))
                             : new IntPtr(BitConverter.ToInt32(cb, off + 4));
            if (len == 0 || bp == IntPtr.Zero) return null;
            var wb = new byte[len];
            if (!ReadProcessMemory(hp, bp, wb, wb.Length, out rd)) return null;
            return Encoding.Unicode.GetString(wb);
        } finally { CloseHandle(hp); }
    }
}
'@
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -imatch 'claude' -and
    $_.CommandLine -inotmatch 'code\\.exe|extensionhost|Code Helper'
}
if (-not $procs) { '[]'; exit }
$out = [System.Collections.Generic.List[object]]::new()
foreach ($p in @($procs)) {
    $cwd = try {
        $raw = [_AvProcUtil]::GetCwd([int]$p.ProcessId)
        if ($raw) { $raw.TrimEnd('\\').TrimEnd([char]0) } else { $null }
    } catch { $null }
    $out.Add([ordered]@{ pid=[int]$p.ProcessId; command=$p.CommandLine; cwd=$cwd })
}
$out | ConvertTo-Json -Compress
`.trim();

interface Win32ProcessEntry {
  pid: number;
  command: string;
  cwd: string | null;
}

async function listClaudeProcessesWin32(): Promise<Win32ProcessEntry[]> {
  try {
    const encoded = Buffer.from(WIN32_SCRIPT, 'utf16le').toString('base64');
    const { stdout } = await execP(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 15000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return [];
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Win32ProcessEntry[]) : [parsed as Win32ProcessEntry];
  } catch {
    return [];
  }
}

async function findAgentPidsWin32(cwd: string): Promise<AgentProcessMatch[]> {
  const all = await listClaudeProcessesWin32();
  const target = path.resolve(cwd).toLowerCase();
  return all
    .filter((p) => p.cwd && path.resolve(p.cwd).toLowerCase() === target)
    .map(({ pid, command }) => ({ pid, command }));
}
