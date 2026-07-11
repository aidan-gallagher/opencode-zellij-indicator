# opencode-zellij-indicator

**Know which of your OpenCode agents needs you — without switching tabs.**

When you run several [OpenCode](https://opencode.ai) sessions across
[Zellij](https://zellij.dev) tabs, they all look identical. You can't see which
one is still grinding, which is silently waiting for you to approve something,
and which finished five minutes ago. So you keep clicking through them.

## The five states

| Icon | When | What it means for you |
|------|------|-----------------------|
| ⏳ | working | OpenCode is busy — ignore it for now |
| 🔁 | retrying | a request failed; OpenCode is backing off and retrying — usually nothing to do |
| ❓ | needs you | blocked on a permission prompt or a question — go unblock it |
| 🔔 | done, unseen | it finished while you were away — go check the result |
| ✅ | done, seen | finished, and you've already looked |

## Example

![OpenCode status icons on each Zellij tab](docs/tab-states.png)

## Naming

OpenCode gives each session an auto-generated title, and the plugin uses that as the Zellij tab name. To change it, run OpenCode's built-in `/rename` slash command.

## Install

**1. Install Zellij and OpenCode.**  
Requires Zellij ≥ 0.44.0

**2. Enable the plugin.**   
Add the following to your `opencode.json`
```json
{
  "plugin": ["opencode-zellij-indicator"]
}
```

**3. Run OpenCode inside Zellij.**
```sh
zellij      # opens the Zellij workspace
opencode    # run this inside Zellij
```

That single tab now shows OpenCode's status. To feel the point of the plugin,
open more tabs and run OpenCode in each — press `Ctrl t` then `n` for a new
tab (`Ctrl t` then the arrow keys to switch between them).

## Configuration
### Stopwatch

To see how long a session has been running, set `OPENCODE_ZELLIJ_STOPWATCH=1` an environment variable before launching OpenCode:

```sh
OPENCODE_ZELLIJ_STOPWATCH=1 opencode
```

After a session has been running for a minute, the stopwatch appears next to the icon (the number is minutes):

![Stopwatch on a running tab](docs/stopwatch.png)

### Sound

To play a sound when OpenCode completes a task in a background Zellij task set `OPENCODE_ZELLIJ_SOUND=1` an environment variable before launching OpenCode:

```sh
OPENCODE_ZELLIJ_SOUND=1 opencode
```

If you don't like the default noise, you can customize the sound command.
with `OPENCODE_ZELLIJ_SOUND_CMD`
```sh
OPENCODE_ZELLIJ_SOUND=1 OPENCODE_ZELLIJ_SOUND_CMD="pw-play ~/alert.wav" opencode
```




