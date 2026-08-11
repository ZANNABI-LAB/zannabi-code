import type { Gate, Evidence } from './goal'

const TAIL_CHARS = 4000

export async function runGate(gate: Gate, opts: { cwd: string }): Promise<Evidence> {
  const started = Date.now()
  let exitCode: number | null = null
  let stdout = ''
  let stderr = ''
  let timedOut = false
  try {
    const proc = Bun.spawn(['sh', '-c', gate.cmd], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, gate.timeoutMs)
    await new Promise(r => setTimeout(r, 0))
    exitCode = await proc.exited
    clearTimeout(timer)
    try {
      stdout = await new Response(proc.stdout).text()
      stderr = await new Response(proc.stderr).text()
    } catch {
      // stream read failure must not override exitCode
    }
  } catch {
    exitCode = null // spawn 자체 실패
  }
  const outcome =
    timedOut || exitCode === null || exitCode === 126 || exitCode === 127
      ? 'error'
      : exitCode === 0
        ? 'pass'
        : 'fail'
  return {
    gate: gate.name,
    cmd: gate.cmd,
    outcome,
    exitCode,
    stdoutTail: stdout.slice(-TAIL_CHARS),
    stderrTail: stderr.slice(-TAIL_CHARS),
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  }
}
