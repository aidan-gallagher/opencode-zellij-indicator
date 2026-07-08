import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// opencode-zellij-status
//
// A pure opencode plugin that shows each opencode session's state on its Zellij
// tab. No fork, no WASM, no status-bar replacement — it just shells out to the
// `zellij` CLI (`rename-tab-by-id`) and no-ops when not running inside Zellij.
//
// Four states, each a configurable icon:
//   1. running       — opencode is working
//   2. permission    — waiting for you to approve/deny (always stands out)
//   3. done, unseen  — finished and you haven't looked yet
//   4. done, seen    — finished and you've since focused that tab
//
// The tab label becomes "<opencode session title> <icon>".
// ---------------------------------------------------------------------------

const env = (key: string, def: string) => {
  const v = process.env[key]
  return v && v.length > 0 ? v : def
}

// The four icons. Defaults follow the "red = busy, question = needs you, green =
// wants you, grey = handled" convention. Override with env vars for other glyphs.
const ICON_RUNNING = env("OPENCODE_ZELLIJ_ICON_RUNNING", "🔴")
const ICON_PERMISSION = env("OPENCODE_ZELLIJ_ICON_PERMISSION", "❓")
const ICON_UNSEEN = env("OPENCODE_ZELLIJ_ICON_ATTENTION", "🟢")
const ICON_SEEN = env("OPENCODE_ZELLIJ_ICON_SEEN", "⚪")
const ALL_ICONS = [ICON_RUNNING, ICON_PERMISSION, ICON_UNSEEN, ICON_SEEN].filter(
  (i) => i.length,
)

const POLL_MS = Number.parseInt(env("OPENCODE_ZELLIJ_POLL_MS", "1500"), 10)

// Tools that block waiting for the user (opencode's interactive question / the
// plan-mode "switch to build agent?" prompt). While one of these runs, the
// session is really waiting on you, so show the attention icon rather than 🔴.
const ASK_TOOLS = new Set(["question", "plan_exit"])

// Debug logging (set OPENCODE_ZELLIJ_DEBUG=1). Goes to opencode's server log,
// not the TUI. Invaluable for diagnosing "why isn't my tab renaming?".
const DEBUG = process.env.OPENCODE_ZELLIJ_DEBUG === "1"
const log = (msg: string) => {
  if (DEBUG) console.error(`[zellij-status] ${msg}`)
}

// Strip any trailing status icon(s) so we recover the clean base tab name.
function stripIcons(s: string): string {
  let out = s.trimEnd()
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

export const ZellijStatus: Plugin = async ({ $ }) => {
  const paneIdRaw = process.env.ZELLIJ_PANE_ID
  const paneId = paneIdRaw ? Number.parseInt(paneIdRaw, 10) : NaN
  if (!process.env.ZELLIJ_SESSION_NAME || Number.isNaN(paneId)) {
    log(
      `not inside Zellij (ZELLIJ_SESSION_NAME=${process.env.ZELLIJ_SESSION_NAME}, ZELLIJ_PANE_ID=${paneIdRaw}) — disabled`,
    )
    return {} // not inside Zellij — do nothing
  }
  log(`init: pane=${paneId} session=${process.env.ZELLIJ_SESSION_NAME}`)

  let phase: "running" | "permission" | "done" = "done"
  let seen = true
  let title: string | undefined
  let baseName: string | undefined
  let tabId: number | undefined
  let rootSessionID: string | undefined
  const subagents = new Set<string>()
  let lastName: string | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const iconFor = () => {
    if (phase === "running") return ICON_RUNNING
    if (phase === "permission") return ICON_PERMISSION
    return seen ? ICON_SEEN : ICON_UNSEEN
  }

  async function refreshTab() {
    try {
      const out = await $`zellij action list-panes --json --all`.quiet().nothrow().text()
      const panes = JSON.parse(out) as Array<{
        id: number
        is_plugin: boolean
        tab_id: number
        tab_name?: string
      }>
      const mine = panes.find((p) => !p.is_plugin && p.id === paneId)
      if (!mine) {
        log(`could not find own pane (id=${paneId}) among ${panes.length} panes`)
        return
      }
      tabId = mine.tab_id
      if (baseName === undefined) {
        baseName = stripIcons(String(mine.tab_name ?? ""))
        log(`resolved tab: id=${tabId} baseName=${JSON.stringify(baseName)}`)
      }
    } catch (e) {
      log(`list-panes failed: ${e instanceof Error ? e.message : "unknown"}`)
    }
  }

  async function isFocused(): Promise<boolean> {
    try {
      const out = await $`zellij action list-clients`.quiet().nothrow().text()
      return new RegExp(`\\bterminal_${paneId}\\b`).test(out)
    } catch {
      return false
    }
  }

  async function render() {
    await refreshTab()
    if (tabId === undefined) return
    const label = (title && title.trim()) || (baseName && baseName.trim()) || ""
    const name = label ? `${label} ${iconFor()}` : iconFor()
    if (name === lastName) return
    lastName = name
    log(`rename tab ${tabId} -> ${JSON.stringify(name)} (phase=${phase} seen=${seen})`)
    await $`zellij action rename-tab-by-id ${tabId} ${name}`.quiet().nothrow()
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  function startPoll() {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      if (phase !== "done" || seen) return stopPoll()
      if (await isFocused()) {
        log("tab focused while done+unseen -> seen")
        seen = true
        await render()
        stopPoll()
      }
    }, Number.isFinite(POLL_MS) ? POLL_MS : 1500)
    ;(pollTimer as { unref?: () => void }).unref?.()
  }

  async function setRunning() {
    phase = "running"
    stopPoll()
    await render()
  }

  // "done" covers finished turns and errors.
  async function setDone() {
    phase = "done"
    seen = await isFocused() // if you're already looking, it's immediately "seen"
    await render()
    if (!seen) startPoll()
  }

  // Waiting on a permission prompt — always stands out, regardless of focus.
  async function setPermission() {
    phase = "permission"
    seen = false
    stopPoll()
    await render()
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info
          if (info.parentID) {
            subagents.add(info.id)
          } else {
            rootSessionID = info.id
            if (info.title && info.title !== title) {
              title = info.title
              await render()
            }
          }
          break
        }
        case "session.idle": {
          if (subagents.has(event.properties.sessionID)) break // subagent only
          await setDone()
          break
        }
        case "session.error": {
          await setDone()
          break
        }
        case "session.deleted": {
          const info = event.properties.info
          if (info.parentID) {
            subagents.delete(info.id)
            break
          }
          stopPoll()
          if (tabId !== undefined && baseName !== undefined) {
            lastName = undefined
            log(`session deleted -> restore base name ${JSON.stringify(baseName)}`)
            await $`zellij action rename-tab-by-id ${tabId} ${baseName}`.quiet().nothrow()
          }
          break
        }
      }
    },

    "chat.message": async (input) => {
      if (!subagents.has(input.sessionID)) rootSessionID = input.sessionID
      await setRunning()
    },

    "tool.execute.before": async (input) => {
      log(`tool.execute.before tool=${JSON.stringify(input.tool)}`)
      // Interactive prompts (question / plan_exit) are waiting on the user.
      if (ASK_TOOLS.has(input.tool)) await setPermission()
      else await setRunning()
    },

    // Once an interactive prompt is answered, we're processing again.
    "tool.execute.after": async (input) => {
      if (ASK_TOOLS.has(input.tool)) await setRunning()
    },

    // A permission prompt gets its own always-visible icon.
    "permission.ask": async () => {
      await setPermission()
    },
  }
}

// Export both named and default — opencode discovers named plugin exports, and a
// default export is belt-and-braces for loader compatibility across versions.
export default ZellijStatus
