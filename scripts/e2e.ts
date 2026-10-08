#!/usr/bin/env bun
// End-to-end check: a real Zellij session with a client attached, and real
// OpenCode clients loading this checkout's plugin, all talking to a private
// OpenCode server with its own config and data under a temporary directory.
//
// Needs zellij, opencode2 (or OPENCODE_BIN) and script(1); Linux only (reads
// /proc to crash a client). Run with `bun run e2e`.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode2"
const PLUGIN = process.env.E2E_PLUGIN ?? join(REPO, "src/index.ts")
const root = mkdtempSync(join(tmpdir(), "ozi-e2e-"))
const session = `ozi-e2e-${process.pid}`
const port = (() => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const free = probe.port
  probe.stop(true)
  return free
})()
const server = `http://127.0.0.1:${port}`
const password = "e2e"
const SEEN = "✅"
const UNSEEN = "🔔"
const PERMISSION = "❓"

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("ZELLIJ") && !key.startsWith("OPENCODE")),
) as Record<string, string>
const opencodeEnv = {
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_ZELLIJ_STATE_DIR: join(root, "registry"),
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const results: string[] = []
const pass = (label: string) => {
  results.push(`PASS  ${label}`)
  console.log(`PASS  ${label}`)
}
const fail = (label: string, detail: string) => {
  failures++
  results.push(`FAIL  ${label}: ${detail}`)
  console.log(`FAIL  ${label}: ${detail}`)
}

async function run(command: string[], env = baseEnv) {
  const proc = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { stdout, code: proc.exitCode }
}

const zellij = (...args: string[]) => run(["zellij", "--session", session, ...args])

type Pane = { id: number; tab_id: number; tab_name: string; title: string; is_plugin: boolean; exited: boolean }

async function panes(): Promise<Pane[]> {
  const { stdout } = await zellij("action", "list-panes", "--json", "--all")
  try {
    return (JSON.parse(stdout) as Pane[]).filter((pane) => !pane.is_plugin)
  } catch {
    return []
  }
}

// Retries reads where Zellij momentarily returns nothing (e.g. while a pane's
// process exits), so those aren't mistaken for a tab name change.
async function tabName(tabId: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = (await panes()).find((pane) => pane.tab_id === tabId)?.tab_name
    if (name !== undefined) return name
    await sleep(50)
  }
  return undefined
}

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${server}${path}`, {
    method,
    headers: { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`)
  return ((await response.json()) as { data: any } | null)?.data
}

async function createSession(title: string): Promise<string> {
  const permissions = [{ action: "bash", resource: "*", effect: "ask" }]
  return (await api("POST", "/api/session", { title, location: { directory: root }, permissions })).id
}

const renameSession = (id: string, title: string) => api("PATCH", `/api/session/${id}`, { title })

function opencodeCommand(sessionID?: string) {
  const target = sessionID ? ` -s ${sessionID}` : ""
  return `. ${join(root, "env.sh")}; ${OPENCODE} --server ${server}${target}; echo EXIT; exec sleep 86400`
}

// Adds a tab whose panes run the given commands (undefined = plain shell) and
// returns its tab id plus pane ids in layout order.
async function addTab(name: string, commands: (string | undefined)[]) {
  const before = new Set((await panes()).map((pane) => pane.id))
  const body = commands
    .map((command) => (command ? `      pane command="bash" { args "-c" "${command}"; }` : "      pane"))
    .join("\n")
  const file = join(root, `${name}.kdl`)
  writeFileSync(file, `layout {\n  tab name="${name}" {\n    pane split_direction="vertical" {\n${body}\n    }\n  }\n}\n`)
  await zellij("--layout", file)
  for (let i = 0; i < 50; i++) {
    const added = (await panes()).filter((pane) => !before.has(pane.id)).sort((a, b) => a.id - b.id)
    if (added.length === commands.length) return { tabId: added[0].tab_id, paneIds: added.map((pane) => pane.id) }
    await sleep(200)
  }
  throw new Error(`tab ${name} did not appear`)
}

const focus = (paneId: number) => zellij("action", "focus-pane-id", `terminal_${paneId}`)

async function quit(paneId: number) {
  await zellij("action", "write-chars", "--pane-id", `terminal_${paneId}`, "/exit")
  await sleep(300)
  await zellij("action", "write", "--pane-id", `terminal_${paneId}`, "13")
}

// The OpenCode process running in a pane, found through its environment.
function opencodePid(paneId: number): number | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
      if (!cmdline.includes(`--server\0${server}`)) continue
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0")
      if (environ.includes(`ZELLIJ_SESSION_NAME=${session}`) && environ.includes(`ZELLIJ_PANE_ID=${paneId}`)) return Number(entry)
    } catch {}
  }
  return undefined
}

// Waits for the tab to show `expected`, then requires it to stay exactly that
// (no flicker) for `hold` ms, sampling every 100 ms.
async function expectTab(label: string, tabId: number, expected: string, { within = 10_000, hold = 4_000 } = {}) {
  const start = Date.now()
  let name = await tabName(tabId)
  while (name !== expected && Date.now() - start < within) {
    await sleep(100)
    name = await tabName(tabId)
  }
  if (name !== expected) return fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(name)}`)
  const seen = new Set<string | undefined>()
  const end = Date.now() + hold
  while (Date.now() < end) {
    seen.add(await tabName(tabId))
    await sleep(100)
  }
  if (seen.size !== 1) return fail(label, `flickered between ${[...seen].map((value) => JSON.stringify(value)).join(", ")}`)
  pass(label)
}

let serverProc: ReturnType<typeof Bun.spawn> | undefined
let clientProc: ReturnType<typeof Bun.spawn> | undefined

async function setup() {
  mkdirSync(join(root, "config/opencode/plugins/zellij-indicator"), { recursive: true })
  writeFileSync(
    join(root, "config/opencode/cli.json"),
    JSON.stringify({ plugins: ["-opencode.notifications"], tabs: { enabled: false }, animations: false, attention: { enabled: false } }),
  )
  writeFileSync(join(root, "config/opencode/plugins/zellij-indicator/tui.ts"), `export { default } from ${JSON.stringify(PLUGIN)}\n`)
  writeFileSync(join(root, "env.sh"), Object.entries(opencodeEnv).map(([key, value]) => `export ${key}=${value}`).join("\n") + "\n")

  serverProc = Bun.spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...baseEnv, ...opencodeEnv },
    stdout: Bun.file(join(root, "server.log")),
    stderr: Bun.file(join(root, "server.err")),
    stdin: "ignore",
  })
  for (let i = 0; ; i++) {
    try {
      await api("GET", "/api/session")
      break
    } catch (error) {
      if (i > 150) throw new Error(`server did not start: ${error}`)
      await sleep(200)
    }
  }

  await run(["zellij", "attach", "--create-background", session])
  clientProc = Bun.spawn(["script", "-qfc", `stty cols 220 rows 50; zellij attach ${session}`, "/dev/null"], {
    env: { ...baseEnv, TERM: "xterm-256color" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let i = 0; i < 50 && !(await zellij("action", "list-clients")).stdout.includes("terminal_"); i++) await sleep(200)
}

async function teardown() {
  await run(["zellij", "kill-session", session])
  await run(["zellij", "delete-session", "--force", session])
  clientProc?.kill()
  serverProc?.kill()
  await sleep(500)
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(server)) process.kill(Number(entry), "SIGKILL")
    } catch {}
  }
  if (!process.env.E2E_KEEP) rmSync(root, { recursive: true, force: true })
}

async function scenarios() {
  const alpha = await createSession("Alpha")
  const bravo = await createSession("Bravo")
  const work = await addTab("work", [opencodeCommand(alpha), opencodeCommand(bravo), undefined])
  const [paneA, paneB, shell] = work.paneIds

  await expectTab("two sessions share the tab name", work.tabId, `Alpha ${SEEN} │ Bravo ${SEEN}`, { within: 30_000 })

  await focus(paneB)
  await expectTab("focusing the other pane changes nothing while both fit", work.tabId, `Alpha ${SEEN} │ Bravo ${SEEN}`)

  await focus(shell)
  const request = await api("POST", `/api/session/${bravo}/permission`, { action: "bash", resources: ["e2e"] })
  await expectTab("a permission prompt in the second pane shows on the tab", work.tabId, `Alpha ${SEEN} │ Bravo ${PERMISSION}`)
  await api("POST", `/api/session/${bravo}/permission/${request.id}/reply`, { decision: "once" })
  await expectTab("answered while unfocused shows the bell", work.tabId, `Alpha ${SEEN} │ Bravo ${UNSEEN}`)
  await focus(paneB)
  await expectTab("focusing the pane marks it seen", work.tabId, `Alpha ${SEEN} │ Bravo ${SEEN}`)

  const longA = "Alpha session with a deliberately long title"
  const longB = "Bravo session with another long title"
  await renameSession(alpha, longA)
  await renameSession(bravo, longB)
  await expectTab("too long: the focused session plus the other icon", work.tabId, `${longB} ${SEEN} +${SEEN}`)
  await focus(paneA)
  await expectTab("switching panes switches the tab", work.tabId, `${longA} ${SEEN} +${SEEN}`)
  await focus(paneB)
  await expectTab("switching back", work.tabId, `${longB} ${SEEN} +${SEEN}`)
  await focus(shell)
  await expectTab("focusing a shell keeps the last focused session", work.tabId, `${longB} ${SEEN} +${SEEN}`)

  // A third OpenCode on its home screen: it shows nothing and must not fight.
  await focus(shell)
  await zellij("action", "new-pane", "--", "bash", "-c", opencodeCommand())
  const home = (await panes()).filter((pane) => pane.tab_id === work.tabId).sort((a, b) => b.id - a.id)[0].id
  await sleep(8_000)
  await focus(home)
  await expectTab("an OpenCode on its home screen doesn't change the tab", work.tabId, `${longB} ${SEEN} +${SEEN}`)

  await quit(paneB)
  await expectTab("quitting one session leaves the other", work.tabId, `${longA} ${SEEN}`)
  await quit(paneA)
  await expectTab("with only a home screen left the tab gets its name back", work.tabId, "work")

  // A crash of the writer pane: the other pane takes over.
  const charlie = await createSession("Charlie")
  const delta = await createSession("Delta")
  const crash = await addTab("crash", [opencodeCommand(charlie), opencodeCommand(delta)])
  await expectTab("second tab shows both sessions", crash.tabId, `Charlie ${SEEN} │ Delta ${SEEN}`, { within: 30_000 })
  const pid = opencodePid(crash.paneIds[0])
  if (!pid) fail("found the writer's process", "not found")
  else {
    process.kill(pid, "SIGKILL")
    await expectTab("after a crash the surviving pane takes over", crash.tabId, `Delta ${SEEN}`)
  }
  await expectTab("the first tab is unaffected", work.tabId, "work", { hold: 1_000 })
  await quit(crash.paneIds[1])
  await expectTab("the last pane to quit restores the tab name", crash.tabId, "crash")

  // One OpenCode next to a shell, started while the shell is focused.
  const echo = await createSession("Echo")
  const solo = await addTab("solo", [undefined, opencodeCommand(echo)])
  await focus(solo.paneIds[0])
  await expectTab("a lone OpenCode pane names the tab as before", solo.tabId, `Echo ${SEEN}`, { within: 30_000 })
  await renameSession(echo, "-v flag regression")
  await expectTab("a title starting with a dash still renames the tab", solo.tabId, `-v flag regression ${SEEN}`)
}

try {
  await setup()
  await scenarios()
} catch (error) {
  fail("harness", error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await teardown()
}

console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures === 0 ? 0 : 1)
