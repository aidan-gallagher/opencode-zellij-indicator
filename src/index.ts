import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// opencode-zellij-indicator
//
// A pure opencode plugin that shows each opencode session's state on its Zellij
// tab. No fork, no WASM, no status-bar replacement — it just shells out to the
// `zellij` CLI (`rename-tab-by-id`) and no-ops when not running inside Zellij.
//
// Five states, each a configurable icon:
//   1. running       — opencode is working
//   2. retry         — a request failed and opencode is retrying (backoff)
//   3. permission    — waiting for you to approve/deny (always stands out)
//   4. done, unseen  — finished and you haven't looked yet
//   5. done, seen    — finished and you've since focused that tab
//
// The tab label becomes "<opencode session title> <icon>".
// ---------------------------------------------------------------------------

const env = (key: string, def: string) => {
  const v = process.env[key]
  return v && v.length > 0 ? v : def
}

// The five icons. Defaults: hourglass = busy, repeat = retrying after a failed
// request, question = needs you, bell = finished and wants your eyes, tick =
// you've since reviewed it. Override any of them with env vars for other glyphs.
const ICON_RUNNING = env("OPENCODE_ZELLIJ_ICON_RUNNING", "⏳")
const ICON_RETRY = env("OPENCODE_ZELLIJ_ICON_RETRY", "🔁")
const ICON_PERMISSION = env("OPENCODE_ZELLIJ_ICON_PERMISSION", "❓")
const ICON_UNSEEN = env("OPENCODE_ZELLIJ_ICON_ATTENTION", "🔔")
const ICON_SEEN = env("OPENCODE_ZELLIJ_ICON_SEEN", "✅")
const ALL_ICONS = [ICON_RUNNING, ICON_RETRY, ICON_PERMISSION, ICON_UNSEEN, ICON_SEEN].filter(
  (i) => i.length,
)

const DEFAULT_POLL_MS = 1500
const pollParsed = Number.parseInt(env("OPENCODE_ZELLIJ_POLL_MS", String(DEFAULT_POLL_MS)), 10)
const POLL_MS = Number.isFinite(pollParsed) ? pollParsed : DEFAULT_POLL_MS

// Tools that block waiting for the user (opencode's interactive question / the
// plan-mode "switch to build agent?" prompt). While one of these runs, the
// session is really waiting on you, so show the permission icon rather than the
// running one.
const ASK_TOOLS = new Set(["question", "plan_exit"])

// Debug logging (set OPENCODE_ZELLIJ_DEBUG=1). Goes to opencode's server log,
// not the TUI. Invaluable for diagnosing "why isn't my tab renaming?".
const DEBUG = process.env.OPENCODE_ZELLIJ_DEBUG === "1"
const log = (msg: string) => {
  if (DEBUG) console.error(`[zellij-indicator] ${msg}`)
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

  let phase: "running" | "retry" | "permission" | "done" = "done"
  let seen = true
  let title: string | undefined
  let baseName: string | undefined
  let tabId: number | undefined
  const subagents = new Set<string>()
  // Permission prompts currently awaiting an answer (by permission id). opencode
  // asks permission *before* firing tool.execute.before, so we track the pending
  // prompts to stop that running-transition from clobbering the permission icon.
  const pendingPerms = new Set<string>()
  let lastName: string | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const renameTab = (id: number, name: string) =>
    $`zellij action rename-tab-by-id ${id} ${name}`.quiet().nothrow()

  const iconFor = () => {
    if (phase === "running") return ICON_RUNNING
    if (phase === "retry") return ICON_RETRY
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
    await renameTab(tabId, name)
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
    }, POLL_MS)
    pollTimer.unref?.()
  }

  async function setRunning() {
    phase = "running"
    stopPoll()
    await render()
  }

  // A model/provider request failed and opencode is backing off + retrying. Not
  // "needs you" — just surfaced so a stalled turn doesn't keep masquerading as
  // busy while it waits between attempts.
  async function setRetry() {
    phase = "retry"
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
      // Permission events are handled here rather than via the `permission.ask`
      // hook (which doesn't fire in this opencode) and are read loosely because
      // the SDK types lag the runtime: the real events are `permission.asked`
      // (props: id, sessionID) and `permission.replied` (props: requestID, reply)
      // — not the `permission.updated` / `permissionID` the .d.ts declares.
      const type = event.type as string
      const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
      if (type === "permission.asked") {
        const sessionID = props.sessionID as string | undefined
        if (!sessionID || !subagents.has(sessionID)) {
          pendingPerms.add(String(props.id))
          await setPermission()
        }
        return
      }
      if (type === "permission.replied") {
        pendingPerms.delete(String(props.requestID))
        // Prompt answered — resume "running"; a follow-up session.idle/error
        // will settle it to done if the turn is actually finished.
        if (pendingPerms.size === 0 && phase === "permission") await setRunning()
        return
      }

      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties.info
          if (info.parentID) {
            subagents.add(info.id)
          } else if (info.title && info.title !== title) {
            title = info.title
            await render()
          }
          break
        }
        case "session.status": {
          // status is one of { type: "busy" | "idle" | "retry" }. "idle" is
          // covered by the dedicated session.idle event below, so here we only
          // act on retry (surface the backoff) and busy (resume from retry).
          if (subagents.has(event.properties.sessionID)) break // subagent only
          const status = event.properties.status
          if (status.type === "retry") {
            await setRetry()
          } else if (status.type === "busy") {
            // Resume once a retry succeeds — but never clobber an open
            // permission prompt (❓) or one that's mid-flight.
            if (phase === "retry") await setRunning()
            else if (phase !== "permission" && pendingPerms.size === 0) await setRunning()
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
            await renameTab(tabId, baseName)
          }
          break
        }
      }
    },

    "chat.message": async () => {
      await setRunning()
    },

    "tool.execute.before": async (input) => {
      log(`tool.execute.before tool=${JSON.stringify(input.tool)}`)
      // Interactive prompts (question / plan_exit) are waiting on the user.
      if (ASK_TOOLS.has(input.tool)) await setPermission()
      // Safety net: if a permission prompt is already open for this tool, don't
      // clobber the ❓ icon with "running". (Normally this hook fires just
      // before `permission.asked`, so pendingPerms is still empty here and the
      // asked event repaints ❓ a beat later — but guard against either order.)
      else if (pendingPerms.size > 0) log("tool.execute.before while permission pending — not clobbering")
      else await setRunning()
    },

    // Once an interactive prompt is answered, we're processing again.
    "tool.execute.after": async (input) => {
      if (ASK_TOOLS.has(input.tool)) await setRunning()
    },

    // Belt-and-braces for opencode versions that fire this hook (the current
    // one drives permission state from the `permission.asked` event instead).
    "permission.ask": async () => {
      await setPermission()
    },
  }
}

// Export both named and default — opencode discovers named plugin exports, and a
// default export is belt-and-braces for loader compatibility across versions.
export default ZellijStatus
