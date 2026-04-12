import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SpikeProject } from '../../preload/index'

type SessionState = 'idle' | 'running' | 'exited-ok' | 'crashed'

interface TerminalViewProps {
  project: SpikeProject
  visible: boolean
}

function TerminalView({ project, visible }: TerminalViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [state, setState] = useState<SessionState>('idle')

  useEffect(() => {
    let disposed = false
    let cleanupData: (() => void) | null = null
    let cleanupExit: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null

    async function boot(): Promise<void> {
      if (!containerRef.current) return

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
        fontSize: 14,
        allowProposedApi: true,
        scrollback: 10000,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4'
        }
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      const { cols, rows } = term
      const spawnResult = await window.api.pty.spawn(project.id, project.cwd, cols, rows)
      if (disposed) return

      if (!spawnResult.ok) {
        term.write(`\r\n\x1b[31m[failed to spawn pty for ${project.id}]\x1b[0m\r\n`)
        setState('crashed')
        return
      }

      setState('running')

      cleanupData = window.api.pty.onData(project.id, (data) => {
        term.write(data)
      })

      cleanupExit = window.api.pty.onExit(project.id, (exitCode) => {
        term.write(`\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`)
        if (!disposed) {
          setState(exitCode === 0 ? 'exited-ok' : 'crashed')
        }
      })

      term.onData((data) => {
        window.api.pty.input(project.id, data)
      })

      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (fitAddonRef.current && terminalRef.current) {
            fitAddonRef.current.fit()
            const { cols: c, rows: r } = terminalRef.current
            window.api.pty.resize(project.id, c, r)
          }
        }, 50)
      })
      resizeObserver.observe(containerRef.current)
    }

    boot().catch((err) => {
      console.error(`boot failed for ${project.id}`, err)
      setState('crashed')
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
  }, [project.id])

  // Refit when becoming visible
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit()
      if (terminalRef.current) {
        const { cols, rows } = terminalRef.current
        window.api.pty.resize(project.id, cols, rows)
      }
    }
  }, [visible, project.id])

  async function handleRestart(): Promise<void> {
    // Kill existing session if any
    window.api.pty.kill(project.id)

    // Clear terminal
    if (terminalRef.current) {
      terminalRef.current.clear()
      terminalRef.current.write('\x1b[2J\x1b[H') // clear screen
    }

    setState('idle')

    // Re-spawn
    if (terminalRef.current) {
      const { cols, rows } = terminalRef.current
      const result = await window.api.pty.spawn(project.id, project.cwd, cols, rows)
      if (result.ok) {
        setState('running')
      } else {
        setState('crashed')
      }
    }
  }

  const showBanner = state === 'crashed' || state === 'exited-ok'

  return (
    <div className={`deck-terminal-wrapper${visible ? '' : ' deck-terminal--hidden'}`}>
      {showBanner && (
        <div className={`deck-banner deck-banner--${state === 'crashed' ? 'error' : 'info'}`}>
          <span>
            {state === 'crashed'
              ? 'Session crashed — '
              : 'Session ended — '}
          </span>
          <button className="deck-banner-btn" onClick={handleRestart}>
            Restart
          </button>
        </div>
      )}
      <div className="deck-terminal" ref={containerRef} />
    </div>
  )
}

export default TerminalView
