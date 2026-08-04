// TASK-1559 AC-14 — the cheap half of the popup.js testability decision.
//
// popup.js has no harness, and the usual proposal is to extract its state transitions
// into a testable lib. That is worth doing, but it would NOT have caught the worst defect
// this file has produced: ChodaPicker was used by the PANEL (formatPick, cropRect) while
// popup.html never loaded lib/picker.js. formatPick threw outside any try, so Capture →
// silently did nothing, and cropRect's failure was swallowed by a bare catch so no element
// screenshot was EVER produced. That shipped in 8d09033 and the feature never worked once.
//
// That is a WIRING bug, not a state bug. This file asserts the wiring instead: every
// Choda* global that popup.js uses in the panel's own context must actually be provided
// by a script popup.html loads, in an order where it resolves.
//
// Deliberately not a DOM test — no jsdom, no fixture. It reads the two files as text and
// executes only the libs, so it stays fast and cannot rot against markup changes.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const DIR = __dirname
const html = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8')
const popupSrc = fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8')

/** Script srcs in popup.html, in document order — the real load order. */
function scriptSrcs() {
  return Array.from(html.matchAll(/<script\s+src="([^"]+)"/g)).map((m) => m[1])
}

/**
 * Choda* globals popup.js reads in the PANEL's context.
 *
 * `globalThis.ChodaPicker` is excluded on purpose: that reference lives inside an
 * executeScript callback and runs in the PAGE, where the picker is injected separately.
 * Requiring it in popup.html would be wrong. The distinction is exactly what made the
 * original bug hard to see — the same name, resolved in two different realms.
 */
function panelGlobals() {
  const withoutGlobalThis = popupSrc.replace(/globalThis\.Choda[A-Z]\w*/g, '')
  return [...new Set(Array.from(withoutGlobalThis.matchAll(/\b(Choda[A-Z]\w*)\b/g)).map((m) => m[1]))]
}

describe('popup.html wires up every global popup.js depends on', () => {
  it('loads its scripts in an order where each panel global resolves', () => {
    const ctx = { console, CSS: undefined }
    ctx.globalThis = ctx
    ctx.self = ctx
    vm.createContext(ctx)

    for (const src of scriptSrcs()) {
      if (src === 'popup.js') continue // the consumer, not a provider
      const file = path.join(DIR, src)
      expect(fs.existsSync(file), `popup.html references a missing file: ${src}`).toBe(true)
      // A lib that needs a DOM at load time is not a wiring failure — skip it rather than
      // fail, since this test is about resolution order, not about running the panel.
      try {
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx)
      } catch {
        /* not loadable headless; anything it exports simply won't be asserted below */
      }
    }

    const missing = panelGlobals().filter((name) => ctx[name] === undefined)
    expect(
      missing,
      `popup.js uses ${missing.join(', ')} in the panel, but popup.html never loads the script(s) defining them. ` +
        'This is the 8d09033 failure: the call throws at runtime and the button looks dead.'
    ).toEqual([])
  })

  it('actually detects a missing script — the check can fail', () => {
    // Without this the test above could pass because panelGlobals() found nothing.
    // A check that cannot fail proves nothing, which is the whole lesson of TASK-1559.
    expect(panelGlobals().length).toBeGreaterThan(0)
    const ctx = { console }
    ctx.globalThis = ctx
    vm.createContext(ctx)
    vm.runInContext(fs.readFileSync(path.join(DIR, 'lib/provenance.js'), 'utf8'), ctx)
    // Only provenance loaded, so the picker globals must be reported missing.
    expect(panelGlobals().filter((n) => ctx[n] === undefined)).toContain('ChodaPicker')
  })

  it('names the specific globals the panel needs, so a silent removal fails here', () => {
    const globals = panelGlobals()
    expect(globals).toContain('ChodaPicker') // formatPick + cropRect
    expect(globals).toContain('ChodaProvenance') // resolveTabSource + resolveNetworkSource
  })
})
