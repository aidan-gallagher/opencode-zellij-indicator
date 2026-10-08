import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAlive, openRegistry } from "../src/registry"

let root = ""
const previous = process.env.OPENCODE_ZELLIJ_STATE_DIR

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ozi-registry-"))
  process.env.OPENCODE_ZELLIJ_STATE_DIR = root
})

afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_ZELLIJ_STATE_DIR
  else process.env.OPENCODE_ZELLIJ_STATE_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

test("detects dead processes", () => {
  expect(isAlive(process.pid)).toBe(true)
  expect(isAlive(Bun.spawnSync(["true"]).pid)).toBe(false)
})

test("clients see each other's labels and drop them on close", async () => {
  const a = await openRegistry("my session", 1)
  const b = await openRegistry("my session", 2)
  await a.publish({ title: "Alpha", icon: "✅" }, 0)
  await b.publish(null, 0)

  expect(await a.members([1, 2, 3])).toEqual([
    { paneId: 1, label: { title: "Alpha", icon: "✅" } },
    { paneId: 2, label: null },
  ])
  expect(await b.members([1, 2])).toEqual([
    { paneId: 1, label: { title: "Alpha", icon: "✅" } },
    { paneId: 2, label: null },
  ])

  await a.close()
  expect(await b.members([1, 2])).toEqual([{ paneId: 2, label: null }])
})

test("ignores files left by dead clients", async () => {
  const a = await openRegistry("s", 1)
  writeFileSync(join(root, "session-s", "panes", "9.json"), JSON.stringify({ version: 1, pid: Bun.spawnSync(["true"]).pid, label: null }))
  expect(await a.members([1, 9])).toEqual([{ paneId: 1, label: null }])
})

test("stores tab state", async () => {
  const a = await openRegistry("s", 1)
  expect(await a.readTab(4)).toBeUndefined()
  await a.writeTab(4, { base: "project", primary: 1, written: "Alpha ✅" })
  expect(await (await openRegistry("s", 2)).readTab(4)).toEqual({ base: "project", primary: 1, written: "Alpha ✅" })
  await a.removeTab(4)
  expect(await a.readTab(4)).toBeUndefined()
})

test("watch reports other clients' changes only", async () => {
  const a = await openRegistry("s", 1)
  const b = await openRegistry("s", 2)
  let changes = 0
  const stop = a.watch(() => changes++)
  await a.publish({ title: "Alpha", icon: "✅" }, 0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(changes).toBe(0)
  await b.publish({ title: "Bravo", icon: "⏳" }, 0)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(changes).toBeGreaterThan(0)
  stop()
})

test("falls back to running alone when the directory can't be created", async () => {
  writeFileSync(join(root, "blocked"), "")
  process.env.OPENCODE_ZELLIJ_STATE_DIR = join(root, "blocked")
  const a = await openRegistry("s", 1)
  expect(a.shared).toBe(false)
  await a.publish({ title: "Alpha", icon: "✅" }, 0)
  expect(await a.members([1, 2])).toEqual([{ paneId: 1, label: { title: "Alpha", icon: "✅" } }])
})

test("refuses a state directory that is a symlink", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs")
  mkdirSync(join(root, "real"), { mode: 0o700 })
  symlinkSync(join(root, "real"), join(root, "link"))
  process.env.OPENCODE_ZELLIJ_STATE_DIR = join(root, "link")
  expect((await openRegistry("s", 1)).shared).toBe(false)
})

test("makes the state directory private", async () => {
  const { chmodSync, mkdirSync, statSync } = await import("node:fs")
  mkdirSync(join(root, "open"))
  chmodSync(join(root, "open"), 0o777)
  process.env.OPENCODE_ZELLIJ_STATE_DIR = join(root, "open")
  expect((await openRegistry("s", 1)).shared).toBe(true)
  expect(statSync(join(root, "open")).mode & 0o077).toBe(0)
})

test("other versions and malformed labels take part without a label", async () => {
  const a = await openRegistry("s", 1)
  const pid = process.pid
  writeFileSync(join(root, "session-s", "panes", "2.json"), JSON.stringify({ version: 2, pid, label: { title: "Future", icon: "✅" } }))
  writeFileSync(join(root, "session-s", "panes", "3.json"), JSON.stringify({ version: 1, pid, label: { title: 42 } }))
  expect(await a.members([2, 3])).toEqual([
    { paneId: 2, label: null },
    { paneId: 3, label: null },
  ])
})

test("recreates its files and directories if they are removed", async () => {
  const a = await openRegistry("s", 1)
  const b = await openRegistry("s", 2)
  await a.publish({ title: "Alpha", icon: "✅" }, 0)
  rmSync(join(root, "session-s"), { recursive: true, force: true })
  await a.publish({ title: "Alpha", icon: "✅" }, 0)
  expect(await b.members([1])).toEqual([{ paneId: 1, label: { title: "Alpha", icon: "✅" } }])
  rmSync(join(root, "session-s"), { recursive: true, force: true })
  expect(await a.writeTab(4, { base: "project", primary: null, written: "x" })).toBe(true)
  expect(await b.readTab(4)).toEqual({ base: "project", primary: null, written: "x" })
})
