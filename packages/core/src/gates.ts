import type { Gate, Evidence } from './goal'

const TAIL_CHARS = 4000
const IO_GRACE_MS = 500

async function collect(stream: ReadableStream<Uint8Array> | null, sink: { text: string }) {
  if (!stream) return
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true })
  } catch {
    // stream failure must not crash the gate; keep what we have
  }
}

export async function runGate(gate: Gate, opts: { cwd: string }): Promise<Evidence> {
  const started = Date.now()
  let exitCode: number | null = null
  let timedOut = false
  const stdoutSink = { text: '' }
  const stderrSink = { text: '' }
  try {
    const proc = Bun.spawn(['sh', '-c', gate.cmd], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const outDone = collect(proc.stdout, stdoutSink)
    const errDone = collect(proc.stderr, stderrSink)
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, gate.timeoutMs)
    exitCode = await proc.exited
    clearTimeout(timer)
    await Promise.race([Promise.allSettled([outDone, errDone]), Bun.sleep(IO_GRACE_MS)])
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
    stdoutTail: stdoutSink.text.slice(-TAIL_CHARS),
    stderrTail: stderrSink.text.slice(-TAIL_CHARS),
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  }
}
