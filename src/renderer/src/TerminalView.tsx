import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
type SessionState = 'idle' | 'running' | 'exited-ok' | 'crashed'

interface TerminalViewProps {
  workspaceId: string
  cwd: string
  visible: boolean
}

function TerminalView({ workspaceId, cwd, visible }: TerminalViewProps): React.JSX.Element {
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
      const spawnResult = await window.api.pty.spawn(workspaceId, cwd, cols, rows)
      if (disposed) return

      if (!spawnResult.ok) {
        term.write(`\r\n\x1b[31m[failed to spawn pty for ${workspaceId}]\x1b[0m\r\n`)
        setState('crashed')
        return
      }

      setState('running')

      cleanupData = window.api.pty.onData(workspaceId, (data) => {
        term.write(data)
      })

      cleanupExit = window.api.pty.onExit(workspaceId, (exitCode) => {
        term.write(`\r\n\x1b[33m[process exited with code ${exitCode}]\x1b[0m\r\n`)
        if (!disposed) {
          setState(exitCode === 0 ? 'exited-ok' : 'crashed')
        }
      })

      term.onData((data) => {
        window.api.pty.input(workspaceId, data)
      })

      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (fitAddonRef.current && terminalRef.current) {
            fitAddonRef.current.fit()
            const { cols: c, rows: r } = terminalRef.current
            window.api.pty.resize(workspaceId, c, r)
          }
        }, 50)
      })
      resizeObserver.observe(containerRef.current)
    }

    boot().catch((err) => {
      console.error(`boot failed for ${workspaceId}`, err)
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
  }, [workspaceId])

  // Refit when becoming visible
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit()
      if (terminalRef.current) {
        const { cols, rows } = terminalRef.current
        window.api.pty.resize(workspaceId, cols, rows)
      }
    }
  }, [visible, workspaceId])

  async function handleRestart(): Promise<void> {
    // Kill existing session if any
    window.api.pty.kill(workspaceId)

    // Clear terminal
    if (terminalRef.current) {
      terminalRef.current.clear()
      terminalRef.current.write('\x1b[2J\x1b[H') // clear screen
    }

    setState('idle')

    // Re-spawn
    if (terminalRef.current) {
      const { cols, rows } = terminalRef.current
      const result = await window.api.pty.spawn(workspaceId, cwd, cols, rows)
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
