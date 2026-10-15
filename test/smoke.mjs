/**
 * Pure-JS smoke test for client.js: loads the browser bundle into a fake
 * module-loader environment and drives the interceptor through a fake DOM.
 * No browser, no dependencies, no build step.
 *
 * Run: node test/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'client.js'), 'utf8')
const STORAGE_KEY = 'dsh.customEnterKey.v1'
const SESSION_ID = 'session-1'

// --------------------------------------------------------------------- harness

let failures = 0
let checks = 0

/** Assert one expectation, reporting every failure instead of throwing the first. */
function ok(condition, what) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`  ✗ ${what}`)
}

/** Assert deep equality for JSON-shaped values. */
function equal(actual, expected, what) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${what} (got ${JSON.stringify(actual)})`)
}

/** Fake document with a swappable trigger-menu answer and listener bookkeeping. */
function createDocument() {
  const listeners = []
  let triggerMenu = false
  return {
    listeners,
    setTriggerMenu: value => { triggerMenu = value },
    querySelector: selector => (selector === '[data-trigger-menu]' && triggerMenu ? {} : null),
    addEventListener: (type, handler, capture) => { listeners.push({ type, handler, capture }) },
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex(entry => entry.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
    createElement: () => ({ textContent: '', remove() {} }),
    head: { append() {} },
  }
}

/** Fake localStorage backing one settings document. */
function createStorage(initial) {
  const map = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]])
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

/** Fake KeyboardEvent: records the init fields the plugin and the app read. */
class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
    this.defaultPrevented = false
    this.propagationStopped = false
  }

  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}

/** Fake composer editable host. */
function createInput({ composing = false, onDispatch } = {}) {
  return {
    isContentEditable: true,
    hasAttribute: name => (name === 'data-composer-composing' ? composing : false),
    getAttribute: name => (name === 'contenteditable' ? 'true' : null),
    getRootNode: () => documentFake,
    dispatchEvent(event) {
      replayed.push(event)
      onDispatch?.(event)
      return true
    },
  }
}

/**
 * Fake event target resolving the same DOM contract the composer renders.
 * `sessionId: null` models a composer the target cannot address.
 */
function createTarget({ input, sessionId = SESSION_ID }) {
  return {
    closest: (selector) => {
      if (selector === '[data-composer-input]') return input
      if (selector !== '[data-conversation-session]') return null
      return sessionId === null || sessionId === undefined
        ? null
        : { dataset: { conversationSession: sessionId } }
    },
  }
}

/** One keydown event as the browser would deliver it. */
function keyEvent(init = {}) {
  return Object.assign(new FakeKeyboardEvent('keydown'), { key: 'Enter', ...init })
}

/** Deliver one keydown through the plugin's interceptor and return it. */
function press(handler, event, target) {
  event.target = target
  handler(event)
  return event
}

/** Effect counters of one gesture window (boot() resets the replay log, so every
 * assertion compares deltas). */
function counters(ctx) {
  return { replayed: replayed.length, submitted: ctx.calls.submitted.length }
}

/** Effects observed since the matching {@link counters} snapshot. */
function since(before, ctx) {
  return { replayed: replayed.length - before.replayed, submitted: ctx.calls.submitted.length - before.submitted }
}

/** Fake React and primitives tables for the bundle factory's require(). */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
}

const requireStub = (id) => {
  if (id === 'react') return reactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { SegmentedControl: function SegmentedControl() { return null } }
  }
  throw new Error(`unexpected require: ${id}`)
}

/** Fake cordis context recording every face the plugin asks for. */
function createContext() {
  const calls = { submitted: [], registered: [], dictionaries: [], effects: [] }
  return {
    calls,
    effect: (body, label) => { calls.effects.push({ label, dispose: body() }) },
    locale: {
      register: (namespace, dictionaries) => {
        calls.dictionaries.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        calls.registered.push({ options, component })
        return () => {}
      },
    },
    sessions: {
      binding: id => (id === SESSION_ID ? { ctx: { scopeId: id } } : undefined),
    },
    conversation: {
      input: {
        for: actx => ({
          submit: (mode, source) => { calls.submitted.push({ mode, source, scope: actx.scopeId }) },
        }),
      },
    },
  }
}

let documentFake
let replayed

/**
 * Load client.js into a fresh fake environment.
 * @param storage - settings document already present in localStorage.
 * @returns the registered bundle and the fake faces.
 */
function boot(storage) {
  documentFake = createDocument()
  replayed = []
  const windowFake = {
    localStorage: storage ?? createStorage(),
    __ModuleLoader__: { load: registration => { windowFake.registration = registration } },
  }
  const navigatorFake = { platform: 'Win32' }
  const globals = ['window', 'document', 'navigator', 'KeyboardEvent']
  // eslint-disable-next-line no-new-func -- the bundle is plain JS over scoped globals.
  new Function(...globals, SOURCE)(windowFake, documentFake, navigatorFake, FakeKeyboardEvent)
  ok(windowFake.registration !== undefined, 'the bundle registers itself through __ModuleLoader__.load')
  return {
    registration: windowFake.registration,
    plugin: windowFake.registration.factory(requireStub),
    storage: windowFake.localStorage,
  }
}

/** Depth-first search over the fake element tree. */
function findElement(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

/** Apply the plugin and hand back the interceptor it installed (asserting its phase). */
function interceptorOf(plugin, ctx) {
  plugin.apply(ctx)
  const entry = documentFake.listeners.find(listener => listener.type === 'keydown')
  ok(entry !== undefined && entry.capture === true, 'the interceptor listens on document capture')
  return entry.handler
}

// ----------------------------------------------------------------------- checks

console.log('dsh-plugins-custom-enter-key · client.js smoke')

// 1. bundle and plugin surface
{
  const { registration, plugin } = boot()
  ok(registration.id === 'dsh-plugins-custom-enter-key', 'the bundle id is the package name')
  equal(plugin.inject, ['slots', 'sessions', 'conversation', 'locale'], 'the plugin injects its four services')
  ok(typeof plugin.apply === 'function', 'the plugin exposes apply()')
}

// 2. apply wiring: dictionaries, styles, interceptor, Settings row
const ctx = createContext()
const pluginCtx = boot()
const handler = interceptorOf(pluginCtx.plugin, ctx)
equal(ctx.calls.dictionaries.length, 1, 'one dictionary registration')
equal(ctx.calls.dictionaries[0].namespace, 'custom-enter-key', 'the dictionary namespace')
const dictionary = ctx.calls.dictionaries[0].dictionaries
equal(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort(), 'zh and en carry one key set')
for (const key of ['settings.title', 'settings.description', 'behavior.newline', 'behavior.send', 'behavior.stock']) {
  ok(typeof dictionary.zh[key] === 'string' && typeof dictionary.en[key] === 'string', `dictionary key "${key}" is localized`)
}
equal(ctx.calls.effects.length, 3, 'three resource effects (dictionaries, styles, interceptor)')
equal(ctx.calls.registered.length, 1, 'one Settings row registration')
const row = ctx.calls.registered[0]
equal(
  [row.options.name, row.options.id, row.options.order, row.options.locale],
  ['settings.general.item', 'custom-enter-key', 30, 'custom-enter-key'],
  'the row registers into settings.general.item',
)
ok(typeof row.component === 'function', 'the row component is a function')

// 3. shipped default: plain Enter breaks the line, Ctrl + Enter sends
const input = createInput()
const target = createTarget({ input })
{
  const before = counters(ctx)
  const enter = press(handler, keyEvent(), target)
  ok(enter.defaultPrevented && enter.propagationStopped, 'plain Enter is claimed')
  equal(since(before, ctx), { replayed: 1, submitted: 0 }, 'plain Enter breaks the line and does not send')
  equal(
    { key: replayed[0].key, shiftKey: replayed[0].shiftKey, bubbles: replayed[0].bubbles, cancelable: replayed[0].cancelable },
    { key: 'Enter', shiftKey: true, bubbles: false, cancelable: true },
    'the replay is a non-bubbling Shift+Enter',
  )
}

// 4. the replay itself is never re-processed (no recursion, no double line break)
{
  const before = counters(ctx)
  let echoes = 0
  const echoing = createInput({ onDispatch: event => { echoes += 1; handler(event) } })
  press(handler, keyEvent(), createTarget({ input: echoing }))
  equal([echoes, since(before, ctx)], [1, { replayed: 1, submitted: 0 }], 'an echoing replay stops at one round')
}

// 5. Ctrl/Cmd + Enter sends the draft through that session's own scope
{
  const before = counters(ctx)
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = press(handler, keyEvent({ [modifier]: true }), target)
    ok(event.defaultPrevented && event.propagationStopped, `${modifier} + Enter is claimed`)
  }
  equal(since(before, ctx), { replayed: 0, submitted: 2 }, 'both accelerator modifiers send exactly one message')
  equal(ctx.calls.submitted[0], { mode: 'queue', source: 'enter', scope: SESSION_ID }, 'the send is a queued Enter delivery')
}

// 6. gestures the plugin must leave alone
for (const [what, init, preClaimed] of [
  ['Shift + Enter keeps its native line break', { shiftKey: true }],
  ['Alt + Enter belongs to the application', { altKey: true }],
  ['Ctrl + Shift + Enter belongs to the application', { ctrlKey: true, shiftKey: true }],
  ['IME composition keeps Enter (isComposing)', { isComposing: true }],
  ['IME composition keeps Enter (legacy keyCode 229)', { keyCode: 229 }],
  ['a gesture an earlier listener already claimed is respected', { defaultPrevented: true }, true],
]) {
  const before = counters(ctx)
  const event = press(handler, keyEvent(init), target)
  ok(!event.propagationStopped && (preClaimed === true || !event.defaultPrevented), what)
  equal(since(before, ctx), { replayed: 0, submitted: 0 }, `${what} — no effect`)
}

// 7. the composition watch attribute and an open trigger menu also pass through
{
  const composing = press(handler, keyEvent(), createTarget({ input: createInput({ composing: true }) }))
  ok(!composing.defaultPrevented, 'the composer composition watch keeps Enter')
  documentFake.setTriggerMenu(true)
  const menu = press(handler, keyEvent(), target)
  ok(!menu.defaultPrevented, 'an open trigger menu keeps Enter')
  documentFake.setTriggerMenu(false)
}

// 8. events outside the composer, and the inert (session-less) composer surface
{
  const outside = press(handler, keyEvent(), { closest: () => null })
  ok(!outside.defaultPrevented, 'a keydown outside the composer is untouched')
  const inertInput = createInput()
  inertInput.isContentEditable = false
  inertInput.getAttribute = () => 'false'
  const inert = press(handler, keyEvent(), createTarget({ input: inertInput }))
  ok(!inert.defaultPrevented, 'the inert composer surface is untouched')
}

// 9. a session the DOM cannot address, and one that retires mid-gesture
{
  const before = counters(ctx)
  const orphan = press(handler, keyEvent({ ctrlKey: true }), createTarget({ input, sessionId: null }))
  ok(orphan.defaultPrevented, 'an unaddressable session still claims the gesture')
  equal(since(before, ctx), { replayed: 0, submitted: 0 }, 'an unaddressable session never sends')

  const retiring = createContext()
  retiring.conversation.input.for = () => { throw new Error('session retired') }
  const retiringHandler = interceptorOf(boot().plugin, retiring)
  const retired = press(retiringHandler, keyEvent({ ctrlKey: true }), createTarget({ input: createInput() }))
  ok(retired.defaultPrevented, 'a retired session claims the gesture')
  equal(retiring.calls.submitted.length, 0, 'a retired session throws nothing into the page')
}

// 10. the Settings row writes through to both the interceptor and localStorage
{
  const stored = ctx.calls.registered[0].component
  const render = () => stored({ t: key => key })
  const selector = findElement(render(), node => node.props?.id === 'dsh-cek-enter')
  ok(selector !== undefined, 'the row renders an Enter selector')
  equal(selector.props.options.map(option => option.value), ['newline', 'send', 'stock'], 'the selector offers three behaviors')
  equal(selector.props.value, 'newline', 'Enter starts on the shipped default')
  ok(findElement(render(), node => node.props?.id === 'dsh-cek-ctrl-enter') !== undefined, 'the row renders an accelerator selector')

  selector.props.onChange('send')
  const before = counters(ctx)
  const plain = press(handler, keyEvent(), target)
  ok(plain.defaultPrevented, 'plain Enter is still claimed in send mode')
  equal(since(before, ctx), { replayed: 0, submitted: 1 }, 'plain Enter now sends instead of breaking the line')
  const repeatBefore = counters(ctx)
  press(handler, keyEvent({ repeat: true }), target)
  equal(since(repeatBefore, ctx), { replayed: 0, submitted: 0 }, 'a repeating Enter does not send twice')

  equal(JSON.parse(pluginCtx.storage.getItem(STORAGE_KEY)), { enter: 'send', ctrlEnter: 'send' }, 'the write is persisted')
  equal(
    findElement(render(), node => node.props?.id === 'dsh-cek-enter').props.value,
    'send',
    'the row re-reads the new value',
  )

  // 11. restoring the stock behavior hands the key back to DSH
  findElement(render(), node => node.props?.id === 'dsh-cek-enter').props.onChange('stock')
  const stock = press(handler, keyEvent(), target)
  ok(!stock.defaultPrevented, 'the stock behavior leaves Enter to DSH')

  // 12. a persisted document survives the next load
  const restored = boot(pluginCtx.storage)
  const restoredHandler = interceptorOf(restored.plugin, createContext())
  const restoredEvent = press(restoredHandler, keyEvent(), createTarget({ input: createInput() }))
  ok(!restoredEvent.defaultPrevented, 'the persisted stock behavior is restored after a reload')
}

// 13. a malformed document falls back to the shipped defaults
{
  const malformed = createContext()
  const malformedHandler = interceptorOf(boot(createStorage('{not json')).plugin, malformed)
  const before = counters(malformed)
  const event = press(malformedHandler, keyEvent(), createTarget({ input: createInput() }))
  ok(event.defaultPrevented, 'an unreadable document still intercepts Enter')
  equal(since(before, malformed), { replayed: 1, submitted: 0 }, 'an unreadable document falls back to the newline default')
}

const verdict = failures === 0 ? '✓ all checks passed' : `✗ ${failures} of ${checks} checks failed`
console.log(`${verdict} (${checks - failures}/${checks})`)
process.exitCode = failures === 0 ? 0 : 1
