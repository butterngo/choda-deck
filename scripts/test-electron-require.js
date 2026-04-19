// Diagnostic: what does require('electron') return when loaded from Electron main?
const e = require('electron')
console.log('[test] typeof require("electron"):', typeof e)
console.log('[test] value head:', String(e).slice(0, 120))
console.log(
  '[test] keys:',
  typeof e === 'object' ? Object.keys(e).slice(0, 15) : 'N/A (not object)'
)
console.log('[test] process.type:', process.type)
console.log('[test] process.versions.electron:', process.versions.electron)
process.exit(0)
