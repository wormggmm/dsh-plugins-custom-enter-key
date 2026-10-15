# dsh-plugins-custom-enter-key

A DeepSeek Harness (DSH) web plugin that **swaps the chat composer's Enter
gestures**:

- **Enter** → line break (no send)
- **Ctrl + Enter** (Cmd + Enter on macOS) → send
- **Shift + Enter** → always a line break (native, never intercepted)

Each key is configurable on its own in Settings → General → "Submit keys":
`Newline` / `Send` / `DSH default` (leave the key to DSH).

## Defaults

| Key | Default | Options |
|---|---|---|
| `Enter` | Newline | Newline / Send / DSH default |
| `Ctrl + Enter` (or `Cmd + Enter`) | Send | Newline / Send / DSH default |
| `Shift + Enter` | Newline (native, not intercepted) | — |

"DSH default" hands that key back to DSH as if the plugin were not installed,
so selecting it for both keys restores the shipped behavior — as does turning
the plugin's row off on the Plugins page.

## Install

The plugin is a standard dsh bundle (`dsh.bundle.patch` plus a `dsh.client`
browser half) installed **from a local directory**. There is **no build step**:
no TypeScript, no bundler, no dependencies.

Note: `dsh plugin ... add` only installs the dependency; a bundle also has to
be **selected** (listed in the profile's `dsh.profile.bundles`) before its
patch layer mounts. Pick one of these three paths.

### 1. Ask the agent inside dsh (recommended)

Say "install `C:\my_github\dsh-plugins-custom-enter-key` into the current
profile". The agent calls `plugin_manager`'s `install_bundle` with the absolute
directory as its target, which installs and selects the bundle in one step and
reports the `application` outcome. (The tool is available in Creator mode.)

### 2. Web Plugins page

The sidebar's **Plugins** page installs and toggles the profile's bundles; the
bundle switch is the `dsh.profile.bundles` list. Install the plugin there, then
turn its switch on.

### 3. CLI (two manual steps)

```sh
# 1. install the dependency (arguments are forwarded to pnpm in the profile)
dsh plugin --profile web add /absolute/path/dsh-plugins-custom-enter-key

# 2. select the bundle: append the package name to dsh.profile.bundles in
#    ~/.dsh/profiles/web/package.json
```

### Activate and remove

- A newly installed bundle usually activates through HMR. **Replacing the code
  of an installed package needs a `dsh web` restart** (the browser bundle is a
  lazily materialized module factory; reloading the page has the same
  requirement).
- Disable: the bundle switch on the Plugins page, or the plugin row's own
  switch (which writes `disabled: true` into the profile's `cordis.patch.yml`).
- Remove: `dsh plugin --profile web remove dsh-plugins-custom-enter-key`, then
  drop the name from `dsh.profile.bundles`.

## Configuration

Settings → General → "Submit keys" holds one row with a segmented control per
intercepted key.

The configuration lives in browser **localStorage** (`dsh.customEnterKey.v1`,
per origin) and survives restarts. It is independent of the profile
configuration; clearing site data restores the defaults.

## How it works

1. **Interception point**: a **capture-phase** `keydown` listener on
   `document`. The composer arbitrates Enter inside the shell-owned Lexical
   editor (`KEY_ENTER_COMMAND` at `COMMAND_PRIORITY_CRITICAL`), and Lexical
   only ever walks priorities 4 → 0, so no plugin can outrank it; a capture
   listener runs before the editor root's own listener and is the one seam a
   bundle plugin has. The matched gesture is `preventDefault()`ed and
   `stopPropagation()`ed, so the composer never sees the Enter.
2. **Line breaks** replay the composer's own Shift+Enter gesture on the editor
   root (`new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true,
   bubbles: false })`). That event walks the original path (the harness keymap
   deliberately leaves Shift+Enter to the native route → `@lexical/plain-text`
   → `INSERT_LINE_BREAK_COMMAND`), so the caret, the undo history and reference
   chips behave exactly as after a real Shift+Enter. `bubbles: false` keeps
   window-level shortcut observers out of it, and a `replaying` flag stops the
   plugin from processing its own replay.
3. **Sending** resolves the session from the event target
   (`[data-conversation-session]`), then calls
   `ctx.conversation.input.for(actx).submit('queue', 'enter')` — the public
   input facade (`SessionInput.submit`), the same channel the composer uses,
   including slash-command arbitration, reference serialization and draft
   clearing.
4. **Pass-through cases** (system behavior preserved): IME composition
   (`isComposing`, legacy `keyCode 229`, the composer's
   `data-composer-composing` watch), an open `@`/`/` menu
   (`[data-trigger-menu]`, where Enter picks the highlighted item),
   `Alt + Enter`, `Ctrl + Shift + Enter`, `Shift + Enter`, focus outside the
   composer (`[data-composer-input]`), the session-less inert composer, and a
   gesture an earlier listener already claimed (`event.defaultPrevented`).

5. **Key repeat**: `newline` repeats like a native Shift+Enter; `send` ignores
   `event.repeat` so holding Enter cannot machine-gun messages.

## Known limitations

- **Web GUI only**: the manifest declares `platform: web`; the Desktop client
  does not load it.
- **Ctrl + Enter always delivers a queued send**: immediate while the session
  is idle, queued while its agent runs. It does not follow DSH's "busy-Enter
  behavior" preference; with that preference set to `steer`, this plugin's
  Ctrl + Enter still queues. Set Ctrl + Enter to "DSH default" to keep the
  shipped accelerated gesture.
- **Composer DOM contracts** it depends on: `[data-composer-input]` (the
  editable host), `[data-conversation-session]` plus
  `dataset.conversationSession` (session ownership), `[data-trigger-menu]`
  (menu pass-through) and `data-composer-composing` (composition
  pass-through). If a future dsh release changes them, the plugin degrades
  silently to the shipped behavior (no error, no broken input); update the
  selector set at the top of `client.js` to match.
- It does not take over the Send button (still the "Enter gesture"), and it
  leaves the built-in "busy-Enter behavior" settings row untouched.

## Checks and development

```sh
node test/smoke.mjs      # 63 pure-logic checks: settings, decision table, row wiring, persistence
node --check client.js   # syntax check
```

`test/smoke.mjs` loads `client.js` into a fake module-loader plus fake DOM
environment: no browser, no dependencies, safe to run on every change.

### Layout

| File | Purpose |
|---|---|
| `package.json` | `dsh.bundle.patch` (bundle) + `dsh.client` (browser half: `platform`, `inject`) |
| `cordis.patch.yml` | Bundle patch inserting the plugin row |
| `index.js` | Host half (empty; the row still needs a valid module) |
| `client.js` | Browser half: the `__ModuleLoader__` factory with the key interceptor, Settings row and dictionaries |
| `locale/zh.json`, `locale/en.json` | Title/description shown on the Plugins page |
| `icon.svg` | Plugin icon (original artwork with explicit colors, legible on light and dark themes) |
| `test/smoke.mjs` | Dependency-free smoke test |

## Compatibility

Built and verified against **dsh 0.2.1-alpha.2** (Lexical composer, `ctx.slots`,
the `settings.general.item` seat, `ctx.conversation.input`). It does not apply
to the older textarea composer generation (`data-phase="inert"`).

## License

Unspecified; add a `LICENSE` before publishing.

## Credits

- Configuration approach and the localStorage scheme follow
  <https://github.com/aberter0x3f/dsh-custom-enter-key>.
- dsh: <https://github.com/deepseek-harness/deepseek-harness>
