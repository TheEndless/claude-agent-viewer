# Sidebar Subagent-First Redesign

**Date:** 2026-04-18
**Scope:** `src/webviewProvider.ts` (primary), light touches to `src/agentService.ts` and `src/types.ts`
**Supersedes:** The current state-bucketed sidebar design (Active / Idle / Done top sections)

## Why

The current sidebar is structured around **top-level Claude Code sessions grouped by state**. In practice, the user already has full access to main sessions through Claude's own VSCode extension — the unique value of this viewer is **observability into subagents** (spawned by `Agent` tool calls), which Claude's native UI does not surface.

The current structure buries subagents behind three levels of clicks:

1. Expand the top-level state section
2. Expand the project group
3. Expand the parent session card
4. Expand the "N active subagent" toggle inside the card

Subagents should be the primary entity, visible by default.

Other observed pain points:

- **669 "Done" sessions** occupy as much visual weight as 2 active ones.
- Projects appear in multiple top sections (Active / Idle / Done) if they have sessions in all states — the same project visually splits.
- Parent session cards show *current tool activity* ("Read foo.ts") as their title, which is meaningless once the session is idle. The latest user prompt (what the session is *about*) is buried in the expand panel.
- Three-level tree nesting creates visual noise that works against VSCode's flat Explorer aesthetic.

## Goals

1. **Subagents are visible by default.** No click required to see what subagents are doing under an active parent.
2. **Parents are the primary grouping.** One collapsible per main session.
3. **Flat, activity-sorted list of parents.** No state buckets above parents.
4. **Parent's latest prompt is the primary label.** "What did I ask this agent to do?" — the thing that makes the session recognizable.
5. **Done sessions hidden behind a single archive toggle.** Out of the way by default.
6. **VSCode-native aesthetic.** Feels like a built-in Explorer view. No custom cards, gradients, or animations beyond VSCode's own conventions.

## Non-Goals

- No search or filter UI (deferred; can revisit if the list grows unmanageable).
- No multi-selection or bulk actions.
- No new data collected — same `Agent` tree that `agentService.ts` already builds.
- No changes to the transcript preview panel (separate component, already redesigned this session).

## Information Architecture

### Tree structure

```
AGENTS                                              [refresh]
──────────────────────────────────────────
▾ ● Redesign the agents panel                  [3]
     agent-viewer · 4s
     ● Generate full sidebar reference mockup · 4s
     ○ Research VSCode theming conventions · 3m
     · Audit current sidebar code structure · 14m (done)
▸ ● Add test coverage for JSONL parser         [2]
     understudy · 30s
▸ ○ Fix auth middleware session leak
     kraken_cli · 8m
▸ ○ Migrate office_hours to new router API     [1]
     office_hours · 1h
──────────────────────────────────────────
▸ Show archive                           14 sessions
```

Each parent is one collapsible unit. There is exactly one level of nesting (subagents under their parent). Nothing else nests.

### Sort order

- **Primary list:** parent sessions sorted by `max(parent.mtimeMs, max(subagent.mtimeMs))` descending. "Whichever activity is most recent, across parent and its subagents."
- **Within a parent:** subagents sorted by `mtimeMs` descending.
- **Archive:** done parents sorted by `mtimeMs` descending.

### State model

A parent is classified as:

- `running` — `running` if itself is running OR any subagent is running.
- `idle` — not running, but itself or a subagent has activity within the `RUNNING_WINDOW_MS` recency window (already 5 min).
- `done` — session-ended (summary event) or >24h stale.

Running parents and idle parents both appear in the primary list. **Done parents move into the archive.** A parent that is `done` but has a subagent still `running` stays in the primary list (unusual but possible).

### Parents with no subagents

A main session that has spawned zero subagents appears as a single header row with no nested content and no count chip. Still clickable to open its transcript preview.

## Visual Treatment

VSCode-native Explorer-tree tight. No cards, no borders around rows, no background fills beyond hover. Status dots are the only color.

### Parent header row (22px)

Layout: `[caret 16px] [status dot 7px] [prompt text — primary, flex:1] [count chip — if any]`

- **Caret:** inline SVG right-chevron, `12×12`, `stroke-width 1.5`, `currentColor`, `opacity 0.6`. Rotated 90° via `transform` when open (use real element + CSS class, not `:before` pseudo).
- **Status dot:** 7px circle, absolute colors: running `#3fb950`, idle `#d29922`, done `#6e7681`. Running gets `box-shadow: 0 0 4px rgba(63,185,80,0.5)`. No animation — VSCode doesn't animate status indicators.
- **Prompt text:** truncated `latestUserPrompt`, one line, `text-overflow: ellipsis`, `font-size: 13px`, `font-weight: 500`, color `--vscode-foreground`. If no prompt captured, fall back to a dimmed placeholder (e.g. `"(no prompt yet)"`).
- **Count chip:** only rendered when parent has ≥1 subagent. `font-size: 10px`, `background: --vscode-badge-background`, `color: --vscode-badge-foreground`, `padding: 0 5px`, `border-radius: 8px`. Shows total subagent count.

### Parent secondary line

Shown inside the expanded parent (between the header and the subagent list), 20px left-indent:

Layout: `[project path] · [relative time]`

- **Project path:** `font-size: 10px`, color `--vscode-descriptionForeground`. **Ellipsized from the start** using `direction: rtl; unicode-bidi: plaintext; text-overflow: ellipsis; overflow: hidden; white-space: nowrap`. **No monospace** — use the default sans font.
- **Separator:** middle-dot `·` with `padding: 0 4px`, muted.
- **Time:** `font-size: 10px`, color `--vscode-disabledForeground`, formatted as relative (`"4s"`, `"3m"`, `"1h"`, `"2d"`).

The secondary line is only visible when the parent is expanded. (When collapsed, the prompt + dot is enough density.)

### Subagent row (22px, nested)

Layout: `[status dot 7px] [task description — flex:1] [time — right-aligned]`

- Indented 20px from parent header (no separate caret; subagents don't nest further).
- **Status dot:** same color rules as parent.
- **Task description:** the `description` argument from the originating `Agent` tool call. One line, `font-size: 12px`, `--vscode-foreground`, ellipsized. Done subagents: `opacity: 0.6`.
- **Time:** `font-size: 10px`, muted, `· 4s` format, right-aligned.

### Hover / click behavior

- Hover: row background becomes `--vscode-list-hoverBackground`, cursor `pointer`.
- Hover on parent or subagent row: action buttons (preview / open folder / delete) fade in right-aligned within the row, replacing the count chip / time.
- **Click on the caret area (leftmost ~20px):** toggles expand/collapse of the parent. Only affects parents, not subagents.
- **Click anywhere else on a row:** opens the transcript preview for that session.
- Subagent rows have no caret — clicking opens their preview directly.

### Archive section

A single collapsed row at the bottom, separated by a hairline (`--vscode-input-border`):

`[caret] Show archive          14 sessions`

- Font size `10px`, color `--vscode-descriptionForeground`.
- When expanded, renders done parents in the same tree format as primary, but with `opacity: 0.6` on the entire archive subtree.
- Expanded state persists across renders via the existing `openSections` map, keyed `archive`.

### Section header

Top of the panel, sticky during scroll:

`AGENTS                                           ↻`

- Label: `11px`, `font-weight: 600`, `text-transform: uppercase`, `letter-spacing: 0.5px`, color `--vscode-sideBarSectionHeader-foreground`.
- Refresh icon: inline SVG, only visible on hover of the header row. Click triggers `postAgents()`.
- Background: `--vscode-sideBar-background` with `position: sticky; top: 0`.

## Data Model

No new fields required. The existing `Agent` type already includes:

- `subagents: Agent[]` — populated by `agentTree.ts`
- `details.latestUserPrompt` — already captured
- `details.recentToolCalls` — used internally, not rendered in new sidebar
- `parentSessionId` — used to distinguish top-level from subagent
- `state`, `mtimeMs`, `cwd`, `projectName`, `sessionId` — all still needed

**Proposed addition:** subagents need a surfaced `taskDescription` — the `description` argument from the originating `Agent` tool call in the parent's transcript. This is currently captured in `details.recentToolCalls` but not associated with the specific subagent. We'll extract it during `buildTree` by matching each subagent's `sessionId` against any `Agent` tool_use block in the parent's events, pulling `input.description`, and storing it on the subagent's `Agent` object as `taskDescription?: string`.

If not found (e.g., parent's tail window didn't include the spawn event), fall back to the subagent's `details.latestUserPrompt` or, failing that, a truncated `sessionId` short.

## Rendering Flow

```
postAgents()   →   webview receives serialized agent tree
    ↓
render(agents):
    ↓
    1. Split agents: primary = running | idle; archive = done
    2. Sort primary by max(parent.mtimeMs, max(subagent.mtimeMs)) desc
    3. Sort archive by mtimeMs desc
    4. Render section header
    5. For each primary parent:
         - Render parent header (caret / dot / prompt / count chip)
         - If open:
             - Render secondary line (path / time)
             - For each subagent: render subagent row (dot / task / time)
    6. Render archive toggle row
    7. If archive open:
         - Render each done parent in same format (opacity 0.6 subtree)
```

All rendering still happens in the webview via inline `render(...)` JS, as today. The structural changes are entirely in:

- What HTML is produced (new row shapes)
- What state is tracked (`openSections` now has simpler keys: `parent:<sessionId>`, `archive`)
- What data is shown (prompt primary, path secondary, subagent task)

## State Persistence

The existing `openSections` map (webview-scoped) already handles preservation of expanded state across re-renders. Keys simplify from the current 3-level scheme to:

- `parent:<sessionId>` — which parents are expanded
- `archive` — is the archive section expanded

**Default expand state (when the user has not yet interacted):**

- `running` parents with ≥1 subagent → expanded.
- All other parents → collapsed.
- `archive` → collapsed.

Once the user clicks to toggle any row, that choice is stored in `openSections` and takes precedence over the default.

State for subagents is not needed — they have no expand/collapse.

## File Structure

Most changes land in `src/webviewProvider.ts`. Specifically:

- **CSS block:** replace the current `.row-group` / `.top-group` / `.proj-group` / `.sub-group` / `.card*` rules with a simpler `.parent-row` / `.parent-header` / `.parent-body` / `.subagent-row` / `.archive-toggle` set. Card-specific styling disappears entirely.
- **Render functions:** replace `renderTopSection` / `renderProjectSection` / `renderSubGroup` / `renderCard` / `renderDetails` / `renderTrail` / `renderFiles` with a flatter set: `renderParent` (single parent + its subagents), `renderSubagent` (one subagent row), `renderArchive` (collapsed toggle row + optional contents).
- **Click handling:** keeps same delegated listener on `root`; simplified branching since there are fewer row types.
- **Expand state:** `expanded` (cards) and `subExpanded` (subagent lists) maps merge into a single `openSections` map with `parent:` and `archive` keys.

Light touches elsewhere:

- `src/types.ts`: add `taskDescription?: string` to `Agent`.
- `src/agentTree.ts` (or a small addition in `agentService.ts`): during tree build, attach `taskDescription` to each subagent by scanning the parent's tail events for a matching `Agent` tool_use. If `buildTree` doesn't currently have access to parent events, compute in `agentService.ts.buildAgent()` pre-tree and store an intermediate map.

## Testing

Unit tests that already exist for `agentTree.ts` keep passing — no change to tree-building contract.

New manual verification against live `~/.claude/projects`:

- Open the panel; verify current-running parents (with subagents) are expanded by default in recency order.
- Verify idle parents appear in same list, sorted by activity.
- Verify empty parents (main sessions with no subagents) render as compact header-only rows.
- Verify "Show archive" collapse is closed by default; expand it and confirm done sessions render with dimmed opacity.
- Verify subagent rows show the correct task description from their spawning `Agent` tool call.
- Verify hover reveals action buttons; clicking a row (not the caret) opens the correct transcript preview.
- Verify open/close state is preserved across auto-refresh re-renders.

## Out of Scope / Follow-ups

- Search / filter UI.
- Project-filter chips above the list (can add later if needed).
- Inline activity preview on parent/subagent header (tool name currently executing). Would require extra data flow; deferred until user asks.
- Pinning favorite parents.
- Grouping archive by day or project.
