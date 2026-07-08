# opencode-zellij-status

A tiny [opencode](https://opencode.ai) plugin that shows each opencode session's
state on its [Zellij](https://zellij.dev) tab — so when you run one opencode per
tab you can tell at a glance which ones are busy and which want you.

It's **just an opencode plugin**. No fork, no WASM, no status-bar replacement.
It shells out to the `zellij` CLI (`rename-tab-by-id`) and does nothing when not
running inside Zellij.

## What you see

The tab label becomes `<opencode session title> <icon>`, with four states:

| State | Default icon | Meaning |
|-------|--------------|---------|
| running | 🔴 | opencode is working |
| permission | ❓ | waiting on you — a permission prompt, an interactive `question`, or the plan-mode "switch to build agent?" prompt (always stands out, even when focused) |
| done, unseen | 🟢 | finished and you haven't looked yet |
| done, seen | ⚪ | finished and you've since focused that tab |

Icons only appear once a session actually does something; a fresh tab is left
alone. When the session is deleted, the original tab name is restored.

## How it works

- Finds its own tab: `zellij action list-panes --json` → the pane whose `id`
  matches `$ZELLIJ_PANE_ID` → its `tab_id`.
- Sets the label: `zellij action rename-tab-by-id <tab_id> "<title> <icon>"`
  (targets the right tab even when it isn't focused).
- Detects "seen": while in the unseen state it polls `zellij action list-clients`;
  when the focused pane is `terminal_<id>` (you're looking at the tab) it flips to
  the seen icon.

State is driven by opencode hooks: `chat.message` / `tool.execute.before` →
running; `permission.ask` → attention; `session.idle` / `session.error` → done;
subagent (`parentID`) idles are ignored so the tab stays "running" until the root
session finishes. The interactive `question` and `plan_exit` tools block waiting
for you, so `tool.execute.before` for those shows the attention icon instead of
running (and `tool.execute.after` flips back once you've answered).

## Install

Symlink into opencode's plugin dir (auto-loaded at startup):

```sh
mkdir -p ~/.config/opencode/plugins
ln -sf "$PWD/src/index.ts" ~/.config/opencode/plugins/zellij-status.ts
```

Note the directory is `plugins` (**plural**) — `plugin/` is silently ignored.

(Or publish to npm and add it to `opencode.json`'s `plugin` array.)

## Configure

Override any icon (or the poll interval) via env vars:

```sh
OPENCODE_ZELLIJ_ICON_RUNNING="⚡"
OPENCODE_ZELLIJ_ICON_PERMISSION="❓"
OPENCODE_ZELLIJ_ICON_ATTENTION="🟢"
OPENCODE_ZELLIJ_ICON_SEEN="○"
OPENCODE_ZELLIJ_POLL_MS="1500"
OPENCODE_ZELLIJ_DEBUG="1"   # log to opencode's server log for troubleshooting
```

### Debugging

Set `OPENCODE_ZELLIJ_DEBUG=1` and the plugin logs its lifecycle (init, resolved
tab, every rename, focus transitions, and any `zellij` command failures) to
opencode's **server log** — the quickest way to tell whether it loaded and what
it's doing. If you see nothing at all, the plugin isn't being loaded: make sure
the file is under `~/.config/opencode/plugins/` (**plural**).

If you see `list-panes failed` (empty output) but `zellij` works fine in your
shell, you're probably using the **snap** build of zellij. Snap zellij emits no
output when spawned without a PTY (i.e. from opencode), so the plugin can't read
the tab list. Fix: install a **native** zellij instead — grab the official static
binary from [releases](https://github.com/zellij-org/zellij/releases) (e.g.
`zellij-x86_64-unknown-linux-musl.tar.gz`) into `~/.local/bin`, or
`cargo install zellij`, and make sure it precedes `/snap/bin` on your `PATH`.

## Verify

```sh
bun run typecheck
```

Then, inside Zellij, run opencode in a couple of tabs and set them working — tabs
turn 🔴 while busy, ❓ when awaiting permission, 🟢 when done and you haven't
looked, ⚪ once you focus them.
