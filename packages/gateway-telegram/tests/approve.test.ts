import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalDecision, Gate, GateWarning } from '@zannabi-lab/core'
import { approveViaTelegram, compose, stripGateBlock, TelegramBot, TelegramError, MAX_MESSAGE_LEN } from '../src/index'
import { acquirePollLock } from '../src/lock'
import type { Incoming, SendOptions } from '../src/telegram'

const TOKEN = '123456:AAHfake'
const CHAT = '555'
const dir = () => mkdtempSync(join(tmpdir(), 'zannabi-approve-'))

const gate = (name: string, cmd: string, source: 'user' | 'suggested' = 'user'): Gate =>
  ({ name, cmd, timeoutMs: 1000, source })

function msg(updateId: number, text: string, chatId = Number(CHAT)): Incoming {
  return { kind: 'message', updateId, chatId, text }
}

/** 인라인 버튼 클릭. `messageId`가 요청 메시지와 맞아야 이번 승인으로 친다 */
function click(updateId: number, data: string, messageId = SENT_ID, chatId = Number(CHAT)): Incoming {
  return { kind: 'callback', updateId, chatId, data, messageId, callbackId: `cb${updateId}` }
}

/** FakeBot이 보낸 메시지에 매기는 id */
const SENT_ID = 1000

/**
 * 큐를 순서대로 돌려주는 봇. **큐가 마르면 던진다** — 빈 배열을 계속 주면 승인 루프가
 * 영원히 돌아 시험이 멈추는 대신 시간 초과로 죽는다. 던지면 무엇이 부족했는지가 남는다.
 */
class FakeBot extends TelegramBot {
  sent: string[] = []
  edits: string[] = []
  answered: string[] = []
  buttons: string[][] = []
  calls: Array<{ offset: number; timeout: number }> = []
  sendError?: Error
  constructor(private queue: Incoming[][]) {
    super(TOKEN)
  }
  override async send(_chatId: string, text: string, opts: SendOptions = {}): Promise<number> {
    if (this.sendError) throw this.sendError
    this.sent.push(text)
    this.buttons.push((opts.buttons ?? []).map(b => b.data))
    return SENT_ID
  }
  override async edit(_chatId: string, _messageId: number, text: string): Promise<void> {
    this.edits.push(text)
  }
  override async answerCallback(callbackId: string): Promise<void> {
    this.answered.push(callbackId)
  }
  override async updates(offset: number, timeout: number): Promise<Incoming[]> {
    this.calls.push({ offset, timeout })
    if (this.queue.length === 0) throw new Error('시험이 예상하지 못한 폴링 — 큐가 말랐다')
    return this.queue.shift()!
  }
}

function make(bot: FakeBot, extra: Partial<Parameters<typeof approveViaTelegram>[0]> = {}) {
  const logs: string[] = []
  const fallbackCalls: string[] = []
  const approve = approveViaTelegram({
    token: TOKEN,
    chatId: CHAT,
    bot,
    lockDir: dir(),
    log: m => logs.push(m),
    fallback: async (plan): Promise<ApprovalDecision> => {
      fallbackCalls.push(plan)
      return { action: 'abort', reason: '폴백이 불렸다' }
    },
    ...extra,
  })
  return { approve, logs, fallbackCalls }
}

const GATES = [gate('build', 'bun run build')]
const NO_WARN: GateWarning[] = []

describe('텔레그램 승인', () => {
  test('"y"면 승인한다', async () => {
    const bot = new FakeBot([[], [msg(1, 'y')]])
    const { approve } = make(bot)
    expect(await approve('계획', GATES, NO_WARN)).toEqual({ action: 'approve' })
    expect(bot.sent[0]).toContain('계획 승인 요청')
    // 결정은 새 메시지가 아니라 **원래 메시지**에 적는다 — 버튼이 남아 다시 눌리면 안 된다
    expect(bot.edits[0]).toContain('승인했습니다')
    expect(bot.sent).toHaveLength(1)
  })

  test('대소문자와 공백, 한국어 답도 받는다', async () => {
    for (const word of [' Y ', 'YES', '승인', 'ㅇ']) {
      const bot = new FakeBot([[], [msg(1, word)]])
      const { approve } = make(bot)
      expect(await approve('계획', GATES, NO_WARN)).toEqual({ action: 'approve' })
    }
  })

  test('"n"이면 중단하고 사유를 남긴다', async () => {
    const bot = new FakeBot([[], [msg(1, 'n')]])
    const { approve } = make(bot)
    const decision = await approve('계획', GATES, NO_WARN)
    expect(decision.action).toBe('abort')
    expect(decision.action === 'abort' && decision.reason).toContain('텔레그램')
  })

  test('★ 묻기 전에 밀린 메시지를 버린다 — 옛 "y"가 다음 실행을 승인하면 안 된다', async () => {
    // drain이 첫 두 배치를 소비하고, 승인 루프는 그 뒤부터 본다
    const bot = new FakeBot([[msg(1, 'y'), msg(2, 'y')], [], [msg(3, 'n')]])
    const { approve } = make(bot)
    const decision = await approve('계획', GATES, NO_WARN)
    // 옛 y 두 개가 살아 있었다면 approve가 나왔을 것이다
    expect(decision.action).toBe('abort')
    // drain은 밀린 것의 다음 커서에서 폴링을 시작한다
    expect(bot.calls[bot.calls.length - 1]!.offset).toBe(3)
  })

  test('★ 페어링된 chat이 아니면 승인이 아니다 — 봇을 아는 누구나 승인하면 우회로가 된다', async () => {
    const bot = new FakeBot([[], [msg(1, 'y', 999)], [msg(2, 'n')]])
    const { approve } = make(bot)
    expect((await approve('계획', GATES, NO_WARN)).action).toBe('abort')
    // 남의 "y"에는 승인 표시를 하지 않았다
    expect(bot.edits.some(t => t.includes('승인했습니다'))).toBe(false)
  })

  test('알아듣지 못한 말은 거부가 아니라 무시다 — 채팅 한 마디에 실행이 죽으면 안 된다', async () => {
    const bot = new FakeBot([[], [msg(1, '잠깐만')], [msg(2, '아직'), msg(3, 'y')]])
    const { approve } = make(bot)
    expect(await approve('계획', GATES, NO_WARN)).toEqual({ action: 'approve' })
    // 안내는 한 번만 — 매번 보내면 봇이 시끄러워진다
    expect(bot.sent.filter(t => t.includes('버튼을 누르거나')).length).toBe(1)
  })

  test('락을 다른 실행이 쥐고 있으면 터미널로 내려간다', async () => {
    const d = dir()
    const held = acquirePollLock(TOKEN, { dir: d })
    expect(held.ok).toBe(true)
    const bot = new FakeBot([])
    const { approve, fallbackCalls, logs } = make(bot, { lockDir: d })
    const decision = await approve('계획', GATES, NO_WARN)
    expect(fallbackCalls).toEqual(['계획'])
    expect(decision.action).toBe('abort')
    expect(logs.join('\n')).toContain('다른 실행이 쓰고 있습니다')
    // 텔레그램에 아무것도 보내지 않았다 — 폴링 권한이 없으면 물어도 답을 못 받는다
    expect(bot.sent).toEqual([])
  })

  test('승인이 끝나면 락을 놓는다 — 다음 실행이 이어받을 수 있어야 한다', async () => {
    const d = dir()
    const bot = new FakeBot([[], [msg(1, 'y')]])
    const { approve } = make(bot, { lockDir: d })
    await approve('계획', GATES, NO_WARN)
    expect(acquirePollLock(TOKEN, { dir: d }).ok).toBe(true)
  })

  test('전송에 실패하면 터미널로 내려간다 — 묻지도 못했으므로 거부도 승인도 아니다', async () => {
    const bot = new FakeBot([[]])
    bot.sendError = new Error('network down')
    const { approve, fallbackCalls } = make(bot)
    await approve('계획', GATES, NO_WARN)
    expect(fallbackCalls).toEqual(['계획'])
  })

  test('409면 터미널로 내려간다 — 재시도해도 같은 답이 온다', async () => {
    class Conflict extends FakeBot {
      override async updates(offset: number, timeout: number) {
        if (offset === 0 && timeout === 0) return []
        throw new TelegramError('Conflict: terminated by other getUpdates request', 409)
      }
    }
    const bot = new Conflict([])
    const { approve, fallbackCalls, logs } = make(bot)
    await approve('계획', GATES, NO_WARN)
    expect(fallbackCalls).toEqual(['계획'])
    expect(logs.join('\n')).toContain('409')
  })

  test('일시적인 폴링 실패는 다시 시도한다 — 질문은 이미 갔으므로 폴백하면 두 곳에서 묻는다', async () => {
    let n = 0
    class Flaky extends FakeBot {
      override async updates(offset: number, timeout: number) {
        n++
        if (n === 1) return []
        if (n === 2) throw new Error('ETIMEDOUT')
        return [msg(1, 'y')]
      }
    }
    const bot = new Flaky([])
    const { approve, fallbackCalls } = make(bot)
    expect(await approve('계획', GATES, NO_WARN)).toEqual({ action: 'approve' })
    expect(fallbackCalls).toEqual([])
  })

  test('★ 데드라인이 30초보다 가까우면 그만큼만 기다린다 — 실측이 짚은 결함이다', async () => {
    // 실물에서 `--approve-timeout 35`가 60초에 끝났다. getUpdates가 30초씩 블록하는데
    // 데드라인 검사는 루프 진입 때만 돌기 때문이다. 지정한 시각에 안 끝나는 옵션은 거짓말이다
    let clock = 0
    const bot = new FakeBot([[], [], []])
    const { approve } = make(bot, { timeoutMs: 10_000, now: () => (clock += 3_000) })
    const decision = await approve('계획', GATES, NO_WARN)
    expect(decision.action).toBe('abort')
    // 첫 호출은 drain(항상 0), 그 뒤가 승인 폴링이다
    const polls = bot.calls.slice(1)
    expect(polls.length).toBeGreaterThan(0)
    for (const c of polls) {
      expect(c.timeout).toBeLessThan(30)
      expect(c.timeout).toBeGreaterThanOrEqual(0)
    }
  })

  test('데드라인이 없으면 30초씩 기다린다 — 텔레그램 권장 범위다', async () => {
    const bot = new FakeBot([[], [msg(1, 'y')]])
    const { approve } = make(bot)
    await approve('계획', GATES, NO_WARN)
    expect(bot.calls[1]!.timeout).toBe(30)
  })

  test('★ 결정된 뒤에는 타임아웃 안내를 지운다 — 남아 있으면 그 줄이 거짓이 된다', async () => {
    const bot = new FakeBot([[], [click(1, 'zannabi:approve')]])
    const { approve } = make(bot, { timeoutMs: 180_000 })
    await approve('계획', GATES, NO_WARN)
    expect(bot.sent[0]).toContain('180초 안에 답이 없으면')
    expect(bot.edits[0]).not.toContain('안에 답이 없으면')
    // 무엇을 승인했는지는 그대로 남는다
    expect(bot.edits[0]).toContain('완료 기준')
  })

  test('타임아웃이면 사유를 적어 중단한다 — 침묵으로 승인하지 않는다', async () => {
    let clock = 0
    const bot = new FakeBot([[], []])
    const { approve } = make(bot, { timeoutMs: 60_000, now: () => (clock += 40_000) })
    const decision = await approve('계획', GATES, NO_WARN)
    expect(decision.action).toBe('abort')
    expect(decision.action === 'abort' && decision.reason).toContain('오지 않았습니다')
  })
})

describe('버튼', () => {
  test('요청에 승인·중단 버튼을 함께 보낸다', async () => {
    const bot = new FakeBot([[], [click(1, 'zannabi:approve')]])
    const { approve } = make(bot)
    expect(await approve('계획', GATES, NO_WARN)).toEqual({ action: 'approve' })
    expect(bot.buttons[0]).toEqual(['zannabi:approve', 'zannabi:abort'])
  })

  test('중단 버튼은 중단한다', async () => {
    const bot = new FakeBot([[], [click(1, 'zannabi:abort')]])
    const { approve } = make(bot)
    expect((await approve('계획', GATES, NO_WARN)).action).toBe('abort')
    expect(bot.edits[0]).toContain('중단했습니다')
  })

  test('★ 지나간 요청의 버튼은 이번 승인이 아니다 — 텍스트로는 할 수 없는 출처 확인이다', async () => {
    // 옛 메시지(999)의 승인 버튼을 눌러도 무시하고, 이번 메시지의 중단 버튼에만 반응한다
    const bot = new FakeBot([[], [click(1, 'zannabi:approve', 999)], [click(2, 'zannabi:abort')]])
    const { approve } = make(bot)
    expect((await approve('계획', GATES, NO_WARN)).action).toBe('abort')
  })

  test('버튼을 누르면 스피너를 멈춘다 — 안 하면 누른 쪽 화면이 계속 돈다', async () => {
    const bot = new FakeBot([[], [click(7, 'zannabi:approve')]])
    const { approve } = make(bot)
    await approve('계획', GATES, NO_WARN)
    expect(bot.answered).toContain('cb7')
  })

  test('모르는 버튼 값은 무시한다', async () => {
    const bot = new FakeBot([[], [click(1, 'zannabi:???')], [click(2, 'zannabi:abort')]])
    const { approve } = make(bot)
    expect((await approve('계획', GATES, NO_WARN)).action).toBe('abort')
  })
})

describe('승인 화면', () => {
  test('게이트와 출처를 적는다 — 무엇으로 완료를 판정하는지가 승인의 실체다', () => {
    const text = compose('계획 본문', [gate('build', 'bun run build'), gate('lint', 'eslint .', 'suggested')], NO_WARN)
    expect(text).toContain('● <code>build</code>')
    expect(text).toContain('○ <code>lint</code>')
    // 안내는 게이트 항목과 글머리가 달라야 한다 — 같으면 네 번째 게이트로 보인다
    expect(text).toContain('↳ ○ 표시 1개는 에이전트가 제안한 기준입니다')
  })

  test('★ 어느 실행인지 맨 위에 적는다 — 같은 요청이 연달아 오면 구별이 안 됐다', () => {
    const text = compose('계획', GATES, NO_WARN, {
      intent: '로그인 버그 고치기',
      cwd: '/home/me/proj',
      budget: 4,
      maxCostUsd: 2.5,
    })
    expect(text).toContain('로그인 버그 고치기')
    expect(text).toContain('/home/me/proj')
    expect(text).toContain('예산 4라운드')
    expect(text).toContain('상한 $2.5')
  })

  test('★ 계획 속 게이트 JSON은 걷어낸다 — 바로 아래 완료 기준으로 다시 나오는 중복이다', () => {
    const plan = '계획: 한다.\n```json\n{"gates":[{"name":"ok","cmd":"true"}]}\n```'
    expect(stripGateBlock(plan)).toBe('계획: 한다.')
    expect(compose(plan, GATES, NO_WARN)).not.toContain('"gates"')
  })

  test('타임아웃이 있으면 미리 알린다 — 사라질 요청인 줄 모르고 있으면 안 된다', () => {
    expect(compose('계획', GATES, NO_WARN, undefined, 60_000)).toContain('60초 안에 답이 없으면')
    expect(compose('계획', GATES, NO_WARN)).not.toContain('안에 답이 없으면')
  })

  test('★ 계획 본문의 꺾쇠는 이스케이프한다 — 서식이 깨지면 메시지가 아예 안 간다', () => {
    const text = compose('<script>alert(1)</script> & more', GATES, NO_WARN)
    expect(text).toContain('&lt;script&gt;')
    expect(text).toContain('&amp;')
  })

  test('intent와 경로도 이스케이프한다', () => {
    const text = compose('계획', GATES, NO_WARN, { intent: 'a<b>c', cwd: '/x&y' })
    expect(text).toContain('a&lt;b&gt;c')
    expect(text).toContain('/x&amp;y')
  })

  test('완료 기준이 전부 제안이면 눈에 띄게 적는다 — --yes가 아예 거부하는 그 조건이다', () => {
    expect(compose('계획', [gate('ok', 'true', 'suggested')], NO_WARN)).toContain('전부 에이전트 제안입니다')
  })

  test('경고는 실행 불가와 조언을 구별해 적는다', () => {
    const text = compose('계획', GATES, [
      { gate: 'build', cmd: 'x', reason: '명령을 찾을 수 없습니다: x', kind: 'blocking' },
      { gate: 'lint', cmd: 'y', reason: '느립니다', kind: 'advisory' },
    ])
    expect(text).toContain('⛔ <code>build</code>')
    expect(text).toContain('⚠️ <code>lint</code>')
  })

  test('★ 계획이 길어도 완료 기준은 잘리지 않는다 — 잘린 기준으로는 승인을 물을 수 없다', () => {
    const gates = Array.from({ length: 30 }, (_, i) => gate(`g${i}`, `cmd-${i} --flag`))
    const text = compose('가'.repeat(20_000), gates, NO_WARN)
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN)
    for (const g of gates) expect(text).toContain(`<code>${g.name}</code>`)
    expect(text).toContain('중략')
  })

  test('기준이 화면을 다 차지하면 계획은 터미널로 미룬다', () => {
    const gates = Array.from({ length: 200 }, (_, i) => gate(`gate-number-${i}`, `some-fairly-long-command-${i}`))
    expect(compose('계획 본문', gates, NO_WARN)).toContain('계획 본문은 터미널에 있습니다')
  })
})
