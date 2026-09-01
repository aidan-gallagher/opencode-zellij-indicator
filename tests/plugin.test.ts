import { expect, mock, test } from "bun:test"
import { ICON_SEEN, ICON_UNSEEN } from "../src/config"

const tabs = new Map<number, string>()
let currentTab = 0
let restoreFailures = 0
let paneFocused: boolean | undefined = false
const resolvePane = mock(async () => ({ tabId: currentTab, tabName: tabs.get(currentTab) ?? "" }))
const renameTab = mock(async (id: number, name: string) => {
  tabs.set(id, name)
  return true
})
const renameTabIfNamed = mock(async (id: number, expected: string, name: string) => {
  if (restoreFailures > 0) {
    restoreFailures--
    return "failed" as const
  }
  if (tabs.get(id) !== expected) return "changed" as const
  tabs.set(id, name)
  return "renamed" as const
})

mock.module("../src/zellij", () => ({
  isFocused: async () => paneFocused,
  renameTab,
  renameTabIfNamed,
  resolvePane,
}))

const plugin = (await import("opencode-zellij-indicator/tui")).default

test("exports a v2 TUI plugin", () => {
  expect(plugin.id).toBe("opencode.zellij-indicator")
  expect(plugin.setup).toBeFunction()
})

test("preserves a new child's fast completion and follows a moved pane", async () => {
  const previousSession = process.env.ZELLIJ_SESSION_NAME
  const previousPane = process.env.ZELLIJ_PANE_ID
  process.env.ZELLIJ_SESSION_NAME = "test"
  process.env.ZELLIJ_PANE_ID = "7"

  tabs.clear()
  tabs.set(0, "project")
  tabs.set(1, "other")
  currentTab = 0
  restoreFailures = 0
  paneFocused = false
  let selectedSession = "root"
  let childHydrated = false
  let permissionPending = false
  let listener: ((event: { details: any }) => void) | undefined
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
      listen(handler: typeof listener) {
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

  try {
    const cleanup = await plugin.setup(context as never)
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
    await new Promise((resolve) => setTimeout(resolve, 10))
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tabs.get(0)).toBe(`Task ${ICON_SEEN}`)
    expect(notify).toHaveBeenCalledTimes(1)

    paneFocused = undefined
    listener?.({
      details: { type: "session.execution.started", created: 104, data: { sessionID: "child" } },
    })
    listener?.({
      details: { type: "session.execution.succeeded", created: 105, data: { sessionID: "child" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(notify).toHaveBeenCalledTimes(1)

    paneFocused = false
    listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(notify).toHaveBeenCalledTimes(2)

    permissionPending = true
    listener?.({ details: { type: "permission.asked", data: { sessionID: "child" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(notify).toHaveBeenCalledTimes(3)

    permissionPending = false
    listener?.({ details: { type: "permission.replied", data: { sessionID: "child" } } })
    listener?.({
      details: { type: "session.execution.succeeded", created: 107, data: { sessionID: "child" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(notify).toHaveBeenCalledTimes(4)

    currentTab = 1
    restoreFailures = 1
    listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tabs.get(0)).toBe(`Task ${ICON_UNSEEN}`)
    expect(tabs.get(1)).toBe(`Task ${ICON_UNSEEN}`)

    listener?.({ details: { type: "session.renamed", data: { sessionID: "child" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tabs.get(0)).toBe("project")
    expect(tabs.get(1)).toBe(`Task ${ICON_UNSEEN}`)

    await cleanup?.()
    expect(tabs.get(1)).toBe("other")
  } finally {
    if (previousSession === undefined) delete process.env.ZELLIJ_SESSION_NAME
    else process.env.ZELLIJ_SESSION_NAME = previousSession
    if (previousPane === undefined) delete process.env.ZELLIJ_PANE_ID
    else process.env.ZELLIJ_PANE_ID = previousPane
  }
})
