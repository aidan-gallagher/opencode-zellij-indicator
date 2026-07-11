// ---------------------------------------------------------------------------
// Sound notification when a turn finishes while you're NOT looking at its tab
// (the 🔔 "done, unseen" state). Opt-in, off by default.
//   OPENCODE_ZELLIJ_BEEP=1            enable
//   OPENCODE_ZELLIJ_BEEP_CMD="..."    run this command instead of the built-in
//                                     player (e.g. "pw-play ~/alert.wav")
// When BEEP_CMD is unset we play the bundled WAV via the first audio player we
// find. If no player exists we silently do nothing — audio is never guaranteed.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url"
import { log } from "./config"
import type { Shell } from "./zellij"

const BEEP_ENABLED = process.env.OPENCODE_ZELLIJ_BEEP === "1"
const BEEP_CMD = (() => {
  const v = process.env.OPENCODE_ZELLIJ_BEEP_CMD
  return v && v.length > 0 ? v : undefined
})()
const BUNDLED_SOUND = fileURLToPath(new URL("../sounds/complete.wav", import.meta.url))
// Ordered by preference; the first one present on the system wins. aplay/paplay
// handle WAV; ffplay is the catch-all. macOS uses afplay.
const BEEP_PLAYERS: Array<[string, string[]]> =
  process.platform === "darwin"
    ? [["afplay", [BUNDLED_SOUND]]]
    : [
        ["paplay", [BUNDLED_SOUND]],
        ["pw-play", [BUNDLED_SOUND]],
        ["aplay", ["-q", BUNDLED_SOUND]],
        ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", BUNDLED_SOUND]],
      ]

let lastBeepAt = 0

// Fire-and-forget notification sound. Fully swallows errors and never blocks
// the event loop, so a missing player or audio glitch can never break the
// plugin. A short time-guard stops accidental double-beeps.
export async function beep($: Shell) {
  if (!BEEP_ENABLED) return
  const now = Date.now()
  if (now - lastBeepAt < 2000) return
  lastBeepAt = now
  try {
    if (BEEP_CMD) {
      log(`beep via BEEP_CMD: ${BEEP_CMD}`)
      await $`sh -c ${BEEP_CMD}`.quiet().nothrow()
      return
    }
    for (const [cmd, args] of BEEP_PLAYERS) {
      try {
        const res = await $`${cmd} ${args}`.quiet().nothrow()
        if (res.exitCode === 0) {
          log(`beep via ${cmd}`)
          return
        }
      } catch {
        // try the next player
      }
    }
    log("beep: no working audio player found")
  } catch (e) {
    log(`beep failed: ${e instanceof Error ? e.message : "unknown"}`)
  }
}
