/**
 * agentService.ts
 *
 * Discovers, parses, and tracks Claude Code agent sessions by watching
 * ~/.claude/projects/ for JSONL transcript files. Exposes a live, sorted list
 * of Agent objects and fires onDidChange whenever the list or any agent's state
 * changes. Maintains a separate title cache so expensive full-file scans for
 * session names are only performed once per session.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import chokidar from 'chokidar';
import { Agent, AgentDetails, AgentState, RawEvent, ToolCallSummary } from './types';
import { buildTree, parentSessionIdFromPath } from './agentTree';
import { logError, logInfo } from './logger';
import { readFileSlice } from './fileUtils';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 64 * 1024;
const TITLE_HEAD_BYTES = 32 * 1024; // first 32 KB contains titles for virtually all sessions
const DEFAULT_RUNNING_WINDOW_MS = 5 * 60 * 1000;  // configurable via agentViewer.runningWindowMinutes
const DEFAULT_DONE_AGE_MS       = 1 * 60 * 60 * 1000; // configurable via agentViewer.doneAgeHours
const DEBOUNCE_MS = 200;
const STATE_TICK_MS         =  5_000;
const STATE_TICK_MS_HIDDEN  = 60_000;
// Discovery runs infrequently — it's only a backstop for chokidar misses.
// The targeted watchAndDiscoverSubagents handles the common case immediately.
const DISCOVERY_TICK_MS         =  5 * 60 * 1000;  // 5 min visible
const DISCOVERY_TICK_MS_HIDDEN  = 30 * 60 * 1000;  // 30 min hidden
const INIT_BATCH_SIZE = 20; // max concurrent processFile calls per batch in initialize()

/** Cached session name fields scanned from the full transcript file. */
interface TitleCache {
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  firstUserPrompt: string | null;
}

/**
 * Watches the Claude projects directory for JSONL transcript files and
 * maintains an up-to-date in-memory map of Agent objects. Consumers subscribe
 * via onDidChange to receive the full sorted agent list after any update.
 */
export class AgentService {
  private agents = new Map<string, Agent>();
  private titleCache = new Map<string, TitleCache>();
  private watcher?: chokidar.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;
  // Pending unlink timers keyed by file path. An 'add' event for the same path
  // cancels the timer before it fires, handling atomic-write rename sequences.
  private pendingDrops = new Map<string, NodeJS.Timeout>();
  // Per-file maxWait debounce for 'change' events. Trailing 500ms debounce, but
  // forced to fire within CHANGE_FORCE_FLUSH_MS even under continuous writes so
  // that actively-streaming transcripts still get processed and panels stay live.
  private changeDebounce = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  private static readonly CHANGE_FORCE_FLUSH_MS = 2_000;
  // Session IDs evicted by tick-based age logic. Prevents discoverNewFiles() from
  // immediately re-adding sessions that were just evicted, which would cause a
  // continuous evict→discover→evict loop. Chokidar 'change' events bypass this
  // (user resuming an old session re-adds it normally via the watcher).
  // Insertion-order bounded — see MAX_EVICTED_SESSIONS.
  private readonly evictedSessions = new Set<string>();
  private static readonly MAX_EVICTED_SESSIONS = 10_000;
  // Session IDs that have ever had Agent tool_use calls. Pruned when sessions go
  // done/dropped so scanPendingSubagentDirs doesn't probe dead dirs indefinitely.
  private _agentsWithSubagents = new Set<string>();
  // Consecutive empty-readdir count per subagent dir — pruned from _agentsWithSubagents
  // after SUBAGENT_POLL_GIVEUP_COUNT misses (subagent dir created but never written to).
  private _subagentPollFailures = new Map<string, number>();
  private static readonly SUBAGENT_POLL_GIVEUP_COUNT = 12; // ~1 min at 5s tick
  // Subagent dirs confirmed to exist (at least one .jsonl found). Used to distinguish
  // "polling until first file appears" from "watching an already-active dir".
  private watchedSubagentDirs = new Set<string>();
  // Timestamp of last readdir per confirmed subagent dir. Throttles rescans so a
  // busy parent session doesn't issue a readdir on every file-change event.
  private watchedSubagentDirLastRead = new Map<string, number>();
  private static readonly SUBAGENT_READDIR_THROTTLE_MS = 10_000;
  // processFile concurrency gate. Kept low (2) so a stuck/slow read can't
  // monopolize all 4 libuv I/O threads — leaves headroom for VS Code's own I/O.
  // Dropped entries are retried on the next chokidar event or periodic scan.
  // processFileInFlight doubles as the active-count source (size = active).
  // processFileStartedAt feeds the stale-op sweep that reclaims hung slots.
  // processFileNextReadAt is the per-file adaptive cooldown (2× last duration).
  private readonly processFileWaiters: Array<() => void> = [];
  private readonly processFileInFlight = new Set<string>();
  private readonly processFileStartedAt = new Map<string, number>();
  private readonly processFileNextReadAt = new Map<string, number>();
  private static readonly MAX_CONCURRENT_PROCESS = 2;
  private static readonly MAX_WAITER_QUEUE = 200;
  private static readonly STALE_OPERATION_MS = 60_000;
  private static readonly MIN_FILE_READ_COOLDOWN_MS = 8_000;
  // Throttle change-triggered emits: after firing, hold off for this long before
  // firing again. Prevents rapid file writes from rebuilding the agent tree on
  // every individual write when multiple sessions are active simultaneously.
  private _lastChangeEmitMs = 0;
  private static readonly MIN_CHANGE_EMIT_MS = 2_000;
  private _discoveryVisible = true;
  private _discoveryGen = 0;
  // Window focus tracking: when VS Code's window loses focus (e.g. user has the
  // sidebar on a second monitor but interacts with apps elsewhere), Windows
  // throttles the extension host. Continuing to process every chokidar event
  // builds up a backlog in the libuv I/O thread pool that takes minutes to drain
  // when focus returns. We drop change events while unfocused and do a single
  // catch-up stat pass on refocus instead.
  // Window focus tracking. When unfocused, Windows aggressively throttles the
  // extension host process — per-event processing accumulates into a backlog
  // faster than libuv can drain. We batch events instead.
  private _windowFocused = true;
  // Coalesced change/add events while in batch mode (unfocused or throttled).
  // Drained every BATCH_DRAIN_MS or immediately on focus/throttle recovery.
  private readonly _pendingPaths = new Set<string>();
  private _batchTimer?: NodeJS.Timeout;
  private static readonly BATCH_DRAIN_MS = 10_000;
  private _focusDebounceTimer?: NodeJS.Timeout;
  private static readonly FOCUS_DEBOUNCE_MS = 1_000;
  // Throttling detection from event-loop lag samples. Triggers batch mode even
  // when focused, catching system overload / OS-imposed throttling we wouldn't
  // otherwise see.
  private _recentLagMs: number[] = [];
  private _throttled = false;
  private static readonly LAG_SAMPLE_COUNT = 3;
  private static readonly THROTTLED_LAG_MS = 2_000;     // 3 consecutive samples above → throttled
  private static readonly SEVERE_LAG_MS = 10_000;       // any single sample above → immediately throttled
  private static readonly UNTHROTTLED_LAG_MS = 500;     // 3 consecutive samples below → recovered
  // Used to measure event-loop lag: actual tick interval vs. scheduled interval.
  private _lastTickMs = 0;
  private _tickIntervalMs = STATE_TICK_MS;
  private _ready = false;
  private _initializing = false;
  private _tickCount = 0;
  // Set when agents are added or removed (structural change). buildTree only
  // needs to run on structural changes — content-only updates (file writes on
  // existing sessions) are handled by in-place field mutation in processFileImpl.
  private _structureChanged = false;
  private _onDidChange = new vscode.EventEmitter<Agent[]>();
  readonly onDidChange = this._onDidChange.event;
  private _onDidDrop = new vscode.EventEmitter<string>();
  /** Fires with the sessionId whenever a transcript file is deleted. */
  readonly onDidDrop = this._onDidDrop.event;

  /** Returns true once the initial scan of the projects directory has completed. */
  isReady(): boolean { return this._ready; }

  /**
   * Called by the webview provider when the sidebar panel's visibility changes.
   * Slows background timers when hidden to reduce idle overhead, and immediately
   * emits the current state when the panel becomes visible again.
   */
  setVisible(visible: boolean): void {
    this._discoveryVisible = visible;
    this._tickIntervalMs = visible ? STATE_TICK_MS : STATE_TICK_MS_HIDDEN;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(
      () => this.onTick(),
      this._tickIntervalMs,
    );
    // Restart the self-rearming discovery loop at the new cadence.
    this.cancelDiscovery();
    this.armDiscovery();
    if (visible) this.scheduleEmit();
  }

  /**
   * Called when the VS Code window's focus changes. Debounced so quick alt-tabs
   * don't thrash. Actual batching decision is in shouldBatch() — focus is one of
   * two inputs (the other being detected throttling).
   */
  setWindowFocused(focused: boolean): void {
    if (focused === this._windowFocused) return;
    if (this._focusDebounceTimer) clearTimeout(this._focusDebounceTimer);
    this._focusDebounceTimer = setTimeout(() => {
      this._windowFocused = focused;
      logInfo('focus', focused ? 'window focused' : 'window unfocused');
      this.updateBatchTimerState();
      if (focused) void this.drainPendingPaths('refocus');
    }, AgentService.FOCUS_DEBOUNCE_MS);
  }

  /**
   * Returns true when chokidar events should be coalesced into _pendingPaths
   * instead of fired immediately. Two triggers: window unfocused (proactive —
   * we know Windows will throttle us) or sustained event-loop lag (reactive —
   * the OS IS throttling us, even though we're focused).
   */
  private shouldBatch(): boolean {
    return !this._windowFocused || this._throttled;
  }

  /**
   * Starts or stops the periodic batch drainer based on shouldBatch(). The timer
   * itself is cheap (only fires when there are pending paths), but we want it
   * stopped when we're in immediate mode so its existence is a clean signal.
   */
  private updateBatchTimerState(): void {
    if (this.shouldBatch() && !this._batchTimer) {
      this._batchTimer = setInterval(() => void this.drainPendingPaths('batch'), AgentService.BATCH_DRAIN_MS);
    } else if (!this.shouldBatch() && this._batchTimer) {
      clearInterval(this._batchTimer);
      this._batchTimer = undefined;
    }
  }

  /**
   * Detects sustained throttling from event-loop lag samples. Triggers batch mode
   * when the OS is squeezing our process even though we're focused (busy system,
   * background scheduler decisions, etc.). The reverse condition restores
   * immediate mode once lag returns to normal — which also drains accumulated
   * paths, catching us up to current state.
   */
  private detectThrottling(): void {
    const samples = this._recentLagMs;
    if (this._throttled) {
      // Clear only when we have a full window of low-lag samples — avoids flapping.
      if (samples.length >= AgentService.LAG_SAMPLE_COUNT &&
          samples.every(l => l < AgentService.UNTHROTTLED_LAG_MS)) {
        this._throttled = false;
        logInfo('throttle', `cleared (samples: ${samples.join(',')}ms) — resuming immediate processing`);
        this.updateBatchTimerState();
        void this.drainPendingPaths('throttle-clear');
      }
    } else {
      // Detect on either sustained moderate lag OR a single severe spike.
      const last = samples[samples.length - 1] ?? 0;
      const sustained = samples.length >= AgentService.LAG_SAMPLE_COUNT &&
        samples.every(l => l > AgentService.THROTTLED_LAG_MS);
      const severe = last > AgentService.SEVERE_LAG_MS;
      if (sustained || severe) {
        this._throttled = true;
        const why = severe ? `severe (${last}ms single sample)` : `sustained (samples: ${samples.join(',')}ms)`;
        logInfo('throttle', `detected ${why} — switching to ${AgentService.BATCH_DRAIN_MS / 1000}s batch drains`);
        this.updateBatchTimerState();
      }
    }
  }

  /**
   * Processes all paths that accumulated in _pendingPaths since the last drain.
   * Serial (not Promise.all) so we don't fill our concurrency slots all at once
   * — leaves headroom for the immediate-mode work to resume cleanly. Idempotent
   * and no-op when the set is empty.
   */
  private async drainPendingPaths(reason: 'batch' | 'refocus' | 'throttle-clear'): Promise<void> {
    if (this._pendingPaths.size === 0) return;
    const t0 = Date.now();
    const paths = [...this._pendingPaths];
    this._pendingPaths.clear();
    for (const p of paths) await this.processFile(p, undefined, { bypassBatch: true });
    logInfo('drain', `${reason}: processed ${paths.length} pending paths in ${Date.now() - t0}ms`);
  }

  private getConfig() {
    return vscode.workspace.getConfiguration('agentViewer');
  }

  /** Returns the configured running-window threshold in milliseconds. */
  private getRunningWindowMs(): number {
    const minutes = this.getConfig().get<number>('runningWindowMinutes', 5);
    return Math.max(0.5, minutes) * 60 * 1000;
  }

  /** Returns the configured done-age threshold in milliseconds. */
  private getDoneAgeMs(): number {
    const hours = this.getConfig().get<number>('doneAgeHours', 1);
    return Math.max(0.1, hours) * 60 * 60 * 1000;
  }

  /** Combines the state-reclassification tick with a proactive subagent dir scan. */
  private onTick(): void {
    const now = Date.now();
    if (this._lastTickMs > 0) {
      const lag = Math.max(0, now - this._lastTickMs - this._tickIntervalMs);
      if (lag > 2_000) logInfo('tick', `event-loop lag: ${lag}ms behind schedule (expected every ${this._tickIntervalMs}ms)`);
      this._recentLagMs.push(lag);
      if (this._recentLagMs.length > AgentService.LAG_SAMPLE_COUNT) this._recentLagMs.shift();
      this.detectThrottling();
    }
    this._lastTickMs = now;
    this.scheduleEmit('tick');
    void this.scanPendingSubagentDirs();
    // Reclaim slots from any processFile operation stuck >60s. The OS operation
    // continues on its libuv thread, but our concurrency slot is freed so new work
    // can run. Without this, a few hung opens permanently consume our 2 slots.
    this.checkStaleOperations();
    // Every 6th tick (~30s), time a small control read on this file itself. If THIS
    // gets slow, the libuv I/O thread pool is starved — the slowness is pool-wide,
    // not specific to the transcripts. If it stays fast, the issue is file-specific
    // (e.g. file handle accumulation against transcript paths).
    if (this._tickCount % 6 === 0) void this.runIoControlProbe();
  }

  /** Times a small read of our own source file to diagnose libuv thread pool health. */
  private async runIoControlProbe(): Promise<void> {
    try {
      const t0 = Date.now();
      const handle = await fsp.open(__filename, 'r');
      const tOpen = Date.now() - t0;
      const buf = Buffer.allocUnsafe(4096);
      const tRead0 = Date.now();
      await handle.read(buf, 0, 4096, 0);
      const tRead = Date.now() - tRead0;
      await handle.close();
      const total = Date.now() - t0;
      // Always log — comparing control timings against transcript timings is the
      // diagnostic. If control stays fast while transcripts slow down, the issue
      // is path-specific. If control also slows, libuv pool is starved process-wide.
      // Also include active-handle counts so we can spot file-handle leaks.
      const activeHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? -1;
      const activeRequests = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.()?.length ?? -1;
      const tag = total > 50 ? 'SLOW' : 'ok';
      logInfo('ioProbe', `[${tag}] open=${tOpen}ms read=${tRead}ms total=${total}ms handles=${activeHandles} requests=${activeRequests}`);
      // Use the probe as an additional throttling signal — it catches libuv pool
      // saturation earlier and more reliably than waiting for 3 consecutive tick
      // lags. >500ms on a 4KB read of our own source file means I/O threads are
      // monopolized; >5000ms is severe.
      if (!this._throttled && total > 500) {
        this._throttled = true;
        logInfo('throttle', `detected via ioProbe (${total}ms) — switching to ${AgentService.BATCH_DRAIN_MS / 1000}s batch drains`);
        this.updateBatchTimerState();
      }
    } catch (err) { logError('ioProbe', err); }
  }

  /** Begins the initial directory scan and starts the file watcher. */
  start(): void {
    // Periodic tick ensures time-based state transitions (running → idle → done)
    // fire even with no file changes. Routes through scheduleEmit so reclassification
    // always runs on a consistent snapshot, never interleaved with async file reads.
    this.tickTimer = setInterval(() => this.onTick(), STATE_TICK_MS);
    this.armDiscovery();
    // Re-classify when the user changes the done-age threshold.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('agentViewer.doneAgeHours') ||
          e.affectsConfiguration('agentViewer.runningWindowMinutes')) this.scheduleEmit();
    });
    void this.initialize();
  }

  /**
   * Arms a self-rearming discovery timer using setTimeout instead of setInterval
   * so that concurrent scans can never pile up — the next run only schedules
   * after the previous one completes.
   */
  private armDiscovery(): void {
    const gen = ++this._discoveryGen;
    const delay = this._discoveryVisible ? DISCOVERY_TICK_MS : DISCOVERY_TICK_MS_HIDDEN;
    this.discoveryTimer = setTimeout(() => {
      void this.discoverNewFiles().finally(() => {
        // Only re-arm if this generation is still current — prevents a stale
        // in-flight .finally() from creating a second parallel discovery chain
        // when cancelDiscovery + armDiscovery fires before the old one completes.
        if (gen === this._discoveryGen) this.armDiscovery();
      });
    }, delay);
  }

  /** Cancels any pending discovery timer, invalidating any in-flight chain. */
  private cancelDiscovery(): void {
    this._discoveryGen++;
    if (this.discoveryTimer) { clearTimeout(this.discoveryTimer); this.discoveryTimer = undefined; }
  }

  private async initialize(): Promise<void> {
    this._initializing = true;
    const now = Date.now();
    try {
      const allFiles = await findJsonlFiles(PROJECTS_ROOT);
      const STAT_BATCH = 50;
      const statResults: Array<{ path: string; stat: fs.Stats } | null> = [];
      for (let i = 0; i < allFiles.length; i += STAT_BATCH) {
        const batch = await Promise.all(allFiles.slice(i, i + STAT_BATCH).map(async (f) => {
          try { return { path: f, stat: await fsp.stat(f) }; }
          catch (err) { logError(`stat(${f})`, err); return null; }
        }));
        statResults.push(...batch);
      }

      const recentFiles: Array<{ path: string; stat: fs.Stats }> = [];
      const archiveFiles: Array<{ path: string; stat: fs.Stats }> = [];
      for (const r of statResults) {
        if (!r) continue;
        (now - r.stat.mtimeMs > DEFAULT_DONE_AGE_MS ? archiveFiles : recentFiles).push(r);
      }

      // Sort newest-first so actively-running sessions render in the first batch.
      recentFiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

      // Process recent files in bounded batches. Mark _ready after the first
      // batch so the sidebar renders immediately with whatever is available
      // rather than blocking until the entire scan is complete.
      for (let i = 0; i < recentFiles.length; i += INIT_BATCH_SIZE) {
        await Promise.all(recentFiles.slice(i, i + INIT_BATCH_SIZE).map(({ path: p, stat }) => this.processFile(p, stat)));
        if (!this._ready) { this._ready = true; }
        this.scheduleEmit();
      }

      for (let i = 0; i < archiveFiles.length; i += INIT_BATCH_SIZE) {
        await Promise.all(archiveFiles.slice(i, i + INIT_BATCH_SIZE).map(({ path: p, stat }) => this.processFile(p, stat)));
        this.scheduleEmit();
      }
    } catch (err) { logError('initialize', err); }

    this._initializing = false;

    if (!this._ready) {
      this._ready = true;
      this.scheduleEmit();
    }

    let initSubCount = 0, initActiveCount = 0, initDoneCount = 0;
    for (const a of this.agents.values()) {
      if (a.parentSessionId) { initSubCount++; continue; }
      if (a.state === 'done') initDoneCount++; else initActiveCount++;
    }
    logInfo('initialize', `Initial scan complete — ${this.agents.size} sessions loaded (${initSubCount} subagents | ${initActiveCount} active, ${initDoneCount} done/hidden)`);
    void this.backgroundScanTitles();
    // Watch for ongoing changes. ignoreInitial: true since we already scanned above.
    // Use a SHALLOW glob (*/*.jsonl, not **/*.jsonl) so chokidar's internal readdirp
    // only scans one level deep — the top-level session directories. With 159+ archived
    // sessions each potentially containing subagent subdirectories, the recursive glob
    // causes readdirp to build directory-entry objects for thousands of paths, which OOMs
    // the extension host. Subagent directories are added explicitly by watchAndDiscoverSubagents
    // as parent sessions are processed, so the recursive glob is not needed.
    const projectsRoot = PROJECTS_ROOT.replace(/\\/g, '/');
    this.watcher = chokidar.watch(projectsRoot + '/*/*.jsonl', {
      ignoreInitial: true,
      persistent: true,
      // alwaysStat removed: it causes chokidar to issue an fs.stat for every
      // raw filesystem notification — one per line write during active sessions.
      // processFile does its own stat only after the debounce settles.
    });
    this.watcher
      .on('add',    (p) => {
        // Cancel any pending drop for this path (atomic-write rename sequence).
        // processFile internally handles batch-mode coalescing.
        const t = this.pendingDrops.get(p);
        if (t) { clearTimeout(t); this.pendingDrops.delete(p); }
        void this.processFile(p);
      })
      .on('change', (p) => {
        // Hot-path short-circuit: avoid the debounce machinery when we're going to
        // batch anyway. processFile would also coalesce, but this saves the timer churn.
        if (this.shouldBatch()) { this._pendingPaths.add(p); return; }
        // MaxWait debounce: trailing 500ms after writes settle, but forced to
        // fire within CHANGE_FORCE_FLUSH_MS so continuously-streaming transcripts
        // still get processed and transcript panels stay live.
        const existing = this.changeDebounce.get(p);
        if (existing) {
          clearTimeout(existing.timer);
        } else {
          this.changeDebounce.set(p, { timer: undefined as unknown as NodeJS.Timeout, firstAt: Date.now() });
        }
        const entry = this.changeDebounce.get(p)!;
        const elapsed = Date.now() - entry.firstAt;
        const remaining = Math.max(0, AgentService.CHANGE_FORCE_FLUSH_MS - elapsed);
        entry.timer = setTimeout(() => {
          this.changeDebounce.delete(p);
          void this.processFile(p);
        }, Math.min(500, remaining));
      })
      .on('unlink', (p)        => {
        // Defer removal to absorb atomic rename (unlink → add within ~500ms).
        const t = setTimeout(() => {
          this.pendingDrops.delete(p);
          this.dropFile(p);
        }, 500);
        this.pendingDrops.set(p, t);
      })
      .on('error',  (err)      => logError('watcher', err));
  }

  /**
   * Full reset: clears all in-memory state and re-runs the initial scan from
   * scratch. Used by the sidebar refresh button so the view is guaranteed to
   * reflect the current filesystem state with no stale entries.
   */
  async refresh(): Promise<void> {
    try {
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
      this.cancelDiscovery();
      this.clearTransientQueues();
      this.processFileInFlight.clear();
      this.processFileStartedAt.clear();
      this.processFileNextReadAt.clear();
      this.evictedSessions.clear();
      this.agents.clear();
      this.titleCache.clear();
      this._agentsWithSubagents.clear();
      this._subagentPollFailures.clear();
      this.watchedSubagentDirs.clear();
      this.watchedSubagentDirLastRead.clear();
      this._ready = false;
      if (this.watcher) { await this.watcher.close(); this.watcher = undefined; }
      await this.initialize();
      this.armDiscovery();
    } catch (err) { logError('refresh', err); }
  }

  /**
   * Processes only top-level session files not yet tracked. Intentionally shallow —
   * only scans PROJECT_DIR/*.jsonl, not subagent subdirectories. Subagent files are
   * discovered by scanPendingSubagentDirs (every tick) and watchAndDiscoverSubagents
   * (on parent file change). A recursive scan of all 3000+ sessions plus subagent
   * dirs on every 5-minute tick floods the libuv I/O pool on Windows.
   */
  private async discoverNewFiles(): Promise<void> {
    try {
      const t0 = Date.now();
      const newFiles = await findTopLevelJsonlFiles(PROJECTS_ROOT);
      const scanMs = Date.now() - t0;
      const missing = newFiles.filter(f => {
        const sid = sessionIdFromPath(f);
        return !this.agents.has(sid) && !this.evictedSessions.has(sid);
      });
      logInfo('discoverNewFiles', `scanned ${newFiles.length} files in ${scanMs}ms — ${missing.length} new`);
      if (missing.length > 0) {
        await Promise.all(missing.map(f => this.processFile(f)));
        this.scheduleEmit();
      }
    } catch (err) { logError('discoverNewFiles', err); }
  }

  /** Returns all known agents sorted by most-recently-modified first. */
  getAgents(): Agent[] {
    return Array.from(this.agents.values()).sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
  }

  /** O(1) lookup for a single agent by session ID. */
  getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  /**
   * Parses (or re-parses) a single transcript file and upserts the resulting
   * Agent into the in-memory map. Title scan runs once per session and is cached.
   * Runs through a concurrency gate to prevent I/O pool saturation.
   */
  private async processFile(filePath: string, stats?: fs.Stats, opts?: { bypassBatch?: boolean }): Promise<void> {
    if (this.processFileInFlight.has(filePath)) return;
    if (Date.now() < (this.processFileNextReadAt.get(filePath) ?? 0)) return;

    // Central batching gate: every caller honors batch mode, not just chokidar
    // handlers. The drain path passes bypassBatch:true so its calls actually run
    // (otherwise they'd just be re-added to _pendingPaths and the drain would loop).
    if (this.shouldBatch() && !opts?.bypassBatch) {
      this._pendingPaths.add(filePath);
      return;
    }

    if (this.processFileInFlight.size >= AgentService.MAX_CONCURRENT_PROCESS) {
      if (this.processFileWaiters.length >= AgentService.MAX_WAITER_QUEUE) {
        logInfo('processFile', `queue full (${AgentService.MAX_WAITER_QUEUE}) — dropping: ${path.basename(filePath)}`);
        return;
      }
      if (!this._initializing) logInfo('processFile', `queued (active=${this.processFileInFlight.size} waiting=${this.processFileWaiters.length}): ${path.basename(filePath)}`);
      await new Promise<void>(resolve => this.processFileWaiters.push(resolve));
    }
    this.processFileInFlight.add(filePath);
    this.processFileStartedAt.set(filePath, Date.now());
    const _ioT0 = Date.now();
    try {
      await this.processFileImpl(filePath, stats);
    } finally {
      const _ioMs = Date.now() - _ioT0;
      const cooldownMs = Math.max(AgentService.MIN_FILE_READ_COOLDOWN_MS, Math.min(_ioMs * 2, 5 * 60 * 1000));
      this.processFileNextReadAt.set(filePath, Date.now() + cooldownMs);
      if (_ioMs > 1_000) {
        logInfo('processFile', `slow I/O: ${_ioMs}ms for ${path.basename(filePath)} (next read in ${Math.round(cooldownMs / 1000)}s)`);
      }
      // Skip release if our slot was reclaimed by the stale-op sweep.
      if (this.processFileInFlight.has(filePath)) {
        this.processFileInFlight.delete(filePath);
        this.processFileStartedAt.delete(filePath);
        this.processFileWaiters.shift()?.();
      }
    }
  }

  /**
   * Scans in-flight processFile operations and reclaims slots for any stuck longer
   * than STALE_OPERATION_MS. The actual fsp.open/read continues on the libuv thread
   * (we can't cancel it), but we stop blocking our concurrency slot on it. When the
   * orphaned operation eventually completes, its finally{} block detects the slot
   * was reclaimed and exits without double-releasing.
   */
  private checkStaleOperations(): number {
    if (this.processFileStartedAt.size === 0) return 0;
    const now = Date.now();
    let reclaimed = 0;
    for (const [filePath, startedAt] of this.processFileStartedAt) {
      if (now - startedAt < AgentService.STALE_OPERATION_MS) continue;
      logInfo('checkStaleOperations', `reclaiming slot for ${path.basename(filePath)} stuck ${Math.round((now - startedAt) / 1000)}s`);
      this.processFileInFlight.delete(filePath);
      this.processFileStartedAt.delete(filePath);
      this.processFileWaiters.shift()?.();
      reclaimed++;
    }
    return reclaimed;
  }

  /**
   * Clears all transient queues: pending debounces, drop timers, waiters,
   * and batched paths. Does NOT touch the agents Map or title cache. Shared
   * between refresh(), flushQueue(), and dispose().
   */
  private clearTransientQueues(): { debounced: number; drops: number; waiters: number; pending: number } {
    const counts = {
      debounced: this.changeDebounce.size,
      drops: this.pendingDrops.size,
      waiters: this.processFileWaiters.length,
      pending: this._pendingPaths.size,
    };
    for (const { timer } of this.changeDebounce.values()) clearTimeout(timer);
    this.changeDebounce.clear();
    for (const t of this.pendingDrops.values()) clearTimeout(t);
    this.pendingDrops.clear();
    // Resolve waiters so their awaiting callers exit cleanly — they'll re-check
    // the cooldown on resume and skip if their file was just touched.
    while (this.processFileWaiters.length > 0) this.processFileWaiters.shift()?.();
    this._pendingPaths.clear();
    return counts;
  }

  /**
   * Manual clean-slate for the queue without a full agent refresh.
   * Reachable via the agentViewer.flushQueue command.
   */
  flushQueue(): void {
    const counts = this.clearTransientQueues();
    const stale = this.checkStaleOperations();
    logInfo('flushQueue', `cleared debounced=${counts.debounced} drops=${counts.drops} waiters=${counts.waiters} stale=${stale} pending=${counts.pending}`);
  }

  private async processFileImpl(filePath: string, stats?: fs.Stats): Promise<void> {
    const base = path.basename(filePath);
    try {
      const t0 = Date.now();
      const stat = stats ?? await fsp.stat(filePath);
      const statMs = Date.now() - t0;
      if (statMs > 500) logInfo('processFileImpl', `slow stat: ${statMs}ms for ${base}`);

      const sessionId = sessionIdFromPath(filePath);
      const doneAgeMs = this.getDoneAgeMs();
      const isArchive = Date.now() - stat.mtimeMs > doneAgeMs;
      // Capture in a local var before the scanFullFileForTitles await so a concurrent
      // refresh() clearing titleCache can't make the get() return undefined.
      let cached = this.titleCache.get(sessionId);
      if (!cached) {
        if (this._initializing && isArchive) {
          // During init, skip title scans for archive sessions — reading 32 KB from
          // thousands of old files is the dominant startup cost. backgroundScanTitles()
          // fills them in progressively after the sidebar first renders.
          cached = { customTitle: null, aiTitle: null, lastPrompt: null, firstUserPrompt: null };
          // Intentionally NOT stored in titleCache so backgroundScanTitles knows to scan it.
        } else {
          const tTitle = Date.now();
          cached = await scanFullFileForTitles(filePath);
          const titleMs = Date.now() - tTitle;
          if (titleMs > 500) logInfo('processFileImpl', `slow title scan: ${titleMs}ms for ${base}`);
          this.titleCache.set(sessionId, cached);
        }
      }
      // Skip re-processing if the file hasn't changed since we last read it.
      // State transitions (running → idle → done) happen in scheduleEmit via
      // classifyState(), so they still fire on the tick timer regardless.
      // mtime changes the instant the file is written, so this check is safe.
      const known = this.agents.get(sessionId);
      if (known && known.mtimeMs === stat.mtimeMs) {
        // Even on a no-op file read, still arm subagent watching. The parent file's
        // mtime doesn't change while a subagent is running (only on Agent tool_use /
        // tool_result events), so without this the watcher would never be registered
        // for subagent dirs that appear between those events.
        // Use the sticky set — agentCallDescs may be empty if the Agent tool_use has
        // scrolled past the TAIL_BYTES window, but we still need to watch.
        if (this._agentsWithSubagents.has(sessionId)) {
          void this.watchAndDiscoverSubagents(filePath, sessionId);
        }
        return;
      }
      const tTail = Date.now();
      const events = isArchive ? [] : await this.tailEvents(filePath, stat.size);
      const tailMs = Date.now() - tTail;
      if (tailMs > 500) logInfo('processFileImpl', `slow tail read: ${tailMs}ms for ${base} (size=${stat.size})`);

      const tBuild = Date.now();
      const agent = buildAgent(filePath, stat.mtimeMs, events, cached, doneAgeMs, this.getRunningWindowMs());
      const buildMs = Date.now() - tBuild;
      if (buildMs > 100) logInfo('processFileImpl', `slow buildAgent: ${buildMs}ms for ${base} (events=${events.length})`);
      // Sticky: once a session has ever had Agent tool_use calls, remember it permanently
      // so watchAndDiscoverSubagents keeps firing even after those events age out of the tail.
      if ((agent.agentCallDescs ?? []).length > 0) {
        this._agentsWithSubagents.add(sessionId);
      }
      if (known) {
        // In-place update: preserve the existing object reference so that parent
        // agents' subagents[] arrays keep pointing to the correct child objects
        // without needing a full buildTree rebuild on every file-content change.
        known.mtimeMs = agent.mtimeMs;
        known.state = agent.state;
        known.activityHistory = agent.activityHistory;
        known.model = agent.model;
        known.turnCount = agent.turnCount;
        known.contextPct = agent.contextPct;
        known.details = agent.details;
        known.agentCallDescs = agent.agentCallDescs;
      } else {
        this.agents.set(agent.sessionId, agent);
        this._structureChanged = true;
      }
      if (this._ready) this.scheduleEmit();
      if (this._agentsWithSubagents.has(sessionId)) {
        void this.watchAndDiscoverSubagents(filePath, sessionId);
      }
    } catch (err) {
      logError(`processFile(${filePath})`, err);
    }
  }

  /**
   * On every state tick, checks subagent dirs for active sessions where the dir
   * hasn't been confirmed yet. This handles the case where the parent file isn't
   * written while it waits for the subagent (so no chokidar 'change' events fire
   * for the parent during that window, and watchAndDiscoverSubagents is never
   * retriggered from the change path).
   *
   * Bypasses the readdir throttle in watchAndDiscoverSubagents — the filter to
   * non-done, unconfirmed dirs keeps the scan set small (typically 1-3 active
   * sessions), so there is no flooding risk.
   */
  private async scanPendingSubagentDirs(): Promise<void> {
    const pending: Array<{ sessionId: string; subagentDir: string }> = [];
    for (const sessionId of this._agentsWithSubagents) {
      const agent = this.agents.get(sessionId);
      if (!agent || agent.state === 'done') continue;
      const subagentDir = subagentDirPath(agent.transcriptPath, sessionId);
      if (this.watchedSubagentDirs.has(subagentDir)) {
        // Dir confirmed — re-scan for new files added since initial discovery.
        // chokidar's dynamically-added glob is unreliable on Windows, so new subagent
        // files in an existing dir won't fire 'add' events. watchAndDiscoverSubagents
        // rescans the dir but is throttled to SUBAGENT_READDIR_THROTTLE_MS so the
        // per-tick call here is cheap when nothing has changed.
        void this.watchAndDiscoverSubagents(agent.transcriptPath, sessionId);
        continue;
      }
      pending.push({ sessionId, subagentDir });
    }
    if (pending.length === 0) return;
    // Process in batches of MAX_CONCURRENT_PROCESS to avoid flooding the libuv I/O pool.
    for (let i = 0; i < pending.length; i += AgentService.MAX_CONCURRENT_PROCESS) {
      await Promise.all(pending.slice(i, i + AgentService.MAX_CONCURRENT_PROCESS).map(async ({ sessionId, subagentDir }) => {
        try {
          const files = await fsp.readdir(subagentDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
          // Only mark confirmed once a .jsonl file actually exists. An empty dir means
          // the subagent process hasn't written yet — keep polling. Marking it confirmed
          // on an empty readdir would permanently skip it (the has() guard above), leaving
          // discovery solely to chokidar's unreliable dynamic glob on Windows.
          if (jsonlFiles.length === 0) {
            // Count consecutive empty polls. After giveup threshold, stop scanning this
            // dir to avoid wasteful I/O for sessions where the subagent dir was created
            // but no file ever appeared (crashed subagent, early exit, etc.).
            const fails = (this._subagentPollFailures.get(subagentDir) ?? 0) + 1;
            if (fails >= AgentService.SUBAGENT_POLL_GIVEUP_COUNT) {
              logInfo('scanPendingSubagentDirs', `giving up on empty dir after ${fails} polls: ${subagentDir}`);
              this._agentsWithSubagents.delete(sessionId);
              this._subagentPollFailures.delete(subagentDir);
            } else {
              this._subagentPollFailures.set(subagentDir, fails);
            }
            return;
          }
          this._subagentPollFailures.delete(subagentDir);
          this.watchedSubagentDirs.add(subagentDir);
          if (this.watcher) this.watcher.add(subagentDir + '/*.jsonl');
          const newFiles = jsonlFiles
            .map(f => subagentDir + '/' + f)
            .filter(f => !this.agents.has(sessionIdFromPath(f)));
          if (newFiles.length > 0) {
            for (const f of newFiles) await this.processFile(f);
            this.scheduleEmit();
          }
        } catch { /* dir doesn't exist yet — normal */ }
      }));
    }
  }

  /**
   * Proactively watches a parent agent's subagent directory and processes any
   * subagent files not yet tracked. Called on every parent file update that
   * contains Agent tool calls, and also from the periodic tick for sessions
   * whose subagent dir has not yet been confirmed.
   *
   * watcher.add() is deduplicated via watchedSubagentDirs. The readdir is
   * throttled to once per SUBAGENT_READDIR_THROTTLE_MS per directory — chokidar
   * 'add' events handle real-time discovery, and readdir is only a backstop for
   * Windows unreliability with dynamically-added globs.
   */
  private async watchAndDiscoverSubagents(parentFilePath: string, sessionId: string): Promise<void> {
    const subagentDir = subagentDirPath(parentFilePath, sessionId);

    // Throttle readdir — with 500+ active sessions each firing a change-debounce every
    // 500ms, running readdir on every call saturates the libuv I/O thread pool.
    // chokidar 'add' events handle new files in real-time; readdir is only a backstop
    // for Windows reliability, so running it every 10s per directory is sufficient.
    const lastRead = this.watchedSubagentDirLastRead.get(subagentDir) ?? 0;
    if (Date.now() - lastRead < AgentService.SUBAGENT_READDIR_THROTTLE_MS) return;
    this.watchedSubagentDirLastRead.set(subagentDir, Date.now());

    try {
      const files = await fsp.readdir(subagentDir);
      // Dir confirmed to exist — register with chokidar once so new files fire 'add' events.
      // watcher.add is deferred until here rather than called speculatively on every invoke:
      // chokidar does not reliably watch a glob pointing at a non-existent directory, so
      // calling it before the dir exists would silently miss all subsequent file creations.
      if (!this.watchedSubagentDirs.has(subagentDir)) {
        this.watchedSubagentDirs.add(subagentDir);
        if (this.watcher) this.watcher.add(subagentDir + '/*.jsonl');
      }
      const newFiles = files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => subagentDir + '/' + f)
        .filter(f => !this.agents.has(sessionIdFromPath(f)));
      if (newFiles.length > 0) {
        // Serial so multiple new subagent files don't all grab concurrency slots at once.
        for (const f of newFiles) await this.processFile(f);
        this.scheduleEmit();
      }
    } catch {
      // Directory doesn't exist yet — normal if subagents haven't been spawned yet.
    }
  }

  /**
   * Removes a session from in-memory state, releasing all per-session tracking.
   * Records it in evictedSessions (bounded) so discoverNewFiles doesn't immediately
   * re-add it on the next 5-min tick.
   */
  private evictSession(sessionId: string, transcriptPath: string): void {
    this.pruneSubagentState(sessionId);
    this.agents.delete(sessionId);
    this.titleCache.delete(sessionId);
    this.processFileNextReadAt.delete(transcriptPath);
    this.processFileInFlight.delete(transcriptPath);
    this.processFileStartedAt.delete(transcriptPath);
    // Cap evictedSessions at a sane size — drop oldest entries via insertion-order
    // iteration. A session evicted long ago becoming "rediscovered" is harmless;
    // unbounded growth is not.
    if (this.evictedSessions.size >= AgentService.MAX_EVICTED_SESSIONS) {
      const oldest = this.evictedSessions.values().next().value;
      if (oldest) this.evictedSessions.delete(oldest);
    }
    this.evictedSessions.add(sessionId);
  }

  /** Removes a deleted transcript file's agent and title cache entries, then fires onDidDrop. */
  private dropFile(filePath: string): void {
    // Cancel any pending change-debounce so processFile doesn't run on a deleted file.
    const pending = this.changeDebounce.get(filePath);
    if (pending) { clearTimeout(pending.timer); this.changeDebounce.delete(filePath); }
    const sessionId = sessionIdFromPath(filePath);
    this.titleCache.delete(sessionId);
    this.pruneSubagentState(sessionId);
    if (this.agents.delete(sessionId)) {
      this._structureChanged = true;
      this._onDidDrop.fire(sessionId);
      this.scheduleEmit();
    }
  }

  /** Releases all subagent tracking state for a session going done/dropped. */
  private pruneSubagentState(sessionId: string): void {
    this._agentsWithSubagents.delete(sessionId);
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    const subDir = subagentDirPath(agent.transcriptPath, sessionId);
    this.watchedSubagentDirs.delete(subDir);
    this.watchedSubagentDirLastRead.delete(subDir);
    this._subagentPollFailures.delete(subDir);
    // Unwatch the subagent dir glob. Individual file watchers are NOT added (the dir
    // glob covers all *.jsonl files), so there is nothing else to unwatch here.
    // Do NOT unwatch agent.transcriptPath — top-level sessions are covered by the
    // initial shallow glob and unwatching stops events for sessions that later
    // become active again.
    if (this.watcher) this.watcher.unwatch(subDir + '/*.jsonl');
  }

  /**
   * Reads the last TAIL_BYTES of the file to extract the most recent JSONL events
   * without loading the entire (potentially large) transcript into memory.
   */
  private async tailEvents(filePath: string, size: number): Promise<RawEvent[]> {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const text = await readFileSlice(filePath, tailStart, size - tailStart);
    const lines = text.split('\n');
    if (tailStart > 0) lines.shift(); // drop partial first line
    const events: RawEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      try { events.push(JSON.parse(line) as RawEvent); } catch { /* skip */ }
    }
    return events;
  }

  /**
   * Schedules a state-reclassification pass and, if anything changed, fires onDidChange.
   *
   * Three reasons:
   *   'change'     — a file was processed; buildTree + assignTaskDescriptions run.
   *                  Throttled to MIN_CHANGE_EMIT_MS and resets the cooldown clock.
   *   'tick'       — only time-based state transitions are possible; suppressed when none occur.
   *   'background' — archive title updates applied in-place; fires onDidChange without
   *                  touching _lastChangeEmitMs so live-change cooldown is not disrupted.
   */
  private scheduleEmit(reason: 'tick' | 'change' | 'background' = 'change'): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // Throttle change emits: delay until MIN_CHANGE_EMIT_MS has elapsed since the last one.
    const cooldown = this._lastChangeEmitMs + AgentService.MIN_CHANGE_EMIT_MS - Date.now();
    const delay = reason === 'change' && cooldown > DEBOUNCE_MS ? cooldown : DEBOUNCE_MS;
    this.debounceTimer = setTimeout(() => {
      const now = Date.now();
      const doneAgeMs = this.getDoneAgeMs();
      const runningWindowMs = this.getRunningWindowMs();
      let anyChanged = false;
      const transitions: string[] = [];
      for (const agent of this.agents.values()) {
        const hasActiveSubagent = agent.subagents.some(s => s.state === 'running');
        const nextState = classifyState(agent.mtimeMs, now, agent.state === 'done', hasActiveSubagent, doneAgeMs, runningWindowMs);
        if (nextState !== agent.state) {
          transitions.push(`${agent.sessionId.slice(0, 8)}: ${agent.state}→${nextState}`);
          agent.state = nextState; // mutate in place — subagents[] refs stay valid, no tree rebuild needed
          anyChanged = true;
          // A done session will never spawn new subagents — release its tracking state
          // so scanPendingSubagentDirs stops probing its dirs every 5 seconds.
          if (nextState === 'done') this.pruneSubagentState(agent.sessionId);
        }
      }
      if (transitions.length) logInfo('tick', `${transitions.length} transition(s): ${transitions.join(', ')}`);

      // Evict done top-level sessions older than 10× doneAgeMs. Only runs on tick
      // (eligibility only changes on the hour-scale). At default doneAge of 1h, this
      // keeps ~10 hours of history in memory.
      if (reason === 'tick') {
        let evictCount = 0;
        for (const [sid, agent] of this.agents) {
          if (agent.state !== 'done' || agent.parentSessionId) continue;
          if (now - agent.mtimeMs <= doneAgeMs * 10) continue;
          for (const sub of agent.subagents) this.evictSession(sub.sessionId, sub.transcriptPath);
          this.evictSession(sid, agent.transcriptPath);
          evictCount++;
        }
        if (evictCount > 0) {
          logInfo('evict', `evicted ${evictCount} done sessions (>10× doneAge) from memory; remaining=${this.agents.size}`);
          buildTree(this.agents);
          assignTaskDescriptions(this.agents); // buildTree without assignTaskDescriptions leaves taskDescription stale
          this._structureChanged = false;
          anyChanged = true;
        }
      }

      // Heartbeat every ~5 min so we can distinguish "quiet (all done)" from a true hang.
      if (reason === 'tick' && ++this._tickCount % 60 === 0) {
        const watchedPaths = this.watcher ? Object.keys((this.watcher as unknown as { _watched: Record<string, unknown> })._watched ?? {}).length : -1;
        const mem = process.memoryUsage();
        logInfo('heartbeat', `tick=${this._tickCount} agents=${this.agents.size} ready=${this._ready} processFileActive=${this.processFileInFlight.size} waiters=${this.processFileWaiters.length} withSubagents=${this._agentsWithSubagents.size} watchedSubDirs=${this.watchedSubagentDirs.size} watcherPaths=${watchedPaths} rss=${Math.round(mem.rss/1024/1024)}MB heap=${Math.round(mem.heapUsed/1024/1024)}MB`);
      }
      if (reason === 'change' || reason === 'background' || anyChanged) {
        let treeMs = 0;
        if (reason === 'change') {
          const t0 = Date.now();
          // buildTree only needed when agents were added/removed (new subagent file, deletion).
          // Content-only updates use in-place field mutation in processFileImpl, so subagents[]
          // refs stay valid without a full two-pass rebuild over all 3800+ agents.
          if (this._structureChanged) {
            buildTree(this.agents);
            this._structureChanged = false;
          }
          assignTaskDescriptions(this.agents);
          treeMs = Date.now() - t0;
          this._lastChangeEmitMs = Date.now();
        }
        let subCount = 0;
        for (const a of this.agents.values()) { if (a.parentSessionId) subCount++; }
        logInfo('emit', `agents=${this.agents.size} subagents=${subCount} treeMs=${treeMs}ms reason=${reason}`);
        this._onDidChange.fire(this.getAgents());
      }
      const emitMs = Date.now() - now;
      if (emitMs > 200) logInfo('scheduleEmit', `slow callback: ${emitMs}ms for ${this.agents.size} agents reason=${reason}`);
    }, delay);
  }

  /**
   * Progressively scans title fields for archive sessions whose title reads were
   * deferred during initialize() to keep startup fast. Runs 4 concurrent readers
   * and yields to the event loop after each file so live file-change events
   * are never starved. Uses 'background' emit reason to avoid resetting the
   * live-change cooldown clock.
   */
  private async backgroundScanTitles(): Promise<void> {
    const agents = [...this.agents.values()].filter(a => !this.titleCache.has(a.sessionId));
    if (agents.length === 0) return;
    logInfo('backgroundScanTitles', `scanning ${agents.length} deferred archive titles`);

    let scanned = 0;
    let skipped = 0;
    let updated = 0;

    for (const agent of agents) {
      // Skip sessions evicted from memory since this scan started (tick-based
      // eviction can remove thousands of old sessions before we finish scanning).
      if (!this.agents.has(agent.sessionId)) { skipped++; continue; }
      if (this.titleCache.has(agent.sessionId)) { skipped++; continue; }
      const cached = await scanFullFileForTitles(agent.transcriptPath);
      this.titleCache.set(agent.sessionId, cached);
      agent.details.customTitle = cached.customTitle ?? agent.details.customTitle;
      agent.details.aiTitle = cached.aiTitle ?? agent.details.aiTitle;
      agent.details.lastPrompt = cached.lastPrompt ?? agent.details.lastPrompt;
      agent.details.latestUserPrompt = agent.details.latestUserPrompt ?? cached.firstUserPrompt;
      scanned++;
      updated++;
      if (updated % 200 === 0) this.scheduleEmit('background');
      // Yield between reads so background scans don't monopolize the libuv pool.
      await new Promise<void>(r => setTimeout(r, 10));
    }

    if (updated > 0) this.scheduleEmit('background');
    logInfo('backgroundScanTitles', `scanned ${scanned} archive titles (${skipped} skipped/evicted)`);
  }

  /** Stops all timers and the file watcher. Call on extension deactivation. */
  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this._focusDebounceTimer) clearTimeout(this._focusDebounceTimer);
    if (this._batchTimer) clearInterval(this._batchTimer);
    this.cancelDiscovery();
    this.clearTransientQueues();
    this.watcher?.close();
    this._onDidChange.dispose();
    this._onDidDrop.dispose();
  }
}

/** Builds the subagent directory path for a session from its transcript file path. */
function subagentDirPath(transcriptPath: string, sessionId: string): string {
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents').replace(/\\/g, '/');
}

/** Returns all .jsonl file paths under rootDir at any depth. Throws if rootDir is unreadable. */
async function findJsonlFiles(rootDir: string): Promise<string[]> {
  const entries = await fsp.readdir(rootDir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => {
      // Node 20+ uses `parentPath`; older versions used `path`. Support both.
      const dirent = e as fs.Dirent & { parentPath?: string; path?: string };
      return path.join(dirent.parentPath ?? dirent.path ?? '', e.name);
    });
}

/**
 * Shallow variant used by discoverNewFiles: only returns PROJECT_DIR/*.jsonl
 * (top-level session files), not subagent files deeper in the tree. Two-level
 * readdir instead of recursive — avoids reading tens of thousands of entries
 * from the full session + subagent tree on every 5-minute discovery run.
 */
async function findTopLevelJsonlFiles(rootDir: string): Promise<string[]> {
  const projectDirs = await fsp.readdir(rootDir, { withFileTypes: true });
  const dirs = projectDirs.filter(d => d.isDirectory());
  const results: string[] = [];
  // Batched readdirs — not Promise.all over all dirs. With 3000+ project directories,
  // firing 3000 concurrent readdirs floods the libuv I/O thread pool and creates a
  // massive microtask queue that can block the event loop for seconds when they all
  // resolve simultaneously.
  const BATCH = 50;
  for (let i = 0; i < dirs.length; i += BATCH) {
    await Promise.all(dirs.slice(i, i + BATCH).map(async d => {
      const dirPath = path.join(rootDir, d.name);
      try {
        const files = await fsp.readdir(dirPath);
        for (const f of files) {
          if (f.endsWith('.jsonl')) results.push(path.join(dirPath, f));
        }
      } catch { /* skip unreadable dirs */ }
    }));
  }
  return results;
}

function buildAgent(filePath: string, mtimeMs: number, events: RawEvent[], titles: TitleCache, doneAgeMs = DEFAULT_DONE_AGE_MS, runningWindowMs = DEFAULT_RUNNING_WINDOW_MS): Agent {
  const sessionId = sessionIdFromPath(filePath);
  const cwd = resolveCwd(filePath, events);
  const projectName = path.basename(cwd);
  const terminated = events.some(isTerminator);
  const state = classifyState(mtimeMs, Date.now(), terminated, false, doneAgeMs, runningWindowMs);
  const activityHistory = buildActivityHistory(events, state);
  const { details, agentCallDescs, meta } = extractDetails(events);
  // Merge cached title/prompt values (scanned once from whole file) with tail-derived details.
  // Cached values win for titles since they were collected from the complete file.
  details.customTitle = titles.customTitle ?? details.customTitle;
  details.aiTitle = titles.aiTitle ?? details.aiTitle;
  details.lastPrompt = titles.lastPrompt ?? details.lastPrompt;
  details.latestUserPrompt = details.latestUserPrompt ?? titles.firstUserPrompt;
  // Set at construction time so the agent is never briefly at root before buildTree runs.
  const parentSessionId = parentSessionIdFromPath(filePath);
  return {
    sessionId,
    transcriptPath: filePath,
    parentSessionId,
    cwd,
    projectName,
    state,
    activityHistory,
    model: meta.model,
    turnCount: meta.turnCount,
    contextPct: meta.contextPct,
    mtimeMs,
    details,
    subagents: [],
    agentCallDescs,
  };
}

/**
 * Scans the first TITLE_HEAD_BYTES of a transcript file for session name fields.
 * Custom/AI titles and the first user prompt all appear within the opening
 * events of a session, so reading the full file was wasteful — the head is enough
 * for virtually all sessions, keeping first-discovery cost to a single small read.
 * Called once per session; result is cached for the session's lifetime.
 */
async function scanFullFileForTitles(filePath: string): Promise<TitleCache> {
  const out: TitleCache = { customTitle: null, aiTitle: null, lastPrompt: null, firstUserPrompt: null };
  try {
    const text = await readFileSlice(filePath, 0, TITLE_HEAD_BYTES);
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (!/"(custom-title|ai-title|last-prompt|user)"/.test(line)) continue;
      try {
        const evt = JSON.parse(line) as RawEvent;
        const t = typeof evt.type === 'string' ? evt.type : '';
        if (t === 'custom-title' && typeof evt.customTitle === 'string' && evt.customTitle) {
          out.customTitle = evt.customTitle;
        } else if (t === 'ai-title' && typeof evt.aiTitle === 'string' && evt.aiTitle) {
          out.aiTitle = evt.aiTitle;
        } else if (t === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt) {
          out.lastPrompt = truncate(evt.lastPrompt as string, 200);
        } else if (t === 'user' && out.firstUserPrompt == null) {
          const userText = extractUserText(evt.message?.content);
          if (userText) out.firstUserPrompt = truncate(userText, 200);
        }
      } catch { /* skip malformed line */ }
      if (out.customTitle && out.aiTitle && out.lastPrompt && out.firstUserPrompt) break;
    }
  } catch (err) { logError(`scanFullFileForTitles(${filePath})`, err); }
  return out;
}

/**
 * Matches each parent agent's Agent tool_use call descriptions to its subagents
 * (ordered by mtime) so the sidebar can show a meaningful task label per subagent.
 */
function assignTaskDescriptions(agents: Map<string, Agent>): void {
  for (const parent of agents.values()) {
    if (!parent.subagents.length) continue;
    const descs = parent.agentCallDescs ?? [];
    const sorted = [...parent.subagents].sort((a, b) => a.mtimeMs - b.mtimeMs);
    sorted.forEach((sub, i) => {
      if (!sub.taskDescription) {
        sub.taskDescription = descs[i]
          ?? sub.details.latestUserPrompt
          ?? sub.sessionId.slice(0, 8);
      }
    });
  }
}

/** Exported only for unit testing. */
export const assignTaskDescriptionsForTesting = assignTaskDescriptions;

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveCwd(filePath: string, events: RawEvent[]): string {
  for (const evt of events) {
    if (typeof evt.cwd === 'string' && evt.cwd.length > 0) return normalizeCwd(evt.cwd);
  }
  // Fallback: decode dir name. Encoding is lossy (dashes → slashes), so this
  // is a best effort only when events lack a cwd field.
  const dir = path.basename(path.dirname(filePath));
  const raw = dir.startsWith('-') ? dir.replace(/-/g, '/') : dir;
  return normalizeCwd(raw);
}

function normalizeCwd(p: string): string {
  // BEL () in cwd strings comes from Claude Code serializing  in a Windows path
  // as \u0007 in JSON, which consumes the backslash+a. Restore  first, then strip
  // remaining control chars, normalize to forward slashes, uppercase drive letter.
  return p
    .replace(/\x07/g, '\\a')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/, d => d.toUpperCase());
}

/** Determines an agent's state from its mtime age, termination flag, and subagent activity. */
function classifyState(mtimeMs: number, now: number, terminated: boolean, hasActiveSubagent = false, doneAgeMs = DEFAULT_DONE_AGE_MS, runningWindowMs = DEFAULT_RUNNING_WINDOW_MS): AgentState {
  if (terminated) return 'done';
  const age = now - mtimeMs;
  if (age < runningWindowMs || hasActiveSubagent) return 'running';
  if (age > doneAgeMs) return 'done';
  return 'idle';
}

function isTerminator(evt: RawEvent): boolean {
  // Claude Code writes a 'summary' entry when a session wraps up.
  return evt.type === 'summary';
}

/** Produces a short human-readable activity string from the most recent meaningful event. */
function deriveActivity(events: RawEvent[], state: AgentState): string {
  if (state === 'done') return 'Session ended';
  const meaningful = [...events].reverse().find((e) => !isNoise(e));
  if (!meaningful) return state === 'running' ? 'Working…' : 'Idle';
  const label = labelFromEvent(meaningful);
  return label ?? (state === 'running' ? 'Working…' : 'Idle');
}

/**
 * Collects the last ≤3 meaningful events from tail events as an activity history,
 * newest first. Uses the same event-labelling logic as deriveActivity.
 */
function buildActivityHistory(events: RawEvent[], state: AgentState): ToolCallSummary[] {
  if (state === 'done') return [{ summary: 'Session ended', at: 0 }];
  const history: ToolCallSummary[] = [];
  for (let i = events.length - 1; i >= 0 && history.length < 3; i--) {
    const evt = events[i];
    if (isNoise(evt)) continue;
    const label = labelFromEvent(evt);
    if (!label) continue;
    const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
    history.push({ summary: label, at: ts });
  }
  if (history.length === 0) {
    history.push({ summary: state === 'running' ? 'Working…' : 'Idle', at: 0 });
  }
  return history;
}

/** Exported only for unit testing. */
export const buildActivityHistoryForTesting = buildActivityHistory;

/** Context window size for all current Claude models (200k tokens). */
const CONTEXT_WINDOW = 200_000;

interface SessionMeta {
  model: string;
  turnCount: number;
  contextPct: number;
}

function isNoise(evt: RawEvent): boolean {
  const t = typeof evt.type === 'string' ? evt.type : '';
  return t === 'queue-operation';
}

function labelFromEvent(evt: RawEvent): string | null {
  const type = typeof evt.type === 'string' ? evt.type : '';
  const content = evt.message?.content;
  if (type === 'assistant' && Array.isArray(content)) {
    const toolUse = content.find(isToolUse);
    if (toolUse?.name) return labelForToolUse(toolUse.name, toolUse.input);
    if (content.some(isTextPart)) return 'Thinking';
  }
  if (type === 'user') {
    if (Array.isArray(content) && content.some(isPartOfType('tool_result'))) {
      return 'Processing tool result';
    }
    return 'Awaiting response';
  }
  if (type === 'summary') return 'Session ended';
  return null;
}

function isPartOfType(kind: string): (part: unknown) => boolean {
  return (part) =>
    typeof part === 'object' && part !== null && (part as { type?: string }).type === kind;
}

function labelForToolUse(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return `Running ${name}`;
  switch (name) {
    case 'Bash':
      if (typeof input.command === 'string') return `Bash: ${truncate(input.command, 40)}`;
      break;
    case 'Edit':
    case 'Write':
      if (typeof input.file_path === 'string') return `${name} ${path.basename(input.file_path)}`;
      break;
    case 'Read':
      if (typeof input.file_path === 'string') return `Reading ${path.basename(input.file_path)}`;
      break;
    case 'Grep':
      if (typeof input.pattern === 'string') return `Grep: ${truncate(input.pattern, 40)}`;
      break;
    case 'Glob':
      if (typeof input.pattern === 'string') return `Glob: ${truncate(input.pattern, 40)}`;
      break;
    case 'Agent':
      if (typeof input.description === 'string') return `Subagent: ${truncate(input.description, 40)}`;
      break;
  }
  return `Running ${name}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const MAX_TRAIL = 5;
const MAX_FILES = 5;

/**
 * Single-pass extraction of sidebar details and session metadata from tail events.
 * Merges what were previously two separate iterations (extractDetails + extractSessionMeta)
 * since both iterate the same events array in forward order.
 */
function extractDetails(events: RawEvent[]): { details: AgentDetails; agentCallDescs: string[]; meta: SessionMeta } {
  const trail: ToolCallSummary[] = [];
  const files: string[] = [];
  let latestUserPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let subagentCount = 0;
  const agentCallDescs: string[] = [];
  let model = '';
  let turnCount = 0;
  let lastInputTokens = 0;

  for (const evt of events) {
    const type = typeof evt.type === 'string' ? evt.type : '';
    const content = evt.message?.content;

    if (type === 'assistant') {
      turnCount++;
      const msg = evt.message;
      if (msg) {
        // Strip "claude-" prefix for compact display, e.g. "claude-sonnet-4-6" → "sonnet-4-6"
        if (typeof msg.model === 'string' && msg.model) model = msg.model.replace(/^claude-/, '');
        if (typeof msg.usage?.input_tokens === 'number') lastInputTokens = msg.usage.input_tokens;
      }
      if (Array.isArray(content)) {
        const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) || 0 : 0;
        for (const part of content) {
          if (!isToolUse(part)) continue;
          const name = typeof part.name === 'string' ? part.name : 'Tool';
          trail.push({ summary: labelForToolUse(name, part.input), at: ts });
          const filePath = part.input?.file_path;
          if (typeof filePath === 'string') files.push(filePath);
          if (name === 'Agent') {
            subagentCount += 1;
            if (typeof part.input?.description === 'string' && part.input.description) {
              agentCallDescs.push(part.input.description);
            }
          }
        }
      }
    }

    if (type === 'user') {
      const text = extractUserText(content);
      if (text) latestUserPrompt = truncate(text, 200);
    }

    if (type === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt) {
      lastPrompt = truncate(evt.lastPrompt as string, 200);
    }
    if (type === 'custom-title' && typeof evt.customTitle === 'string' && evt.customTitle) {
      customTitle = evt.customTitle as string;
    }
    if (type === 'ai-title' && typeof evt.aiTitle === 'string' && evt.aiTitle) {
      aiTitle = evt.aiTitle as string;
    }
  }

  const contextPct = lastInputTokens > 0
    ? Math.round((lastInputTokens / CONTEXT_WINDOW) * 100)
    : 0;

  return {
    details: {
      recentToolCalls: trail.slice(-MAX_TRAIL).reverse(),
      recentFiles: dedupeLastN(files, MAX_FILES),
      latestUserPrompt,
      lastPrompt,
      customTitle,
      aiTitle,
      subagentCount,
    },
    agentCallDescs,
    meta: { model, turnCount, contextPct },
  };
}

/** Exported only for unit testing. */
export function extractSessionMetaForTesting(events: RawEvent[]): SessionMeta {
  return extractDetails(events).meta;
}

function isToolUse(
  part: unknown,
): part is { type: 'tool_use'; name?: string; input?: Record<string, unknown> } {
  return isPartOfType('tool_use')(part);
}

function isTextPart(part: unknown): part is { type: 'text'; text?: string } {
  return isPartOfType('text')(part);
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  // Last non-empty text part wins — matches the behavior the UI cares about
  // (most recent prompt in a multi-part user message).
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (isTextPart(part) && typeof part.text === 'string' && part.text.trim()) {
      return part.text.trim();
    }
  }
  return '';
}

function dedupeLastN(items: string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < n; i--) {
    const v = items[i];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
