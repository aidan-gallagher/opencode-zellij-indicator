// ---------------------------------------------------------------------------
// Thin wrappers around the `zellij` CLI.
// ---------------------------------------------------------------------------

import { log } from "./config"
import { runCommand } from "./process"

export type Pane = {
  id: number
  is_plugin: boolean
  tab_id: number
  tab_name?: string
  title?: string
  pane_command?: string | null
  is_focused?: boolean
  exited?: boolean
}

export function isOpenCodePane(pane: Pane): boolean {
  if (pane.is_plugin || pane.exited) return false
  return Boolean(pane.pane_command?.includes("opencode") || pane.title?.startsWith("OC |"))
}

// When several OpenCode panes share a tab, only one renames it: the focused
// OpenCode pane, otherwise the oldest. Every copy computes the same answer.
export function tabOwner(panes: Pane[], tabId: number, selfId: number): number {
  const candidates = panes
    .filter((pane) => pane.tab_id === tabId && !pane.is_plugin && (pane.id === selfId || isOpenCodePane(pane)))
    .sort((a, b) => a.id - b.id)
  return (candidates.find((pane) => pane.is_focused) ?? candidates[0])?.id ?? selfId
}

async function listPanes(): Promise<Pane[] | undefined> {
  try {
    const result = await runCommand("zellij", ["action", "list-panes", "--json", "--all"])
    if (result.exitCode !== 0) return undefined
    return JSON.parse(result.stdout) as Pane[]
  } catch (error) {
    log(`list-panes failed: ${error instanceof Error ? error.message : "unknown"}`)
    return undefined
  }
}

export async function renameTab(id: number, name: string): Promise<boolean> {
  const result = await runCommand("zellij", ["action", "rename-tab-by-id", String(id), name])
  if (result.exitCode !== 0) log(`rename-tab-by-id failed with exit code ${result.exitCode}`)
  return result.exitCode === 0
}

// Restore a tab name unless it has changed or another OpenCode pane still in
// the tab now owns it.
export async function renameTabIfNamed(id: number, expected: string, name: string, selfId: number): Promise<"renamed" | "changed" | "failed"> {
  const panes = await listPanes()
  if (!panes) return "failed"
  const tab = panes.find((pane) => pane.tab_id === id)
  if (!tab || String(tab.tab_name ?? "") !== expected) return "changed"
  if (panes.some((pane) => pane.tab_id === id && pane.id !== selfId && isOpenCodePane(pane))) return "changed"
  return (await renameTab(id, name)) ? "renamed" : "failed"
}

// Locate our own pane among all panes and return its tab id, raw tab name, and
// whether we own the tab name. Returns undefined if we can't find it (or the
// CLI call fails).
export async function resolvePane(paneId: number): Promise<{ tabId: number; tabName: string; owner: boolean } | undefined> {
  const panes = await listPanes()
  if (!panes) return undefined
  const mine = panes.find((pane) => !pane.is_plugin && pane.id === paneId)
  if (!mine) {
    log(`could not find own pane (id=${paneId}) among ${panes.length} panes`)
    return undefined
  }
  return { tabId: mine.tab_id, tabName: String(mine.tab_name ?? ""), owner: tabOwner(panes, mine.tab_id, paneId) === paneId }
}

// Whether the client is currently focused on our pane's tab.
export async function isFocused(paneId: number): Promise<boolean | undefined> {
  try {
    const result = await runCommand("zellij", ["action", "list-clients"])
    if (result.exitCode !== 0) return undefined
    return new RegExp(`\\bterminal_${paneId}\\b`).test(result.stdout)
  } catch {
    return undefined
  }
}
