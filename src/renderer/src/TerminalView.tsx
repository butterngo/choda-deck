import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SpikeProject } from '../../preload/index'

interface TerminalViewProps {
  project: SpikeProject
  visible: boolean
}

function TerminalView({ project, visible }: TerminalViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

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
        return
      }

      cleanupData = window.api.pty.onData(project.id, (data) => {
        term.write(data)
      })

      cleanupExit = window.api.pty.onExit(project.id, (exitCode) => {
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
      resizeObserver.observe(containerRef.current)
    }

    boot().catch((err) => {
      console.error(`boot failed for ${project.id}`, err)
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

  // Refit when becoming visible (container may have resized while hidden)
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit()
      if (terminalRef.current) {
        const { cols, rows } = terminalRef.current
        window.api.pty.resize(project.id, cols, rows)
      }
    }
  }, [visible, project.id])

  return (
    <div
      className={`deck-terminal${visible ? '' : ' deck-terminal--hidden'}`}
      ref={containerRef}
    />
  )
}

export default TerminalView
