/**
 * dsh-plugins-custom-enter-key — browser half.
 *
 * Swaps the chat composer's Enter gestures: plain Enter inserts a line break,
 * Ctrl/Cmd + Enter sends the draft. Each key's behavior is configured on its
 * own in Settings → General ("输入快捷键" / "Submit keys") and persisted in
 * this origin's localStorage.
 *
 * Why a document-capture keydown listener
 * --------------------------------------
 * The composer bar arbitrates Enter inside the shell-owned Lexical editor
 * (`KEY_ENTER_COMMAND` at COMMAND_PRIORITY_CRITICAL). Lexical's command loop
 * walks priorities 4 → 0, so CRITICAL is the highest reachable slot and a
 * second registration can never outrank the bar's; the public input faces
 * (`inputActions`, `SessionInput`) also expose no "insert a line break" verb.
 * A document-capture keydown is the one seam left to a bundle plugin: it runs
 * before the editor root's own listener, so claiming the gesture there both
 * suppresses the submit and keeps Lexical's state untouched.
 *
 * Line breaks then ride the composer's own Shift+Enter gesture: a replayed
 * keydown on the editor root goes through the harness keymap (which
 * deliberately leaves Shift+Enter to the native path), Lexical's plain-text
 * plugin and its INSERT_LINE_BREAK_COMMAND. Caret, undo history and reference
 * chips therefore behave exactly as after a real Shift+Enter.
 *
 * Format: window.__ModuleLoader__ factory bundle (the client-modules
 * contract). React and the UI primitives come from the frozen browser module
 * table; nothing else is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins-custom-enter-key',
  factory(require) {
    const React = require('react')
    const { SegmentedControl } = require('@deepseek-ai/dsh-client-ui-primitives')

    // ----------------------------------------------------------------- settings

    /** Dictionary namespace owned by this plugin. */
    const NS = 'custom-enter-key'
    /** Browser-local persistence key (one settings document per origin). */
    const STORAGE_KEY = 'dsh.customEnterKey.v1'
    /** Behaviors a key may be bound to, in selector order. */
    const BEHAVIORS = ['newline', 'send', 'stock']
    /** Shipped default: the requested swap — Enter breaks the line, Ctrl + Enter sends. */
    const DEFAULTS = { enter: 'newline', ctrlEnter: 'send' }

    /** Whether a stored value names an accepted behavior. */
    function isBehavior(value) {
      return typeof value === 'string' && BEHAVIORS.includes(value)
    }

    /** Read the persisted per-key behaviors, falling back per field to the defaults. */
    function readSettings() {
      let parsed = null
      try {
        parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
      } catch (error) {
        // Unreadable document (storage blocked, foreign value): defaults win.
        return { ...DEFAULTS }
      }
      const source = typeof parsed === 'object' && parsed !== null ? parsed : {}
      return {
        enter: isBehavior(source.enter) ? source.enter : DEFAULTS.enter,
        ctrlEnter: isBehavior(source.ctrlEnter) ? source.ctrlEnter : DEFAULTS.ctrlEnter,
      }
    }

    /** Live behaviors read by the interceptor (module scope: one per page). */
    let settings = readSettings()
    /** Settings-row subscribers; a write republishes to each of them. */
    const settingsListeners = new Set()

    /** Persist and publish one complete settings document. */
    function writeSettings(next) {
      settings = next
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (error) {
        // Storage disabled: the in-memory value still drives this page.
      }
      for (const listener of Array.from(settingsListeners)) listener(next)
    }

    /**
     * Observe settings writes.
     * @param listener - called with the new document after every write.
     * @returns the unsubscriber.
     */
    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    }

    // ----------------------------------------------------------- composer surface

    /** The composer's editable host for one key event, or null when the event is elsewhere. */
    function composerInputOf(target) {
      const input = target?.closest?.('[data-composer-input]') ?? null
      if (input === null) return null
      // A session-less composer renders the same host unbound (inert); the bar
      // only makes it editable while a session owns the input.
      if (input.isContentEditable !== true && input.getAttribute('contenteditable') !== 'true') return null
      return input
    }

    /** The Session id owning the composer an event landed in. */
    function sessionIdOf(target) {
      const id = target?.closest?.('[data-conversation-session]')?.dataset?.conversationSession
      return typeof id === 'string' && id !== '' ? id : undefined
    }

    /** Whether an open trigger menu (the slash/@ pipeline) arbitrates Enter right now. */
    function menuOpen(input) {
      if (document.querySelector('[data-trigger-menu]') !== null) return true
      const scope = input.getRootNode?.()
      return scope !== undefined && scope !== document && typeof scope.querySelector === 'function'
        && scope.querySelector('[data-trigger-menu]') !== null
    }

    /**
     * Whether a keystroke belongs to an input-method composition: the standard
     * flag, the legacy keyCode engines emit without it, or the composer's own
     * composition watch (Safari delivers the closing keydown after
     * compositionend).
     */
    function composing(event, input) {
      return event.isComposing === true || event.keyCode === 229
        || input.hasAttribute('data-composer-composing')
    }

    // ------------------------------------------------------------------ effects

    /** True while a gesture this plugin replayed is being handled. */
    let replaying = false

    /**
     * Insert one line break at the caret by replaying the composer's own
     * Shift+Enter gesture on the editor root. The replayed event does not
     * bubble: the composer's machinery listens on the root element itself,
     * while window-level shortcut observers stay untouched.
     * @param input - the composer's editable host.
     */
    function insertLineBreak(input) {
      replaying = true
      try {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          shiftKey: true, bubbles: false, cancelable: true,
        }))
      } finally {
        replaying = false
      }
    }

    /**
     * Deliver the draft as one ordinary message: immediate while the session is
     * idle, queued while its agent runs — the plain-Enter delivery the shipped
     * composer uses under the default busy-Enter preference.
     * @param ctx - client root context.
     * @param target - the keydown's original target.
     */
    function sendMessage(ctx, target) {
      const sessionId = sessionIdOf(target)
      if (sessionId === undefined) return
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      try {
        ctx.conversation.input.for(binding.ctx).submit('queue', 'enter')
      } catch (error) {
        // The session can retire between the keystroke and this call; the next
        // keystroke resolves a fresh binding, so a dropped gesture is safe.
      }
    }

    /**
     * Install the capture-phase Enter interceptor.
     * @param ctx - client root context (services are read at event time).
     * @returns the disposer detaching the listener.
     */
    function installInterceptor(ctx) {
      const onKeyDown = (event) => {
        if (replaying) return
        if (event.defaultPrevented) return // an earlier listener already claimed the gesture
        if (event.key !== 'Enter') return
        if (event.altKey) return // Alt+Enter and AltGraph belong to the application
        const input = composerInputOf(event.target)
        if (input === null) return
        if (event.shiftKey) return // Shift+Enter already breaks the line natively
        if (composing(event, input)) return
        if (menuOpen(input)) return // an open trigger menu arbitrates Enter itself
        const behavior = event.ctrlKey || event.metaKey ? settings.ctrlEnter : settings.enter
        if (behavior === 'stock') return
        // Claim the gesture before the editor root's keymap sees it.
        event.preventDefault()
        event.stopPropagation()
        if (behavior === 'newline') {
          insertLineBreak(input)
          return
        }
        if (event.repeat) return // a held key must not send repeatedly
        sendMessage(ctx, event.target)
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => { document.removeEventListener('keydown', onKeyDown, true) }
    }

    // ----------------------------------------------------------------- settings row

    /** Stylesheet owned by this plugin's Settings row (the app's tokens keep it native). */
    const ROW_CSS = `
.dsh-cek-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-cek-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 48px;
}
.dsh-cek-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.dsh-cek-desc {
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cek-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-cek-line {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.dsh-cek-line-label {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
`

    /** Append the row stylesheet; returns its removal for the plugin's disposal. */
    function installStyles() {
      const style = document.createElement('style')
      style.textContent = ROW_CSS
      document.head.append(style)
      return () => { style.remove() }
    }

    /** The accelerator keycap label for this device (both modifiers are accepted at runtime). */
    const ACCELERATED_LABEL = /mac|darwin|iphone|ipad/i.test(navigator.platform ?? '')
      ? 'Cmd + Enter'
      : 'Ctrl + Enter'

    /**
     * Render one labeled behavior selector.
     * @param id - stable element id for the tablist.
     * @param label - keycap label.
     * @param value - current behavior.
     * @param onChange - behavior writer.
     * @param t - namespace-bound translator.
     * @returns the selector line.
     */
    function behaviorLine(id, label, value, onChange, t) {
      return React.createElement('div', { className: 'dsh-cek-line', key: id },
        React.createElement('span', { className: 'dsh-cek-line-label' }, label),
        React.createElement(SegmentedControl, {
          id,
          value,
          label,
          options: BEHAVIORS.map(behavior => ({
            value: behavior,
            label: t(`behavior.${behavior}`),
            title: t(`behavior.${behavior}.hint`),
          })),
          onChange,
        }))
    }

    /**
     * General Settings row: one behavior selector per intercepted key.
     * @param props - composed Settings slot props (locale seat included).
     * @returns the preference row.
     */
    function SubmitKeysRow({ t }) {
      const [current, setCurrent] = React.useState(settings)
      React.useEffect(() => subscribeSettings(setCurrent), [])
      const change = (key, behavior) => { writeSettings({ ...settings, [key]: behavior }) }
      return React.createElement('div', { className: 'dsh-cek-row' },
        React.createElement('div', { className: 'dsh-cek-text' },
          React.createElement('div', { className: 'dsh-cek-title' }, t('settings.title')),
          React.createElement('div', { className: 'dsh-cek-desc' }, t('settings.description'))),
        React.createElement('div', { className: 'dsh-cek-controls' },
          behaviorLine('dsh-cek-enter', 'Enter', current.enter,
            behavior => { change('enter', behavior) }, t),
          behaviorLine('dsh-cek-ctrl-enter', ACCELERATED_LABEL, current.ctrlEnter,
            behavior => { change('ctrlEnter', behavior) }, t)))
    }

    // ----------------------------------------------------------------- dictionaries

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'settings.title': '输入快捷键',
      'settings.description': 'Enter 换行、Ctrl + Enter 发送（默认）。Shift + Enter 始终保持换行。',
      'behavior.newline': '换行',
      'behavior.newline.hint': '插入一个换行，不发送',
      'behavior.send': '发送',
      'behavior.send.hint': '立即发送；Agent 忙碌时进入队列',
      'behavior.stock': '系统默认',
      'behavior.stock.hint': '不接管这个键，保持 DSH 默认行为',
    }

    /** English dictionary, checked complete against the same key set. */
    const en = {
      'settings.title': 'Submit keys',
      'settings.description': 'Enter breaks the line and Ctrl + Enter sends (default). Shift + Enter always breaks the line.',
      'behavior.newline': 'Newline',
      'behavior.newline.hint': 'Insert a line break without sending',
      'behavior.send': 'Send',
      'behavior.send.hint': 'Send now; queued while the agent is busy',
      'behavior.stock': 'DSH default',
      'behavior.stock.hint': 'Leave this key to DSH\u2019s built-in behavior',
    }

    return {
      inject: ['slots', 'sessions', 'conversation', 'locale'],
      /**
       * Browser plugin body: the composer key interceptor plus its Settings row.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'custom-enter-key: dictionaries')
        ctx.effect(() => installStyles(), 'custom-enter-key: row styles')
        ctx.effect(() => installInterceptor(ctx), 'custom-enter-key: composer key interceptor')
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'custom-enter-key',
          order: 30,
          locale: NS,
        }, SubmitKeysRow))
      },
    }
  },
})
