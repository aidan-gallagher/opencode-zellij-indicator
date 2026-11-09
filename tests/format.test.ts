import { describe, expect, test } from "bun:test"
import { ICON_PERMISSION, ICON_RUNNING, ICON_SEEN, ICON_UNSEEN } from "../src/config"
import { formatLabel, formatStopwatch, formatTabName, sessionOptions, stripIcons } from "../src/format"

describe("sessionOptions", () => {
  test("puts panes that need you first, then running, then idle", () => {
    const options = sessionOptions(
      [
        { paneId: 1, tabName: "wisa", label: { title: "Notes", icon: ICON_SEEN } },
        { paneId: 2, tabName: "sonic", label: { title: "Review", icon: ICON_RUNNING, stopwatch: "3m" } },
        { paneId: 3, tabName: "sonic", label: { title: "Build fix", icon: ICON_UNSEEN } },
        { paneId: 4, tabName: "k8s", label: null },
        { paneId: 5, tabName: "zellij", label: { title: "Blur", icon: ICON_PERMISSION } },
      ],
      1,
    )
    expect(options).toEqual([
      { title: `Blur ${ICON_PERMISSION}`, value: 5, description: "zellij", category: "Needs you" },
      { title: `Build fix ${ICON_UNSEEN}`, value: 3, description: "sonic", category: "Needs you" },
      { title: `Review ${ICON_RUNNING} (⏱ 3m)`, value: 2, description: "sonic", category: "Running" },
      { title: `Notes ${ICON_SEEN}`, value: 1, description: "wisa · this pane", category: "Idle" },
      { title: "No session open", value: 4, description: "k8s", category: "Idle" },
    ])
  })
})

describe("stripIcons", () => {
  test("removes a status icon", () => {
    expect(stripIcons(`project ${ICON_RUNNING}`)).toBe("project")
  })

  test("removes a running stopwatch left by a previous plugin generation", () => {
    expect(stripIcons(`project ${ICON_RUNNING} (⏱ 12)`)).toBe("project")
  })

  test("preserves a legitimate stopwatch-like tab suffix", () => {
    expect(stripIcons("profiling (⏱ manual)")).toBe("profiling (⏱ manual)")
  })
})

describe("formatStopwatch", () => {
  test("starts after one minute and formats hours", () => {
    expect(formatStopwatch(1_000, "running", 60_999)).toBeUndefined()
    expect(formatStopwatch(1_000, "running", 61_000)).toBe("1")
    expect(formatStopwatch(1_000, "running", 3_661_000)).toBe("1h1")
  })
})

describe("formatLabel", () => {
  test("matches the single-pane tab label", () => {
    expect(formatLabel({ title: "Task", icon: "✅" })).toBe("Task ✅")
    expect(formatLabel({ title: "Task", icon: "⏳", stopwatch: "5" })).toBe("Task ⏳ (⏱ 5)")
    expect(formatLabel({ title: " ", icon: "⏳", stopwatch: "5" })).toBe("⏳ (⏱ 5)")
  })
})

describe("formatTabName", () => {
  const a = { paneId: 1, label: { title: "Alpha", icon: "⏳" } }
  const b = { paneId: 2, label: { title: "Bravo", icon: "✅" } }
  const c = { paneId: 3, label: { title: "Charlie", icon: "🔔" } }

  test("one pane shows its label, with the tab name as the fallback title", () => {
    expect(formatTabName([a], 1, "project", 60)).toBe("Alpha ⏳")
    expect(formatTabName([{ paneId: 1, label: { title: "", icon: "⏳" } }], 1, "project", 60)).toBe("project ⏳")
  })

  test("joins panes when the result fits", () => {
    expect(formatTabName([a, b, c], 3, "project", 60)).toBe("Alpha ⏳ │ Bravo ✅ │ Charlie 🔔")
  })

  test("otherwise shows the primary pane and the other panes' icons", () => {
    expect(formatTabName([a, b, c], 2, "project", 20)).toBe("Bravo ✅ +⏳🔔")
    expect(formatTabName([a, b, c], undefined, "project", 20)).toBe("Alpha ⏳ +✅🔔")
  })
})
