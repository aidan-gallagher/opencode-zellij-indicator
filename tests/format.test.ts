import { describe, expect, test } from "bun:test"
import { ICON_RUNNING } from "../src/config"
import { formatStopwatch, stripIcons } from "../src/format"

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
