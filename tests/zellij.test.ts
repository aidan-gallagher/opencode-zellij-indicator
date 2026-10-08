import { expect, mock, test } from "bun:test"

const calls: string[][] = []
let stdout = ""
mock.module("../src/process", () => ({
  runCommand: async (command: string, args: string[]) => {
    calls.push([command, ...args])
    return { exitCode: 0, stdout }
  },
}))

// Import the real module under a distinct specifier: other test files replace
// "../src/zellij" itself with a mock.
const zellij = await import(`../src/zellij.ts?real`)

test("reads which panes clients are focused on", async () => {
  stdout = "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1         terminal_4     N/A\n2         plugin_3       N/A\n3         terminal_12    vim\n"
  expect(await zellij.listClientPanes()).toEqual([4, 12])
  expect(await zellij.isFocused(12)).toBe(true)
  expect(await zellij.isFocused(1)).toBe(false)
})

test("lists live terminal panes", async () => {
  stdout = JSON.stringify([
    { id: 0, is_plugin: true, tab_id: 0, tab_name: "a" },
    { id: 1, is_plugin: false, tab_id: 0, tab_name: "a" },
    { id: 2, is_plugin: false, exited: true, tab_id: 1, tab_name: "b" },
  ])
  expect(await zellij.listPanes()).toEqual([{ id: 1, tabId: 0, tabName: "a" }])
})

test("passes tab names after --", async () => {
  await zellij.renameTab(3, "-v flag regression")
  expect(calls.at(-1)).toEqual(["zellij", "action", "rename-tab-by-id", "3", "--", "-v flag regression"])
})
