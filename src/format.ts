// ---------------------------------------------------------------------------
// Pure presentation helpers: turning state into the strings we render on the
// tab. No runtime state, no side effects, no `$`.
// ---------------------------------------------------------------------------

import {
  ALL_ICONS,
  ICON_PERMISSION,
  ICON_RUNNING,
  ICON_SEEN,
  ICON_UNSEEN,
  STOPWATCH_ENABLED,
  type Phase,
} from "./config"

// Strip any trailing status icon(s) so we recover the clean base tab name.
export function stripIcons(s: string): string {
  let out = s.trimEnd()
  const withoutStopwatch = out.replace(/\s+\(⏱ [^)]+\)$/, "").trimEnd()
  if (ALL_ICONS.some((icon) => withoutStopwatch.endsWith(icon))) out = withoutStopwatch
  let changed = true
  while (changed) {
    changed = false
    for (const ic of ALL_ICONS) {
      if (out.endsWith(ic)) {
        out = out.slice(0, -ic.length).trimEnd()
        changed = true
      }
    }
  }
  return out
}

export type Label = {
  title: string
  icon: string
  stopwatch?: string
}

export function formatLabel(label: Label): string {
  const title = label.title.trim()
  const status = label.stopwatch ? `${label.icon} (⏱ ${label.stopwatch})` : label.icon
  return title ? `${title} ${status}` : status
}

// Tab name for the OpenCode panes in one tab, ordered by pane id. One pane
// shows its label. Several panes are joined when that fits in maxLength,
// otherwise the primary (last focused) pane's label is followed by the other
// panes' icons. Empty titles fall back to the tab's original name.
export function formatTabName(labels: { paneId: number; label: Label }[], primaryId: number | undefined, base: string, maxLength: number): string {
  const withBase = labels.map((entry) => ({ ...entry, label: { ...entry.label, title: entry.label.title.trim() || base } }))
  if (withBase.length === 1) return formatLabel(withBase[0].label)
  const joined = withBase.map((entry) => formatLabel(entry.label)).join(" │ ")
  if ([...joined].length <= maxLength) return joined
  const primary = withBase.find((entry) => entry.paneId === primaryId) ?? withBase[0]
  const others = withBase.filter((entry) => entry !== primary).map((entry) => entry.label.icon)
  return `${formatLabel(primary.label)} +${others.join("")}`
}

export function iconFor(phase: Phase, seen: boolean): string {
  if (phase === "running") return ICON_RUNNING
  if (phase === "permission") return ICON_PERMISSION
  return seen ? ICON_SEEN : ICON_UNSEEN
}

// Returns compact stopwatch string once >= 1 min, or undefined if not yet / not
// applicable (feature disabled, not running, or no start time).
export function formatStopwatch(runStartedAt: number | undefined, phase: Phase, now = Date.now()): string | undefined {
  if (!STOPWATCH_ENABLED || !runStartedAt || phase !== "running") return undefined
  const mins = Math.floor((now - runStartedAt) / 60_000)
  if (mins < 1) return undefined
  if (mins < 60) return `${mins}`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h${m}`
}
