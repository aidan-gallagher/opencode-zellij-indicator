// ---------------------------------------------------------------------------
// State shared between the OpenCode clients running in one Zellij session.
//
// Each client owns one file describing its pane (process id, tab, current
// label). Each tab has one file (original name, last focused OpenCode pane,
// last name written) that only the tab's writer - the live client with the
// lowest pane id in that tab - updates. Files live in a private directory and
// are replaced atomically, so readers never see partial writes. A client whose
// process has died is ignored.
// ---------------------------------------------------------------------------

import { watch } from "node:fs"
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "./config"
import type { Label } from "./format"

export type Member = { paneId: number; label: Label | null }

export type TabState = {
  base: string
  primary: number | null
  written: string
}

export interface Registry {
  readonly shared: boolean
  publish(label: Label | null, tabId: number): Promise<void>
  members(paneIds: number[]): Promise<Member[]>
  readTab(tabId: number): Promise<TabState | undefined>
  writeTab(tabId: number, state: TabState): Promise<boolean>
  removeTab(tabId: number): Promise<void>
  watch(onChange: () => void): () => void
  close(): Promise<void>
}

const VERSION = 1

export function registryRoot(): string {
  if (process.env.OPENCODE_ZELLIJ_STATE_DIR) return process.env.OPENCODE_ZELLIJ_STATE_DIR
  if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "opencode-zellij-indicator")
  return join(tmpdir(), `opencode-zellij-indicator-${process.getuid?.() ?? "user"}`)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The root may sit in a shared temp directory, so only use it if it is a real
// directory that we own and nobody else can read or write.
async function ensurePrivateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw new Error(`${path} is not a directory owned by us`)
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700)
}

let writes = 0

// Write to a fresh temp file (never following an existing path) and rename it
// into place.
async function writeAtomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${writes++}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readJSON(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function asLabel(value: unknown): Label | null {
  const label = value as Partial<Label> | null | undefined
  if (!label || typeof label.title !== "string" || typeof label.icon !== "string") return null
  if (label.stopwatch !== undefined && typeof label.stopwatch !== "string") return null
  return label.stopwatch === undefined ? { title: label.title, icon: label.icon } : { title: label.title, icon: label.icon, stopwatch: label.stopwatch }
}

function asTabState(value: unknown): TabState | undefined {
  const state = value as Partial<TabState> | undefined
  if (!state || typeof state.base !== "string" || typeof state.written !== "string") return undefined
  return { base: state.base, primary: typeof state.primary === "number" ? state.primary : null, written: state.written }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function openRegistry(sessionName: string, paneId: number): Promise<Registry> {
  const root = registryRoot()
  const dir = join(root, `session-${encodeURIComponent(sessionName)}`)
  const panesDir = join(dir, "panes")
  const tabsDir = join(dir, "tabs")
  const ensureDirs = async () => {
    await mkdir(panesDir, { recursive: true, mode: 0o700 })
    await mkdir(tabsDir, { recursive: true, mode: 0o700 })
  }
  try {
    await ensurePrivateDir(root)
    await ensureDirs()
  } catch (error) {
    log(`shared state unavailable (${describe(error)}) - running alone, so OpenCode panes sharing a tab may fight over its name`)
    return memoryRegistry(paneId)
  }

  // Recreate the directories if something (e.g. a temp cleaner) removed them.
  const write = async (path: string, value: unknown) => {
    try {
      await writeAtomic(path, value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await ensureDirs()
      await writeAtomic(path, value)
    }
  }

  const ownFile = join(panesDir, `${paneId}.json`)
  let ownLabel: Label | null = null
  let written: string | undefined

  return {
    shared: true,
    async publish(label, tabId) {
      ownLabel = label
      const body = JSON.stringify({ version: VERSION, pid: process.pid, tabId, label })
      if (body === written && (await access(ownFile).then(() => true, () => false))) return
      try {
        await write(ownFile, JSON.parse(body))
        written = body
      } catch (error) {
        log(`could not write ${ownFile}: ${describe(error)}`)
      }
    },
    async members(paneIds) {
      const members: Member[] = []
      for (const id of paneIds) {
        if (id === paneId) {
          members.push({ paneId, label: ownLabel })
          continue
        }
        const entry = (await readJSON(join(panesDir, `${id}.json`))) as { version?: unknown; pid?: unknown; label?: unknown } | undefined
        if (!entry || typeof entry.pid !== "number" || !isAlive(entry.pid)) continue
        // A client of another version still takes part, but shows nothing.
        members.push({ paneId: id, label: entry.version === VERSION ? asLabel(entry.label) : null })
      }
      return members
    },
    async readTab(tabId) {
      return asTabState(await readJSON(join(tabsDir, `${tabId}.json`)))
    },
    async writeTab(tabId, state) {
      try {
        await write(join(tabsDir, `${tabId}.json`), { version: VERSION, ...state })
        return true
      } catch (error) {
        log(`could not write tab ${tabId} state: ${describe(error)}`)
        return false
      }
    },
    async removeTab(tabId) {
      await rm(join(tabsDir, `${tabId}.json`), { force: true }).catch(() => undefined)
    },
    watch(onChange) {
      // Bun may only report the temporary file of an atomic write, so react to
      // any change except our own, a moment later once the rename is done.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const watcher = watch(panesDir, (_event, file) => {
          if (file && String(file).startsWith(`${paneId}.json`)) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(onChange, 50)
          timer.unref?.()
        })
        watcher.on?.("error", (error) => log(`watching ${panesDir} failed: ${describe(error)}`))
        watcher.unref?.()
        return () => {
          if (timer) clearTimeout(timer)
          watcher.close()
        }
      } catch (error) {
        log(`could not watch ${panesDir}: ${describe(error)}`)
        return () => {}
      }
    },
    async close() {
      written = undefined
      await rm(ownFile, { force: true }).catch(() => undefined)
    },
  }
}

// Fallback when the shared directory can't be used: behave as the only client.
export function memoryRegistry(paneId: number): Registry {
  let ownLabel: Label | null = null
  const tabs = new Map<number, TabState>()
  return {
    shared: false,
    async publish(label) {
      ownLabel = label
    },
    async members(paneIds) {
      return paneIds.includes(paneId) ? [{ paneId, label: ownLabel }] : []
    },
    async readTab(tabId) {
      const state = tabs.get(tabId)
      return state ? { ...state } : undefined
    },
    async writeTab(tabId, state) {
      tabs.set(tabId, { ...state })
      return true
    },
    async removeTab(tabId) {
      tabs.delete(tabId)
    },
    watch() {
      return () => {}
    },
    async close() {},
  }
}
