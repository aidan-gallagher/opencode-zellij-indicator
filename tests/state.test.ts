import { describe, expect, test } from "bun:test"
import { derivePhase, shouldCheckFocus, transitionSession } from "../src/state"

describe("derivePhase", () => {
  test("prioritizes input over running work", () => {
    expect(
      derivePhase([
        { running: true, pending: false, permissions: 0, forms: 0 },
        { running: false, pending: false, permissions: 1, forms: 0 },
      ]),
    ).toBe("permission")
  })

  test("treats queued input as running", () => {
    expect(derivePhase([{ running: false, pending: true, permissions: 0, forms: 0 }])).toBe("running")
  })

  test("is done when the whole family is idle", () => {
    expect(derivePhase([{ running: false, pending: false, permissions: 0, forms: 0 }])).toBe("done")
  })
})

describe("transitionSession", () => {
  test("does not report an initially idle session as unseen", () => {
    expect(transitionSession(undefined, "done", false, 100)).toEqual({ phase: "done", seen: true })
  })

  test("marks a background completion unseen until focused", () => {
    const running = transitionSession(undefined, "running", false, 100)
    const done = transitionSession(running, "done", false, 200)
    expect(done).toEqual({ phase: "done", seen: false })
    expect(shouldCheckFocus(done, "done")).toBe(true)
    expect(transitionSession(done, "done", true, 300)).toEqual({ phase: "done", seen: true })
  })

  test("restarts the stopwatch after waiting for input", () => {
    const running = transitionSession(undefined, "running", false, 100)
    const permission = transitionSession(running, "permission", false, 200)
    expect(permission).toEqual({ phase: "permission", seen: false })
    expect(transitionSession(permission, "running", false, 300)).toEqual({
      phase: "running",
      seen: true,
      runStartedAt: 300,
    })
  })
})
