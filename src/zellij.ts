// ---------------------------------------------------------------------------
// Thin wrappers around the `zellij` CLI.
// ---------------------------------------------------------------------------

import { log } from "./config"
import { runCommand } from "./process"

export type ZellijPane = {
  id: number
  tabId: number
  tabName: string
}

type RawPane = {
  id: number
  is_plugin: boolean
  exited?: boolean
  tab_id: number
  tab_name?: string
}

// Live terminal panes across every tab of the current session.
export async function listPanes(): Promise<ZellijPane[] | undefined> {
  try {
    const result = await runCommand("zellij", ["action", "list-panes", "--json", "--all"])
    if (result.exitCode !== 0) return undefined
    return (JSON.parse(result.stdout) as RawPane[])
      .filter((pane) => !pane.is_plugin && !pane.exited)
      .map((pane) => ({ id: pane.id, tabId: pane.tab_id, tabName: String(pane.tab_name ?? "") }))
  } catch (error) {
    log(`list-panes failed: ${error instanceof Error ? error.message : "unknown"}`)
    return undefined
  }
}

// Terminal panes that attached clients are currently focused on. This is where
// the user actually is; `list-panes`' is_focused can be stale.
export async function listClientPanes(): Promise<number[] | undefined> {
  try {
    const result = await runCommand("zellij", ["action", "list-clients"])
    if (result.exitCode !== 0) return undefined
    return [...result.stdout.matchAll(/^\s*\d+\s+terminal_(\d+)\b/gm)].map((match) => Number(match[1]))
  } catch {
    return undefined
  }
}

export async function renameTab(id: number, name: string): Promise<boolean> {
  const result = await runCommand("zellij", ["action", "rename-tab-by-id", String(id), "--", name])
  if (result.exitCode !== 0) log(`rename-tab-by-id failed with exit code ${result.exitCode}`)
  return result.exitCode === 0
}

// Whether a client is currently focused on our pane.
export async function isFocused(paneId: number): Promise<boolean | undefined> {
  const panes = await listClientPanes()
  return panes ? panes.includes(paneId) : undefined
}
