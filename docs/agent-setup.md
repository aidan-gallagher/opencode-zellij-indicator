# Setup instructions for an agent

These are instructions **for an AI coding agent** setting up
`opencode-zellij-indicator` on the user's machine. Work through the steps in order. Prefer the user's OS package manager for installs, and confirm before editing config or shell files.

## 1. Install Zellij

Check whether Zellij is already installed and print its version:

```sh
zellij --version
```

Requires **Zellij ≥ 0.44.0**. If it's missing or older, install/upgrade it (via the user's package manager, `cargo install zellij`, or the official binary).

## 2. Ensure OpenCode is installed

```sh
opencode --version
```

If it's missing, install it per <https://opencode.ai>.

## 3. Install the plugin

Add the plugin to the user's **global** OpenCode config at
`~/.config/opencode/opencode.json` 
- If the file exists, merge `"opencode-zellij-indicator"` into the existing   `plugin` array (don't clobber other plugins). The file may be `.json` or `.jsonc`. 
- If it doesn't exist, create it:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-zellij-indicator"]
}
```

Outside Zellij the plugin does nothing (it exits immediately), so it's safe everywhere.

## 4. Check for a colliding notification setup

The plugin plays an attention sound **by default**, so check for a collision now — otherwise the user may get double notifications when a session finishes:

- Look at the `plugin` array in `opencode.json` for any other
  notification/sound plugins.
- Check `~/.config/opencode/tui.json` for OpenCode's built-in attention sound (the `attention.sound` / `attention.notifications` keys). Most users won't have a `tui.json` at all — that's fine.

If something already plays a sound when a session needs attention, tell the user that the plugin's sound would double up, and have them pick one (disable the other, or disable the plugin's sound with `OPENCODE_ZELLIJ_SOUND=0` in step 5).

## 5. Default features — ask if they want to disable any

The **stopwatch** and **attention sound** are both **on by default** — no env vars needed to enable them:

- **Stopwatch** — shows how long a session has been running next to the icon.
- **Attention sound** — plays a sound when a background tab needs you: OpenCode finishes (🔔) or hits a permission/question prompt (❓).

Ask the user whether they'd like to disable either (and disable the sound if the step 4 collision check found a conflict). To disable, set the relevant **environment variable** to `0` where the user's shell loads env vars. **Ask the user where they keep theirs** — e.g.
`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, or `~/.profile` — then append only the opt-outs they chose to that file. For example:

```sh
export OPENCODE_ZELLIJ_STOPWATCH=0
export OPENCODE_ZELLIJ_SOUND=0
```

(Fish uses `set -gx OPENCODE_ZELLIJ_STOPWATCH 0` instead.)

To override the default sound with a custom command instead of disabling it, set `OPENCODE_ZELLIJ_SOUND_CMD="pw-play ~/alert.wav"`.

## 6. Verify

Confirm:

- `zellij --version` reports ≥ 0.44.0.
- `opencode-zellij-indicator` is in the `plugin` array of
  `~/.config/opencode/opencode.json`.
- Any opt-out env vars the user chose are written to their shell config.
- There's no unresolved sound collision (if there was one, the plugin's sound is disabled with `OPENCODE_ZELLIJ_SOUND=0`).

Then tell the user to try it: open a fresh shell (so the env vars load), run `zellij`, then run `opencode` inside it, and send their first prompt - a status icon should appear on the tab.
