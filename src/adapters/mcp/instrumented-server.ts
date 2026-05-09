import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolInvocationOperations } from '../../core/domain/interfaces/tool-invocations-repository.interface'

type RegisterToolFn = McpServer['registerTool']
type RegisterToolArgs = Parameters<RegisterToolFn>
type RegisterToolReturn = ReturnType<RegisterToolFn>

// InstrumentedServer wraps McpServer.registerTool to record every invocation
// (tool name, duration, ok/errorKind, ts) into tool_invocations. The wrapper
// is always async-shaped — SDK awaits the result regardless of the original
// callback's sync/async nature, so this is safe. Insert failures are swallowed
// (warn only) to never fail the tool call itself. (TASK-681)
export interface InstrumentedServer {
  registerTool: RegisterToolFn
  readonly registeredToolNames: ReadonlyArray<string>
}

export function createInstrumentedServer(
  server: McpServer,
  sink: ToolInvocationOperations
): InstrumentedServer {
  const names: string[] = []

  const registerTool = ((
    name: RegisterToolArgs[0],
    config: RegisterToolArgs[1],
    cb: RegisterToolArgs[2]
  ): RegisterToolReturn => {
    names.push(name)
    const wrappedCb = async (...callArgs: unknown[]): Promise<unknown> => {
      const start = Date.now()
      let ok = true
      let errorKind: string | null = null
      try {
        return await (cb as (...a: unknown[]) => unknown)(...callArgs)
      } catch (e) {
        ok = false
        // Name only — message can carry payload paths / user input.
        errorKind = (e as Error)?.name ?? 'Error'
        throw e
      } finally {
        try {
          sink.recordToolInvocation({
            toolName: name,
            ts: new Date().toISOString(),
            durationMs: Date.now() - start,
            ok,
            errorKind
          })
        } catch (logErr) {
          // Swallow — stats must never crash the tool call.
          console.warn('[choda-deck] tool invocation insert failed', logErr)
        }
      }
    }
    return server.registerTool(name, config, wrappedCb as RegisterToolArgs[2])
  }) as RegisterToolFn

  return {
    registerTool,
    get registeredToolNames(): ReadonlyArray<string> {
      return names
    }
  }
}
