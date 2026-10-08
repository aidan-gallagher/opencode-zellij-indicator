import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ICON_PERMISSION, ICON_SEEN, ICON_UNSEEN } from "../src/config"

// In-memory Zellij: tab names, which tab each pane is in, and where clients are.
const tabs = new Map<number, string>()
const paneTabs = new Map<number, number>()
let clientPanes: number[] = []
let renameFailures = 0
let paneFocused: boolean | undefined = false
const renameTab = mock(async (id: number, name: string) => {
  if (renameFailures > 0) {
    renameFailures--
    return false
  }
  tabs.set(id, name)
  return true
})

mock.module("../src/zellij", () => ({
  isFocused: async () => paneFocused,
  listClientPanes: async () => clientPanes,
  listPanes: async () => [...paneTabs].map(([id, tabId]) => ({ id, tabId, tabName: tabs.get(tabId) ?? "" })),
  renameTab,
}))

const plugin = (await import("opencode-zellij-indicator/tui")).default

const previousEnv = { ...process.env }
let stateDir = ""
const running: (() => Promise<void> | void)[] = []

async function setup(context: unknown) {
  const cleanup = await plugin.setup(context as never)
  if (!cleanup) return undefined
  let done = false
  const once = async () => {
    if (done) return
    done = true
    await cleanup()
  }
  running.push(once)
  return once
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ozi-test-"))
  process.env.OPENCODE_ZELLIJ_STATE_DIR = stateDir
  process.env.ZELLIJ_SESSION_NAME = "test"
  tabs.clear()
  paneTabs.clear()
  clientPanes = []
  renameFailures = 0
  paneFocused = false
  renameTab.mockClear()
})

afterEach(async () => {
  for (const cleanup of running.splice(0)) await cleanup()
  for (const key of ["OPENCODE_ZELLIJ_STATE_DIR", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  rmSync(stateDir, { recursive: true, force: true })
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
}

type Listener = (event: { details: any }) => void

// A client showing one idle root session.
function client(sessionID: string, title: string) {
  const session = { id: sessionID, title, location: { directory: "/tmp" } }
  let permission = false
  let listener: Listener | undefined
  let route: { type: string; sessionID?: string } = { type: "session", sessionID }
  const context = {
    attention: { notify: async () => ({ ok: true, notification: false, sound: true }) },
    client: { session: { list: async () => ({ data: [], cursor: {} }) } },
    data: {
      listen(handler: Listener) {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      session: {
        family: () => [sessionID],
        form: { list: () => [], sync: async () => undefined },
        get: () => session,
        pending: { list: () => [], sync: async () => undefined },
        permission: { list: () => (permission ? [{}] : []), sync: async () => undefined },
        root: () => sessionID,
        status: () => "idle" as const,
        sync: async () => undefined,
      },
    },
    ui: { router: { current: () => route } },
  }
  return {
    context,
    session,
    emit: (details: any) => listener?.({ details }),
    setPermission(value: boolean) {
      permission = value
      listener?.({ details: { type: "permission.asked", data: { sessionID } } })
    },
    refresh: () => listener?.({ details: { type: "server.connected", data: {} } }),
    home() {
      route = { type: "home" }
      listener?.({ details: { type: "server.connected", data: {} } })
    },
    back() {
      route = { type: "session", sessionID }
      listener?.({ details: { type: "server.connected", data: {} } })
    },
    rename(title: string) {
      session.title = title
      listener?.({ details: { type: "session.renamed", data: { sessionID } } })
    },
  }
}

async function start(paneId: number, tabId: number, c: ReturnType<typeof client>) {
  paneTabs.set(paneId, tabId)
  process.env.ZELLIJ_PANE_ID = String(paneId)
  return setup(c.context)
}

test("exports a v2 TUI plugin", () => {
  expect(plugin.id).toBe("opencode.zellij-indicator")
  expect(plugin.setup).toBeFunction()
})

test("preserves a new child's fast completion and follows a moved pane", async () => {
  tabs.set(0, "project")
  tabs.set(1, "other")
  paneTabs.set(1, 0)
  paneTabs.set(2, 1)
  paneTabs.set(7, 0)
  process.env.ZELLIJ_PANE_ID = "7"
  let selectedSession = "root"
  let childHydrated = false
  let permissionPending = false
  let listener: Listener | undefined
  const notify = mock(async () => ({ ok: true, notification: false, sound: true }))
  const root = { id: "root", title: "Task", location: { directory: "/tmp" } }
  const child = { id: "child", parentID: "root", location: { directory: "/tmp" } }
  const context = {
    attention: { notify },
    client: {
      session: {
        list: async () => ({ data: [], cursor: {} }),
      },
    },
    data: {
      listen(handler: Listener) {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      session: {
        family: () => (childHydrated ? ["root", "child"] : ["root"]),
        form: { list: () => [], sync: async () => undefined },
        get: (sessionID: string) => (sessionID === "child" && childHydrated ? child : root),
        pending: { list: () => [], sync: async () => undefined },
        permission: { list: () => (permissionPending ? [{}] : []), sync: async () => undefined },
        root: (sessionID: string) => (sessionID === "child" && !childHydrated ? "child" : "root"),
        status: () => "idle" as const,
        sync: async (sessionID: string) => {
          if (sessionID === "child") childHydrated = true
        },
      },
    },
    ui: {
      router: {
        current: () => ({ type: "session", sessionID: selectedSession }),
      },
    },
  }

  const cleanup = await setup(context)
  expect(tabs.get(0)).toBe(`Task ${ICON_SEEN}`)

  selectedSession = "child"
  listener?.({
    details: { type: "session.created", data: { sessionID: "child", parentID: "root" } },
  })
  listener?.({
    details: { type: "session.execution.started", created: 100, data: { sessionID: "child" } },
  })
  listener?.({
    details: { type: "session.execution.succeeded", created: 101, data: { sessionID: "child" } },
  })
  await settle()
  expect(tabs.get(0)).toBe(`Task ${ICON_UNSEEN}`)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenLastCalledWith({
    title: "Task",
    message: "OpenCode session done",
    notification: false,
    sound: { name: "done", when: "always" },
  })

  paneFocused = true
  listener?.({
    details: { type: "session.execution.started", created: 102, data: { sessionID: "child" } },
  })
  listener?.({
    details: { type: "session.execution.succeeded", created: 103, data: { sessionID: "child" } },
  })
  await settle()
  expect(tabs.get(0)).toBe(`Task ${ICON_SEEN}`)
  expect(notify).toHaveBeenCalledTimes(1)

  paneFocused = undefined
  listener?.({
    details: { type: "session.execution.started", created: 104, data: { sessionID: "child" } },
  })
  listener?.({
    details: { type: "session.execution.succeeded", created: 105, data: { sessionID: "child" } },
  })
  await settle()
  expect(notify).toHaveBeenCalledTimes(1)

  paneFocused = false
  listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
  await settle()
  expect(notify).toHaveBeenCalledTimes(2)

  permissionPending = true
  listener?.({ details: { type: "permission.asked", data: { sessionID: "child" } } })
  await settle()
  expect(notify).toHaveBeenCalledTimes(3)
  expect(notify).toHaveBeenLastCalledWith({
    title: "Task",
    message: "OpenCode needs input",
    notification: false,
    sound: { name: "permission", when: "always" },
  })

  listener?.({
    details: { type: "session.execution.started", created: 106, data: { sessionID: "child" } },
  })
  await settle()
  expect(notify).toHaveBeenCalledTimes(3)

  permissionPending = false
  listener?.({ details: { type: "permission.replied", data: { sessionID: "child" } } })
  listener?.({
    details: { type: "session.execution.succeeded", created: 107, data: { sessionID: "child" } },
  })
  await settle()
  expect(notify).toHaveBeenCalledTimes(4)

  // Move the pane to tab 1; the first restore of tab 0 fails and is retried.
  paneTabs.set(7, 1)
  renameFailures = 1
  listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
  await settle()
  expect(tabs.get(0)).toBe(`Task ${ICON_UNSEEN}`)
  expect(tabs.get(1)).toBe(`Task ${ICON_UNSEEN}`)

  listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
  await settle()
  expect(tabs.get(0)).toBe("project")
  expect(tabs.get(1)).toBe(`Task ${ICON_UNSEEN}`)

  await cleanup?.()
  expect(tabs.get(1)).toBe("other")
})

test("panes sharing a tab show both sessions without fighting", async () => {
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  const alpha = client("alpha", "Alpha")
  const bravo = client("bravo", "Bravo")
  const stopAlpha = await start(7, 0, alpha)
  const stopBravo = await start(8, 0, bravo)
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)

  const renames = renameTab.mock.calls.length
  for (let i = 0; i < 5; i++) {
    alpha.refresh()
    bravo.refresh()
    await settle()
  }
  expect(renameTab.mock.calls.length).toBe(renames)

  // A change in the non-writer pane reaches the tab through the shared files.
  bravo.setPermission(true)
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN} │ Bravo ${ICON_PERMISSION}`)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN} │ Bravo ${ICON_PERMISSION}`)

  await stopBravo?.()
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN}`)

  await stopAlpha?.()
  expect(tabs.get(0)).toBe("project")
})

test("long names fall back to the last focused session plus icons", async () => {
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  const alpha = client("alpha", "Alpha session with a fairly long title")
  const bravo = client("bravo", "Bravo session with another long title")
  const stopAlpha = await start(7, 0, alpha)
  const stopBravo = await start(8, 0, bravo)
  const showsAlpha = `Alpha session with a fairly long title ${ICON_SEEN} +${ICON_SEEN}`
  const showsBravo = `Bravo session with another long title ${ICON_SEEN} +${ICON_SEEN}`

  await waitFor(() => tabs.get(0) === showsAlpha)
  expect(tabs.get(0)).toBe(showsAlpha)

  clientPanes = [8]
  alpha.refresh()
  await waitFor(() => tabs.get(0) === showsBravo)
  expect(tabs.get(0)).toBe(showsBravo)

  // Focus moves to a shell: the last focused session stays.
  clientPanes = [3]
  alpha.refresh()
  await settle()
  expect(tabs.get(0)).toBe(showsBravo)

  // The writer pane exits; the remaining pane takes over and keeps the choice.
  clientPanes = []
  await stopAlpha?.()
  await waitFor(() => tabs.get(0) === `Bravo session with another long title ${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`Bravo session with another long title ${ICON_SEEN}`)

  await stopBravo?.()
  expect(tabs.get(0)).toBe("project")
})

test("a lone pane behaves like before and ignores a dead client's file", async () => {
  tabs.set(0, "project")
  paneTabs.set(5, 0)
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(join(stateDir, "session-test", "panes"), { recursive: true })
  const deadPid = Bun.spawnSync(["true"]).pid
  writeFileSync(join(stateDir, "session-test", "panes", "5.json"), JSON.stringify({ version: 1, pid: deadPid, label: { title: "Ghost", icon: ICON_SEEN } }))

  const alpha = client("alpha", "Alpha")
  const stop = await start(7, 0, alpha)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN}`)
  await stop?.()
  expect(tabs.get(0)).toBe("project")
})

test("copies starting at the same time still restore the original name", async () => {
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  paneTabs.set(7, 0)
  paneTabs.set(8, 0)
  const alpha = client("alpha", "Alpha")
  const bravo = client("bravo", "Bravo")
  process.env.ZELLIJ_PANE_ID = "7"
  const first = setup(alpha.context)
  process.env.ZELLIJ_PANE_ID = "8"
  const second = setup(bravo.context)
  const [stopAlpha, stopBravo] = await Promise.all([first, second])
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)

  await stopAlpha?.()
  await waitFor(() => tabs.get(0) === `Bravo ${ICON_SEEN}`)
  await stopBravo?.()
  expect(tabs.get(0)).toBe("project")
})

test("a lower pane joining later takes over and keeps the original name", async () => {
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  const alpha = client("alpha", "Alpha")
  const bravo = client("bravo", "Bravo")
  const stopBravo = await start(8, 0, bravo)
  expect(tabs.get(0)).toBe(`Bravo ${ICON_SEEN}`)
  const stopAlpha = await start(7, 0, alpha)
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN} │ Bravo ${ICON_SEEN}`)
  await stopBravo?.()
  await waitFor(() => tabs.get(0) === `Alpha ${ICON_SEEN}`)
  await stopAlpha?.()
  expect(tabs.get(0)).toBe("project")
})

test("the last focused session is remembered while its pane is on the home screen", async () => {
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  const title = (name: string) => `${name} session with a long enough title`
  const alpha = client("alpha", title("Alpha"))
  const bravo = client("bravo", title("Bravo"))
  const charlie = client("charlie", title("Charlie"))
  await start(7, 0, alpha)
  await start(8, 0, bravo)
  await start(9, 0, charlie)
  const shows = (name: string) => `${title(name)} ${ICON_SEEN} +${ICON_SEEN}${ICON_SEEN}`

  clientPanes = [8]
  alpha.refresh()
  await waitFor(() => tabs.get(0) === shows("Bravo"))
  expect(tabs.get(0)).toBe(shows("Bravo"))

  clientPanes = [1]
  bravo.home()
  await waitFor(() => tabs.get(0) === `${title("Alpha")} ${ICON_SEEN} +${ICON_SEEN}`)
  expect(tabs.get(0)).toBe(`${title("Alpha")} ${ICON_SEEN} +${ICON_SEEN}`)

  bravo.back()
  await waitFor(() => tabs.get(0) === shows("Bravo"))
  expect(tabs.get(0)).toBe(shows("Bravo"))
})

test("a failing state write doesn't lose the original name", async () => {
  const { chmodSync } = await import("node:fs")
  tabs.set(0, "project")
  paneTabs.set(1, 0)
  const alpha = client("alpha", "Alpha")
  const stop = await start(7, 0, alpha)
  expect(tabs.get(0)).toBe(`Alpha ${ICON_SEEN}`)
  chmodSync(join(stateDir, "session-test", "tabs"), 0o500)
  try {
    alpha.rename("Renamed")
    await waitFor(() => tabs.get(0) === `Renamed ${ICON_SEEN}`)
    expect(tabs.get(0)).toBe(`Renamed ${ICON_SEEN}`)
    alpha.rename("Again")
    await waitFor(() => tabs.get(0) === `Again ${ICON_SEEN}`)
    await stop?.()
    expect(tabs.get(0)).toBe("project")
  } finally {
    chmodSync(join(stateDir, "session-test", "tabs"), 0o700)
  }
})
