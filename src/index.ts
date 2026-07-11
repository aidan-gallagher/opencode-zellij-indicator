import type { Plugin } from "@opencode-ai/plugin"
import { ASK_TOOLS, POLL_MS, STOPWATCH_ENABLED, log, type Phase } from "./config"
import { formatStopwatch, iconFor, stripIcons } from "./format"
import { playSound } from "./sound"
import { isFocused, renameTab, resolvePane } from "./zellij"

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
// The tab label becomes "<opencode session title> <icon>". Config, presentation
// helpers, the zellij CLI wrappers and the completion sound live in sibling modules; this
// file owns the runtime state machine and event wiring.
// ---------------------------------------------------------------------------

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

  let phase: Phase = "done"
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
  let runStartedAt: number | undefined
  let stopwatchTimer: ReturnType<typeof setTimeout> | undefined

  function endStopwatch() {
    if (stopwatchTimer) {
      clearTimeout(stopwatchTimer)
      stopwatchTimer = undefined
    }
  }

  function scheduleStopwatch() {
    if (!STOPWATCH_ENABLED || stopwatchTimer) return
    // Fire on the next minute boundary from runStartedAt.
    const elapsed = Date.now() - (runStartedAt ?? Date.now())
    const msUntilNextMinute = 60_000 - (elapsed % 60_000)
    stopwatchTimer = setTimeout(async () => {
      stopwatchTimer = undefined
      if (phase !== "running") return
      await render()
      scheduleStopwatch() // reschedule for the following minute
    }, msUntilNextMinute)
    stopwatchTimer.unref?.()
  }

  async function refreshTab() {
    const resolved = await resolvePane($, paneId)
    if (!resolved) return
    tabId = resolved.tabId
    if (baseName === undefined) {
      baseName = stripIcons(resolved.tabName)
      log(`resolved tab: id=${tabId} baseName=${JSON.stringify(baseName)}`)
    }
  }

  async function render() {
    await refreshTab()
    if (tabId === undefined) return
    const label = (title && title.trim()) || (baseName && baseName.trim()) || ""
    const stopwatch = formatStopwatch(runStartedAt, phase)
    const icon = iconFor(phase, seen)
    const name = label
      ? stopwatch ? `${label} ${icon} (⏱ ${stopwatch})` : `${label} ${icon}`
      : stopwatch ? `${icon} (⏱ ${stopwatch})` : icon
    if (name === lastName) return
    lastName = name
    log(`rename tab ${tabId} -> ${JSON.stringify(name)} (phase=${phase} seen=${seen} stopwatch=${stopwatch})`)
    await renameTab($, tabId, name)
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
      if (await isFocused($, paneId)) {
        log("tab focused while done+unseen -> seen")
        seen = true
        await render()
        stopPoll()
      }
    }, POLL_MS)
    pollTimer.unref?.()
  }

  async function setRunning() {
    if (phase !== "running") {
      runStartedAt = Date.now()
      scheduleStopwatch()
    }
    phase = "running"
    stopPoll()
    await render()
  }

  // A model/provider request failed and opencode is backing off + retrying. Not
  // "needs you" — just surfaced so a stalled turn doesn't keep masquerading as
  // busy while it waits between attempts.
  async function setRetry() {
    phase = "retry"
    runStartedAt = undefined
    endStopwatch()
    stopPoll()
    await render()
  }

  // "done" covers finished turns and errors.
  async function setDone() {
    const wasDone = phase === "done"
    phase = "done"
    runStartedAt = undefined
    endStopwatch()
    seen = await isFocused($, paneId) // if you're already looking, it's immediately "seen"
    await render()
    if (!seen) {
      startPoll()
      // Finished while you were away — alert once, on the transition only (so
      // a following session.error can't play the sound twice for the same finished turn).
      if (!wasDone) void playSound($)
    }
  }

  // Waiting on a permission prompt — always stands out, regardless of focus.
  async function setPermission() {
    phase = "permission"
    runStartedAt = undefined
    endStopwatch()
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
            await renameTab($, tabId, baseName)
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
