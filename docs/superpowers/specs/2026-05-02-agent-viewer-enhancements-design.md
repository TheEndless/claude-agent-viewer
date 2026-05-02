# Agent Viewer Enhancement Design

**Date:** 2026-05-02  
**Branch:** feature/agent-viewer-enhancements  
**Status:** Approved

## Overview

Seven focused improvements to the Agent Viewer VS Code extension, grouped into two themes: making the sidebar feel solid and informative, and making the transcript panel more useful as a reading and reference tool.

---

## 1. Render Loop Stability

**Problem:** The sidebar does a full `innerHTML` rebuild on every update cycle (~5s), causing cards to flicker, expand/collapse state to reset, and scroll position to be lost.

**Solution:** Switch to incremental DOM diffing keyed by `sessionId`.

- On each `render` message from `postAgents()`, diff the incoming agent list against the current DOM state
- Cards are added, removed, or patched in-place — never wholesale replaced
- Expand/collapse state, scroll position, and hover states are DOM-local and never touched by the diff
- CSS transitions on status dot color changes and activity text swaps instead of hard repaints

**Scope:** `webviewProvider.ts` JS only. No changes to `agentService` or `agentTree`.

---

## 2. Subagent Status Accuracy

**Problem:** The subagent toggle button always shows a single green pulsing dot regardless of actual subagent states (idle, done, etc.).

**Solution:** Replace the single `sub-active-dot` with a row of small state dots.

- A `rollupSubagentDots(subagents)` helper computes counts per state (running/idle/done)
- Renders only dots for states with at least one member (e.g., 1 green + 2 gray, no yellow if none idle)
- Dot colors: green (running), yellow (idle), gray (done) — matching existing status dot palette
- Parent card's own status dot is unchanged; it is already correctly driven by `agentService.parentEffectiveState()`

**Scope:** `webviewProvider.ts` JS — `renderCard()` and a new `rollupSubagentDots()` helper.

---

## 3. Activity Timeline + Stuck Detection

**Problem:** The `activity` field is computed by `agentService` but never shown on the card. There is no way to tell if an agent is making progress, looping, or stalled.

**Solution:** Surface a recency-weighted activity timeline on each card, with inline stuck badges.

### Timeline

- New `activityHistory: Array<{ label: string; mtimeMs: number }>` field on `Agent` (last 3 entries, newest first), replacing the single `activity: string`
- Rendered as a compact stack between the path block and the sub-toggle row
- **Recency-weighted display:** always show the most recent entry; fill 2nd and 3rd slots only if they occurred within 2 minutes of the most recent entry. Older entries are omitted.
- Visual treatment: current entry in blue at full opacity, older entries in muted gray at 55% / 32% opacity

### Stuck detection

Two inline badges rendered below the timeline when heuristics fire:

| Badge | Trigger | Color |
|-------|---------|-------|
| `⟳ Possibly looping — same command 3×` | Same `label` appears 3 consecutive times in `activityHistory` | Orange |
| `⏱ No new activity for Nm` | Newest `activityHistory` entry is 8+ min old while `state === 'running'` | Blue/purple |

Both badges are computed in the webview JS from `activityHistory` — no additional `agentService` logic required beyond emitting the history array.

**Scope:** `agentService.ts` (emit `activityHistory` array), `webviewProvider.ts` (render timeline + badges).

---

## 4. Context & Intelligence Meta-bar

**Problem:** Useful per-session metadata (model, turn count, context usage) is in the JSONL but never surfaced.

**Solution:** A persistent single-line meta-bar on each card, always visible below the path block.

**Contents (left to right):**
- `⚡ <model-short-name>` chip — e.g., `sonnet-4-6`, `opus-4-7` (strip `claude-` prefix)
- Turn count — e.g., `34 turns`
- Context window fill bar — a narrow 40px bar + percentage label, e.g. `62%`

**Data extraction:** `agentService` extracts from the JSONL `usage` fields:
- Model: from the `model` field on assistant turns
- Turn count: count of `human`/`assistant` message pairs
- Context %: derived from `usage.input_tokens` on the most recent assistant turn divided by the model's context window size, looked up from a static model→window map (e.g. sonnet-4-6 → 200k). `input_tokens` on the latest turn approximates current context usage since it includes the full conversation history compressed into the prompt. Verify exact field names against actual JSONL during implementation.

**Scope:** `agentService.ts` (extract and serialize meta fields), `webviewProvider.ts` (render meta-bar).

---

## 5. Project Grouping

**Problem:** The flat card list mixes sessions from different projects, making it hard to see "everything happening in project X" at a glance.

**Solution:** Two-level sidebar structure: project group headers containing their sessions.

### Group header
- Label: last 2 path segments of `cwd`, e.g. `CBS / understudy`. For single-segment paths (e.g. `C:\understudy`), show just that segment.
- State badge: `N running`, `N idle`, or `N done` — reflects the worst active state across sessions in the group
- Collapse/expand chevron; expand state persisted in `openSections` map (same as subagent toggles)

### Sorting & default state
- **Active projects** (any session `running` or `idle`): expanded by default, sorted to top by most-recent `mtimeMs`
- **Inactive projects** (all sessions `done`): collapsed by default, slightly dimmed, sorted below active projects

### Archive removal
The existing flat archive section is removed. Done sessions live within their project group (collapsed by default). This eliminates the current hard split between "live" and "archived" sessions.

**Scope:** `webviewProvider.ts` — new `groupByProject()` helper, updated `render()` and `renderArchive()` → `renderProjectGroup()`.

---

## 6. Filter Bar

**Problem:** With many sessions across projects, finding a specific agent requires manual scrolling.

**Solution:** A small text input pinned above the project groups.

- Filters visible cards in real-time by agent name, `cwd`, or current activity label (case-insensitive substring match)
- Project groups with no matching cards are fully hidden (not just dimmed)
- Clears on Escape; input loses focus on clear
- Implemented entirely in webview JS — no backend changes

**Scope:** `webviewProvider.ts` — filter input HTML + `applyFilter()` JS function.

---

## 7. Transcript Panel Improvements

Four additive features to the existing `transcriptPanel.ts` webview:

### Copy turn
- A clipboard icon button on each assistant turn (visible on hover)
- Copies the turn's markdown text to clipboard via `navigator.clipboard.writeText()`
- No backend involvement

### Search
- `Ctrl+F` triggers a search input in the panel toolbar
- Highlights turns containing the search string; scrolls to first match
- Escape clears search and removes highlights
- Implemented in panel webview JS

### Jump to latest
- A "↓ Latest" button in the panel toolbar
- Scrolls to the bottom of the transcript (the oldest content, since panel renders newest-first)
- Only shown when the user has scrolled up from the bottom

### Export as markdown
- A "Export" button in the panel toolbar
- Posts an `exportMarkdown` message to the extension host
- `transcriptPanel.ts` handles it: formats turns as markdown and calls `vscode.window.showSaveDialog()` then `fsp.writeFile()`

**Scope:** `transcriptPanel.ts` (export handler, toolbar rendering), panel webview JS (copy, search, jump).

---

## Data Flow Summary

```
agentService.ts
  └─ extracts: activityHistory[], model, turnCount, contextPct
  └─ emits via onDidChange → postAgents() serializes to webview

webviewProvider.ts (webview JS)
  └─ render() → groupByProject() → renderProjectGroup() → renderCard()
  └─ renderCard() renders: meta-bar, timeline, stuck badges, subagent dots
  └─ applyFilter() filters project groups and cards
  └─ incremental DOM diff preserves expand/scroll state

transcriptPanel.ts
  └─ toolbar: search, jump-to-latest, export buttons
  └─ per-turn: copy button
  └─ export handler: markdown formatter + save dialog
```

---

## Out of Scope

- Notifications (VS Code toasts or status bar badges) — removed after discussion; not needed
- Session pinning — project grouping covers the organizational need
- Full transcript content search (across all sessions) — deferred; in-panel search covers the common case
