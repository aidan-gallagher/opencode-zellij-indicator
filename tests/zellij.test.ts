import { describe, expect, test } from "bun:test"
import { isOpenCodePane, tabOwner, type Pane } from "../src/zellij"

const pane = (id: number, extra: Partial<Pane> = {}): Pane => ({ id, is_plugin: false, tab_id: 1, ...extra })

describe("isOpenCodePane", () => {
  test("detects OpenCode by command or title", () => {
    expect(isOpenCodePane(pane(1, { pane_command: "/home/me/.opencode/bin/opencode -c" }))).toBe(true)
    expect(isOpenCodePane(pane(1, { title: "OC | Fix login" }))).toBe(true)
    expect(isOpenCodePane(pane(1, { pane_command: "/bin/bash", title: "~/Code" }))).toBe(false)
    expect(isOpenCodePane(pane(1, { pane_command: "opencode", exited: true }))).toBe(false)
    expect(isOpenCodePane(pane(1, { title: "OC | x", is_plugin: true }))).toBe(false)
  })
})

describe("tabOwner", () => {
  const oc = { pane_command: "opencode" }

  test("a lone OpenCode pane owns its tab even next to a focused shell", () => {
    expect(tabOwner([pane(1, { is_focused: true, pane_command: "bash" }), pane(2, oc)], 1, 2)).toBe(2)
  })

  test("the focused OpenCode pane owns a shared tab", () => {
    const panes = [pane(1, oc), pane(2, { ...oc, is_focused: true })]
    expect(tabOwner(panes, 1, 1)).toBe(2)
    expect(tabOwner(panes, 1, 2)).toBe(2)
  })

  test("the oldest OpenCode pane owns it when a shell is focused", () => {
    const panes = [pane(5, { is_focused: true, pane_command: "bash" }), pane(3, oc), pane(4, oc)]
    expect(tabOwner(panes, 1, 3)).toBe(3)
    expect(tabOwner(panes, 1, 4)).toBe(3)
  })

  test("ignores OpenCode panes in other tabs", () => {
    expect(tabOwner([pane(1, { ...oc, tab_id: 2, is_focused: true }), pane(2, oc)], 1, 2)).toBe(2)
  })
})
