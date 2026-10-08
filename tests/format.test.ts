import { describe, expect, test } from "bun:test"
import { ICON_RUNNING } from "../src/config"
import { formatLabel, formatStopwatch, formatTabName, stripIcons } from "../src/format"

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
