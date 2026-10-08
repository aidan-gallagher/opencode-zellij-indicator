import { Plugin } from "@opencode-ai/plugin/tui"
import { MAX_TAB_LENGTH, POLL_MS, STOPWATCH_ENABLED, log } from "./config"
import { formatStopwatch, formatTabName, iconFor, stripIcons, type Label } from "./format"
import { openRegistry, type TabState } from "./registry"
import { derivePhase, shouldCheckFocus, transitionSession, type SessionState } from "./state"
import { isFocused, listClientPanes, listPanes, renameTab, type ZellijPane } from "./zellij"

type Selection = {
  rootID: string
  title?: string
  state: SessionState
}

export default Plugin.define({
  id: "opencode.zellij-indicator",
  async setup(context) {
    const paneIdRaw = process.env.ZELLIJ_PANE_ID
    const paneId = paneIdRaw ? Number.parseInt(paneIdRaw, 10) : NaN
    if (!process.env.ZELLIJ_SESSION_NAME || Number.isNaN(paneId)) {
      log(`not inside Zellij (ZELLIJ_SESSION_NAME=${process.env.ZELLIJ_SESSION_NAME}, ZELLIJ_PANE_ID=${paneIdRaw}) - disabled`)
      return
    }

    const initialPane = (await listPanes())?.find((pane) => pane.id === paneId)
    if (!initialPane) {
      log(`could not resolve Zellij pane ${paneId} - disabled`)
      return
    }

    log(`init: pane=${paneId} session=${process.env.ZELLIJ_SESSION_NAME}`)
    const registry = await openRegistry(process.env.ZELLIJ_SESSION_NAME, paneId)
    let tabId = initialPane.tabId
    let ownLabel: Label | null = null
    const pendingLeaves = new Set<number>()
    // Tab state this client last wrote, kept in memory in case the shared file
    // can't be written; and tabs it has already rendered as writer.
    const lastState = new Map<number, TabState>()
    const visited = new Set<number>()
    let activeSession: string | undefined
    let disposed = false
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let stopwatchTimer: ReturnType<typeof setTimeout> | undefined
    let stopwatchRoot: string | undefined
    let stopwatchStartedAt: number | undefined
    const sessions = new Map<string, SessionState>()
    const syncRetry = new Set<string>()
    const rootHints = new Map<string, string>()
    const executionStarts = new Map<string, number>()
    const pendingAttention = new Map<string, { phase: "permission" | "done"; title?: string }>()
    let activeRoot: string | undefined
    let activeFamily = new Set<string>()
    let work: Promise<void> = Promise.resolve()
    let refreshRequested = false
    let forceSyncRequested = false
    let refreshScheduled = false
    let tabRenderRequested = false
    let refresh: (forceSync?: boolean) => Promise<void>
    let renderTab: () => Promise<void>

    const schedule = () => {
      if (refreshScheduled || disposed) return
      refreshScheduled = true
      work = work
        .then(async () => {
          while ((refreshRequested || tabRenderRequested) && !disposed) {
            if (refreshRequested) {
              refreshRequested = false
              const force = forceSyncRequested
              forceSyncRequested = false
              await refresh(force)
            }
            if (tabRenderRequested && !disposed) await renderTab()
          }
        })
        .catch((error) => log(`update failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          refreshScheduled = false
          if ((refreshRequested || tabRenderRequested) && !disposed) schedule()
        })
    }

    const requestRefresh = (forceSync = false) => {
      refreshRequested = true
      forceSyncRequested ||= forceSync
      schedule()
    }

    // Another client in this Zellij session changed, so re-check our tab.
    const requestTabRender = () => {
      tabRenderRequested = true
      schedule()
    }

    const familyIDs = (rootID: string) => {
      const family = context.data.session.family(rootID)
      return family.length > 0 ? family : [rootID]
    }

    const syncSession = async (sessionID: string) => {
      let rootID = sessionID
      const ancestors = new Set<string>()
      while (!ancestors.has(rootID)) {
        ancestors.add(rootID)
        await context.data.session.sync(rootID)
        const parentID = context.data.session.get(rootID)?.parentID
        if (!parentID) break
        rootID = parentID
      }

      let complete = true
      const queue = [rootID]
      const visited = new Set<string>()
      while (queue.length > 0) {
        const parentID = queue.shift()!
        if (visited.has(parentID)) continue
        visited.add(parentID)
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const page = await context.client.session.list({ parentID, order: "desc", limit: 100, cursor }).catch((error) => {
            complete = false
            log(`could not list children of ${parentID}: ${error instanceof Error ? error.message : String(error)}`)
            return undefined
          })
          if (!page) break
          for (const child of page.data) {
            await context.data.session.sync(child.id).catch((error) => {
              complete = false
              log(`could not sync ${child.id}: ${error instanceof Error ? error.message : String(error)}`)
            })
            queue.push(child.id)
          }
          cursor = page.cursor.next ?? undefined
          if (cursor && cursors.has(cursor)) {
            complete = false
            log(`session list for ${parentID} returned a repeated cursor`)
            break
          }
          if (cursor) cursors.add(cursor)
        } while (cursor)
      }

      const family = familyIDs(rootID)
      const results = await Promise.allSettled(
        family.flatMap((familyID) => [
          context.data.session.pending.sync(familyID),
          context.data.session.permission.sync(familyID),
          context.data.session.form.sync(familyID, context.data.session.get(familyID)?.location),
        ]),
      )
      complete &&= results.every((result) => result.status === "fulfilled")
      if (complete) {
        syncRetry.delete(rootID)
        for (const familyID of family) rootHints.delete(familyID)
      } else syncRetry.add(rootID)
      return { rootID, complete }
    }

    const selectedRoot = () => {
      const route = context.ui.router.current()
      if (route.type !== "session" || route.sessionID === "dummy") return undefined
      return { sessionID: route.sessionID, rootID: rootHints.get(route.sessionID) ?? context.data.session.root(route.sessionID) }
    }

    const eventRoot = (sessionID: string) => rootHints.get(sessionID) ?? context.data.session.root(sessionID)

    const selectedEventRoot = (sessionID: string) => {
      const selected = selectedRoot()
      if (!selected) return undefined
      if (eventRoot(sessionID) === selected.rootID) return selected.rootID
      if (activeRoot === selected.rootID && activeFamily.has(sessionID)) return selected.rootID
      return undefined
    }

    const refreshSelected = (sessionID: string, forceSync = false) => {
      if (selectedEventRoot(sessionID)) requestRefresh(forceSync)
    }

    const stopEvents = context.data.listen(({ details }) => {
      switch (details.type) {
        case "server.connected":
          requestRefresh(true)
          return
        case "session.created":
        case "session.forked": {
          const selected = selectedRoot()
          if (!selected) return
          const parentRoot = details.data.parentID ? eventRoot(details.data.parentID) : details.data.sessionID
          if (details.data.sessionID !== selected.sessionID && parentRoot !== selected.rootID) return
          rootHints.set(details.data.sessionID, parentRoot)
          requestRefresh(true)
          return
        }
        case "session.execution.started": {
          const rootID = selectedEventRoot(details.data.sessionID)
          if (!rootID) return
          if (!executionStarts.has(rootID)) executionStarts.set(rootID, details.created)
          requestRefresh()
          return
        }
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.inbox.enqueued":
        case "session.inbox.delivered":
        case "session.inbox.cancelled":
        case "session.inbox.delivery.changed":
        case "session.renamed":
          refreshSelected(details.data.sessionID)
          return
        case "session.deleted": {
          const selected = Boolean(selectedEventRoot(details.data.sessionID))
          rootHints.delete(details.data.sessionID)
          if (selected) requestRefresh(true)
          return
        }
        case "permission.asked":
        case "permission.replied":
        case "form.replied":
        case "form.cancelled":
          refreshSelected(details.data.sessionID)
          return
        case "form.created":
          refreshSelected(details.data.form.sessionID)
          return
      }
    })

    const phaseFor = (rootID: string) =>
      derivePhase(
        familyIDs(rootID).map((sessionID) => ({
          running: context.data.session.status(sessionID) === "running",
          pending: context.data.session.pending.list(sessionID).length > 0,
          permissions: context.data.session.permission.list(sessionID)?.length ?? 0,
          forms: context.data.session.form.list(sessionID, context.data.session.get(sessionID)?.location)?.length ?? 0,
        })),
      )

    const labelOf = (selection: Selection): Label => ({
      title: selection.title?.trim() ?? "",
      icon: iconFor(selection.state.phase, selection.state.seen),
      stopwatch: formatStopwatch(selection.state.runStartedAt, selection.state.phase),
    })

    const tabMembers = (panes: ZellijPane[], id: number) =>
      registry.members(panes.filter((pane) => pane.tabId === id).map((pane) => pane.id))

    // Prefer what we wrote ourselves while the tab still shows it; otherwise
    // the shared state (another client may have been the writer since).
    const knownState = async (id: number, current: string | undefined) => {
      const memory = lastState.get(id)
      if (memory && memory.written === current) return memory
      return (await registry.readTab(id)) ?? memory
    }

    const saveState = async (id: number, state: TabState) => {
      lastState.set(id, { ...state })
      await registry.writeTab(id, state)
    }

    // The last OpenCode pane to leave a tab restores its original name, unless
    // something else renamed the tab in the meantime.
    const leaveTab = async (id: number, panes: ZellijPane[]) => {
      const others = (await tabMembers(panes, id)).filter((member) => member.paneId !== paneId)
      if (others.length === 0) {
        const current = panes.find((pane) => pane.tabId === id)?.tabName
        const state = await knownState(id, current)
        if (state && current === state.written && current !== state.base) {
          log(`restore tab ${id} -> ${JSON.stringify(state.base)}`)
          if (!(await renameTab(id, state.base))) return
        }
        await registry.removeTab(id)
      }
      lastState.delete(id)
      visited.delete(id)
      pendingLeaves.delete(id)
    }

    // Only the tab's writer (its live OpenCode pane with the lowest id) renames
    // it, so clients sharing a tab never fight over the name.
    renderTab = async () => {
      tabRenderRequested = false
      const panes = await listPanes()
      if (!panes) return
      const mine = panes.find((pane) => pane.id === paneId)
      if (!mine) return
      if (mine.tabId !== tabId) {
        pendingLeaves.add(tabId)
        tabId = mine.tabId
      }
      await registry.publish(ownLabel, tabId)
      for (const id of [...pendingLeaves]) await leaveTab(id, panes)

      const members = await tabMembers(panes, tabId)
      if (Math.min(...members.map((member) => member.paneId)) !== paneId) return

      const current = mine.tabName
      const saved = await knownState(tabId, current)
      // The original name is taken from the tab when no state exists yet. A
      // client joining a tab alone also starts afresh if the leftover state
      // doesn't match (its last client crashed, then the tab was renamed).
      // Later mismatches are concurrent updates and keep the original name.
      const fresh = !saved || (!visited.has(tabId) && members.length === 1 && saved.written !== current)
      visited.add(tabId)
      const state: TabState = fresh ? { base: stripIcons(current), primary: saved?.primary ?? null, written: current } : { ...saved }
      const labelled = members
        .flatMap((member) => (member.label ? [{ paneId: member.paneId, label: member.label }] : []))
        .sort((a, b) => a.paneId - b.paneId)
      // The last focused OpenCode pane is kept while it's on its home screen.
      if (labelled.length > 1) {
        const focused = (await listClientPanes()) ?? []
        const focusedPane = labelled.find((entry) => focused.includes(entry.paneId))?.paneId
        if (focusedPane !== undefined) state.primary = focusedPane
      }
      const primary = labelled.find((entry) => entry.paneId === state.primary)?.paneId ?? labelled[0]?.paneId
      const name = labelled.length > 0 ? formatTabName(labelled, primary, state.base, MAX_TAB_LENGTH) : state.base
      // Record the name before renaming, so any client that sees the new tab
      // name also sees the state that goes with it.
      state.written = name
      if (!saved || saved.base !== state.base || saved.primary !== state.primary || saved.written !== state.written) {
        await saveState(tabId, state)
      }
      if (name !== current) {
        log(`rename tab ${tabId} -> ${JSON.stringify(name)}`)
        if (!(await renameTab(tabId, name))) await saveState(tabId, { ...state, written: current })
      }
    }

    const render = async (selection: Selection | undefined, routeSessionID?: string) => {
      const route = context.ui.router.current()
      if (routeSessionID ? route.type !== "session" || route.sessionID !== routeSessionID : route.type === "session") return
      ownLabel = selection ? labelOf(selection) : null
      await renderTab()
    }

    const clearStopwatch = () => {
      if (stopwatchTimer) clearTimeout(stopwatchTimer)
      stopwatchTimer = undefined
      stopwatchRoot = undefined
      stopwatchStartedAt = undefined
    }

    const scheduleStopwatch = (selection: Selection | undefined) => {
      const startedAt = selection?.state.runStartedAt
      if (!STOPWATCH_ENABLED || !selection || selection.state.phase !== "running" || !startedAt) {
        clearStopwatch()
        return
      }
      if (stopwatchTimer && stopwatchRoot === selection.rootID && stopwatchStartedAt === startedAt) return
      clearStopwatch()
      stopwatchRoot = selection.rootID
      stopwatchStartedAt = startedAt
      const elapsed = Date.now() - startedAt
      stopwatchTimer = setTimeout(() => {
        stopwatchTimer = undefined
        requestRefresh()
      }, 60_000 - (elapsed % 60_000))
      stopwatchTimer.unref?.()
    }

    refresh = async (forceSync = false) => {
      const route = context.ui.router.current()
      if (route.type !== "session" || route.sessionID === "dummy") {
        activeSession = undefined
        activeRoot = undefined
        activeFamily.clear()
        clearStopwatch()
        await render(undefined)
        return
      }

      const routeSessionID = route.sessionID
      const selectionChanged = routeSessionID !== activeSession
      activeSession = routeSessionID
      let rootID = context.data.session.root(routeSessionID)
      let syncComplete = true
      if (selectionChanged || forceSync || syncRetry.has(rootID)) {
        try {
          const result = await syncSession(routeSessionID)
          rootID = result.rootID
          syncComplete = result.complete
        } catch (error) {
          activeSession = undefined
          activeRoot = undefined
          activeFamily.clear()
          throw error
        }
      }
      if (disposed) return

      const currentRoute = context.ui.router.current()
      if (currentRoute.type !== "session" || currentRoute.sessionID !== routeSessionID || context.data.session.root(currentRoute.sessionID) !== rootID) return
      if (!syncComplete) {
        if (selectionChanged) await render(undefined, routeSessionID)
        return
      }
      activeRoot = rootID
      activeFamily = new Set(familyIDs(rootID))
      const info = context.data.session.get(rootID)
      if (!info) {
        activeSession = undefined
        clearStopwatch()
        await render(undefined, routeSessionID)
        return
      }

      const phase = phaseFor(rootID)
      let previous = sessions.get(rootID)
      const executionStartedAt = executionStarts.get(rootID)
      if (executionStartedAt !== undefined && phase !== "permission") {
        executionStarts.delete(rootID)
        if (previous?.phase !== "running") previous = transitionSession(previous, "running", false, executionStartedAt)
      }
      const attentionPhase = previous && previous.phase !== phase && (phase === "permission" || phase === "done") ? phase : undefined
      if (phase === "running") pendingAttention.delete(rootID)
      else if (attentionPhase) pendingAttention.set(rootID, { phase: attentionPhase, title: info.title })
      const focused = shouldCheckFocus(previous, phase) ? await isFocused(paneId) : undefined
      const latestRoute = context.ui.router.current()
      if (latestRoute.type !== "session" || latestRoute.sessionID !== routeSessionID || context.data.session.root(latestRoute.sessionID) !== rootID) return
      let state = transitionSession(previous, phase, focused === true, Date.now())
      sessions.set(rootID, state)
      const selection = { rootID, title: info.title, state }
      scheduleStopwatch(selection)
      await render(selection, routeSessionID)
      const attention = pendingAttention.get(rootID)
      if (attention) {
        const finalFocus = await isFocused(paneId)
        const finalRoute = context.ui.router.current()
        if (finalRoute.type !== "session" || finalRoute.sessionID !== routeSessionID) return
        if (finalFocus !== undefined) {
          pendingAttention.delete(rootID)
          if (finalFocus && state.phase === "done" && !state.seen) {
            state = transitionSession(state, "done", true, Date.now())
            sessions.set(rootID, state)
            await render({ rootID, title: info.title, state }, routeSessionID)
          } else if (!finalFocus) {
            void context.attention.notify({
              title: attention.title,
              message: attention.phase === "permission" ? "OpenCode needs input" : "OpenCode session done",
              notification: false,
              sound: { name: attention.phase === "permission" ? "permission" : "done", when: "always" },
            })
          }
        }
      }
    }

    await refresh(true).catch((error) => log(`initial update failed: ${error instanceof Error ? error.message : String(error)}`))
    pollTimer = setInterval(() => {
      requestRefresh()
      requestTabRender()
    }, POLL_MS)
    pollTimer.unref?.()
    const stopWatch = registry.watch(requestTabRender)

    return async () => {
      disposed = true
      stopEvents()
      stopWatch()
      if (pollTimer) clearInterval(pollTimer)
      clearStopwatch()
      await work

      await registry.close()
      const panes = await listPanes()
      if (!panes) return
      pendingLeaves.add(tabId)
      for (const id of [...pendingLeaves]) await leaveTab(id, panes)
    }
  },
})
