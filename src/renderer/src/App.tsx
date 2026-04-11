import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './assets/deck.css'

function App(): React.JSX.Element {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<string>('initializing...')
  const [projectLabel, setProjectLabel] = useState<string>('')

  useEffect(() => {
    let disposed = false
    let cleanupData: (() => void) | null = null
    let cleanupExit: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null

    async function boot(): Promise<void> {
      if (!terminalContainerRef.current) return

      const project = await window.api.spike.getProject()
      if (disposed) return
      setProjectLabel(`${project.id} — ${project.cwd}`)

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
        fontSize: 14,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4'
        }
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(terminalContainerRef.current)
      fitAddon.fit()

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      const { cols, rows } = term
      const spawnResult = await window.api.pty.spawn(project.id, project.cwd, cols, rows)
      if (disposed) return

      if (!spawnResult.ok) {
        setStatus('failed to spawn pty')
        return
      }

      setStatus('running')

      cleanupData = window.api.pty.onData(project.id, (data) => {
        term.write(data)
      })

      cleanupExit = window.api.pty.onExit(project.id, (exitCode) => {
        setStatus(`exited (code ${exitCode})`)
        term.write(`\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`)
      })

      term.onData((data) => {
        window.api.pty.input(project.id, data)
      })

      resizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit()
          const { cols: c, rows: r } = terminalRef.current
          window.api.pty.resize(project.id, c, r)
        }
      })
      resizeObserver.observe(terminalContainerRef.current)
    }

    boot().catch((err) => {
      console.error('boot failed', err)
      setStatus(`error: ${String(err)}`)
    })

    return () => {
      disposed = true
      if (cleanupData) cleanupData()
      if (cleanupExit) cleanupExit()
      if (resizeObserver) resizeObserver.disconnect()
      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }
    }
  }, [])

  return (
    <div className="deck-root">
      <header className="deck-header">
        <div className="deck-title">Choda Deck — spike</div>
        <div className="deck-project">{projectLabel}</div>
        <div className="deck-status">{status}</div>
      </header>
      <div className="deck-terminal" ref={terminalContainerRef} />
    </div>
  )
}

export default App
