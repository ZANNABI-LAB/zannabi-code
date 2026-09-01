// packages/gateway-telegram/src/index.ts
import type { ApprovalDecision, Gate, GateWarning } from '@zannabi-lab/core'
import { TelegramBot, TelegramError, MAX_MESSAGE_LEN, truncate, escapeHtml } from './telegram'
import { acquirePollLock, describeHolder } from './lock'

export { TelegramBot, TelegramError, truncate, escapeHtml, stripTags, MAX_MESSAGE_LEN } from './telegram'
export { acquirePollLock, fingerprint, describeHolder, STALE_MS } from './lock'
export type { LockHolder, LockResult } from './lock'
export type { TelegramMessage, TelegramCallback, Incoming, InlineButton } from './telegram'

/** 승인으로 읽는 말. 대소문자와 앞뒤 공백은 무시한다 */
const APPROVE_WORDS = ['y', 'yes', 'ok', 'approve', '승인', 'ㅇ']
/** 거부로 읽는 말 */
const ABORT_WORDS = ['n', 'no', 'abort', 'stop', '거부', '중단', 'ㄴ']

/** 버튼에 심는 값 */
const DATA_APPROVE = 'zannabi:approve'
const DATA_ABORT = 'zannabi:abort'

/** long polling 한 번이 기다리는 시간(초). 텔레그램 권장 범위 안이다 */
const POLL_SEC = 30

const HEAD_ASK = '🔍 <b>계획 승인 요청</b>'

export type ApproveFn = (
  plan: string,
  gates: Gate[],
  warnings: GateWarning[],
) => Promise<ApprovalDecision>

/** 화면에 "어느 실행인지"를 적기 위한 것. 승인 콜백의 인자만으로는 알 수 없다 */
export interface RunContext {
  intent: string
  cwd: string
  budget?: number
  maxCostUsd?: number
}

export interface TelegramApprovalOptions {
  token: string
  /** 페어링된 단일 chat. 여기서 온 것만 승인으로 읽는다 */
  chatId: string
  /**
   * 텔레그램으로 물을 수 없을 때 대신 물을 곳 — 보통 터미널 승인이다.
   *
   * **폴백이 필수 인자인 이유**: 락을 못 잡거나 메시지를 못 보내는 일은 정상 운용에서
   * 일어난다(다른 실행이 폴링 중, 네트워크 단절). 그때 조용히 거부하면 계획 비용을 버리고,
   * 조용히 승인하면 사람 없이 도는 것이다. **둘 다 안 되므로 물을 곳이 하나 더 있어야 한다.**
   */
  fallback: ApproveFn
  log(message: string): void
  /** 이만큼 답이 없으면 포기한다. 0이거나 없으면 무한히 기다린다 */
  timeoutMs?: number
  /** 승인 화면에 적을 실행 정보 */
  context?: RunContext
  /** 테스트·격리용 */
  lockDir?: string
  bot?: TelegramBot
  now?: () => number
}

/**
 * 계획 승인을 텔레그램으로 묻는다 — `LoopOptions.approve`에 그대로 꽂히는 함수를 만든다.
 *
 * **core는 이 파일의 존재를 모른다.** 승인은 콜백 하나이고 `--yes`가 이미 그 자리를
 * 갈아끼우고 있으므로, 채널을 붙이는 데 core 수정이 필요 없다는 것이 계약의 값이다.
 * 저널의 `approval-requested`/`approval-resolved`는 여기서도 그대로 남는다 —
 * 승인을 **누가 어디서** 했든 저널에는 같은 모양으로 기록된다.
 */
export function approveViaTelegram(opts: TelegramApprovalOptions): ApproveFn {
  const bot = opts.bot ?? new TelegramBot(opts.token)
  const now = opts.now ?? (() => Date.now())

  return async (plan, gates, warnings) => {
    // 원격으로 물어도 터미널은 침묵하지 않는다 — 로컬에서 보는 사람이
    // 무엇 때문에 멈춰 있는지 알 수 없으면 그것대로 나쁜 화면이다
    opts.log('승인을 텔레그램으로 묻습니다')

    const lock = acquirePollLock(opts.token, { ...(opts.lockDir ? { dir: opts.lockDir } : {}) })
    if (!lock.ok) {
      // 기다리지 않고 즉시 터미널로 내려간다. 기다리는 쪽이 더 친절해 보이지만,
      // 그러면 아무도 안 보는 터미널에서 두 실행이 함께 멈춘다
      opts.log(
        `텔레그램 폴링을 다른 실행이 쓰고 있습니다 (${describeHolder(lock.holder)}) — 터미널로 묻습니다`,
      )
      return opts.fallback(plan, gates, warnings)
    }

    try {
      return await ask(bot, opts, now, plan, gates, warnings)
    } finally {
      lock.release()
    }
  }
}

async function ask(
  bot: TelegramBot,
  opts: TelegramApprovalOptions,
  now: () => number,
  plan: string,
  gates: Gate[],
  warnings: GateWarning[],
): Promise<ApprovalDecision> {
  const body = compose(plan, gates, warnings, opts.context, opts.timeoutMs)
  let offset: number
  let messageId: number
  try {
    /**
     * ★ **묻기 전에 밀린 메시지를 버린다.**
     *
     * 이것이 없으면 몇 시간 전에 보낸 `y` 한 줄이 다음 실행의 승인으로 읽힌다.
     * 승인 게이트에서 낼 수 있는 가장 나쁜 결함이라 — 사람이 보지도 않은 계획이
     * 승인된 것으로 저널에 남는다 — 요청을 보내기 **전에** 커서를 현재로 옮긴다.
     */
    offset = await drain(bot)
    messageId = await bot.send(opts.chatId, body, {
      html: true,
      buttons: [
        { text: '✅ 승인', data: DATA_APPROVE },
        { text: '🛑 중단', data: DATA_ABORT },
      ],
    })
  } catch (err) {
    // 물어보지도 못했다 — 거부도 승인도 아니므로 물을 곳을 바꾼다
    opts.log(`텔레그램 전송 실패 (${message(err)}) — 터미널로 묻습니다`)
    return opts.fallback(plan, gates, warnings)
  }

  const deadline = opts.timeoutMs && opts.timeoutMs > 0 ? now() + opts.timeoutMs : undefined
  let nudged = false

  /**
   * 결정을 원래 메시지에 적고 버튼을 지운다 — 지나간 요청의 버튼이 남아 있으면 다시 눌린다.
   *
   * **타임아웃 안내도 함께 지운다.** 이미 결정된 요청에 "N초 안에 답이 없으면 중단합니다"가
   * 남아 있으면 그 줄이 거짓이 된다 — 실물 화면에서 그렇게 보였다.
   */
  const settle = async (head: string) => {
    const done = compose(plan, gates, warnings, opts.context).replace(HEAD_ASK, head)
    try {
      await bot.edit(opts.chatId, messageId, done, { html: true })
    } catch (err) {
      opts.log(`텔레그램 화면 갱신 실패 (${message(err)})`)
    }
  }

  for (;;) {
    if (deadline !== undefined && now() >= deadline) {
      const reason = `텔레그램 승인이 ${Math.round(opts.timeoutMs! / 1000)}초 안에 오지 않았습니다`
      await settle('⏱ <b>시간이 지나 중단했습니다</b>')
      return { action: 'abort', reason }
    }

    let batch: Awaited<ReturnType<TelegramBot['updates']>>
    try {
      /**
       * ★ **남은 시간보다 오래 기다리지 않는다.**
       *
       * 데드라인 검사는 루프에 들어올 때만 도는데 `getUpdates`는 30초씩 블록한다.
       * 고정 30초로 기다리면 `--approve-timeout 35`가 실제로는 60초에 끝난다 —
       * 실측에서 그렇게 나왔다. 지정한 시각에 끝나지 않는 옵션은 거짓말이므로,
       * 데드라인이 30초보다 가까우면 그만큼만 기다리고 깨어난다.
       */
      const wait =
        deadline === undefined
          ? POLL_SEC
          : Math.min(POLL_SEC, Math.max(0, Math.ceil((deadline - now()) / 1000)))
      batch = await bot.updates(offset, wait)
    } catch (err) {
      // 409는 락을 쥐고도 다른 폴러가 있다는 뜻이다 — 다른 기계이거나 우리가 모르는 봇 사용자다.
      // 재시도해봐야 같은 답이 오므로 사람에게 넘긴다
      if (err instanceof TelegramError && err.code === 409) {
        opts.log('텔레그램 409 — 다른 곳에서 같은 봇을 폴링 중입니다. 터미널로 묻습니다')
        return opts.fallback(plan, gates, warnings)
      }
      // 그 밖의 실패는 대개 일시적인 네트워크다. 이미 질문은 갔으므로 폴백하면 두 곳에서 묻게 된다
      opts.log(`텔레그램 폴링 실패 (${message(err)}) — 다시 시도합니다`)
      continue
    }

    for (const item of batch) {
      offset = item.updateId + 1
      // ★ 페어링된 chat이 아니면 없는 말이다. 봇을 아는 누구나 승인할 수 있으면
      // 이 게이트웨이는 승인 화면이 아니라 우회로가 된다
      if (String(item.chatId) !== opts.chatId) continue

      if (item.kind === 'callback') {
        /**
         * ★ **버튼은 어느 메시지의 것인지가 실려 온다.** 지나간 요청의 버튼을 눌러도
         * 이번 승인이 되지 않는다 — 텍스트 `y`로는 할 수 없는 출처 확인이고,
         * 버튼을 텍스트보다 안전하게 만드는 지점이다.
         */
        if (item.messageId !== messageId) {
          await quiet(opts, () => bot.answerCallback(item.callbackId, '지나간 요청입니다'))
          continue
        }
        if (item.data === DATA_APPROVE) {
          await quiet(opts, () => bot.answerCallback(item.callbackId, '승인했습니다'))
          await settle('✅ <b>승인했습니다 — 실행을 시작합니다</b>')
          return { action: 'approve' }
        }
        if (item.data === DATA_ABORT) {
          await quiet(opts, () => bot.answerCallback(item.callbackId, '중단합니다'))
          await settle('🛑 <b>중단했습니다</b>')
          return { action: 'abort', reason: '사람이 승인하지 않음 (텔레그램)' }
        }
        await quiet(opts, () => bot.answerCallback(item.callbackId))
        continue
      }

      const word = item.text.trim().toLowerCase()
      if (APPROVE_WORDS.includes(word)) {
        await settle('✅ <b>승인했습니다 — 실행을 시작합니다</b>')
        return { action: 'approve' }
      }
      if (ABORT_WORDS.includes(word)) {
        await settle('🛑 <b>중단했습니다</b>')
        return { action: 'abort', reason: '사람이 승인하지 않음 (텔레그램)' }
      }
      /**
       * 알아듣지 못한 말은 **거부가 아니라 무시다.**
       *
       * 터미널에서는 y가 아니면 전부 거부인데 여기서 같은 규칙을 쓰면, 채팅방에
       * 흘러든 한 마디에 실행이 죽는다. 기다리는 것은 안전한 쪽이고, 답이 끝내 없으면
       * 타임아웃이 정직하게 끝낸다. 안내는 한 번만 보낸다 — 매번 보내면 봇이 시끄러워진다.
       */
      if (!nudged) {
        nudged = true
        await quiet(opts, () =>
          bot.send(opts.chatId, '위 메시지의 버튼을 누르거나, "y"·"n"으로 답해 주세요.'),
        )
      }
    }
  }
}

/**
 * 밀린 업데이트를 소비하고 다음 커서를 돌려준다.
 *
 * `getUpdates`는 한 번에 100건까지만 주므로 빌 때까지 돈다. 상한을 두는 이유는
 * 봇이 오래 방치돼 업데이트가 쌓였을 때 승인 화면이 뜨기도 전에 여기서 오래 머무는 것을
 * 막기 위해서다 — 다 비우지 못해도 커서는 앞으로 갔으므로 옛 메시지가 승인이 되지는 않는다.
 */
async function drain(bot: TelegramBot, maxRounds = 10): Promise<number> {
  let offset = 0
  for (let i = 0; i < maxRounds; i++) {
    const batch = await bot.updates(offset, 0)
    if (batch.length === 0) break
    offset = batch[batch.length - 1]!.updateId + 1
  }
  return offset
}

/** 곁가지 호출은 실패해도 승인 판단을 뒤집지 않는다 — 이미 정해진 결정을 전하는 것뿐이다 */
async function quiet(opts: TelegramApprovalOptions, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    opts.log(`텔레그램 부가 호출 실패 (${message(err)})`)
  }
}

/**
 * 계획 본문에서 **게이트 JSON 블록을 걷어낸다.**
 *
 * 계획 턴은 게이트를 코드펜스 안의 JSON으로 싣는데, 그 내용은 바로 아래 "완료 기준"으로
 * 다시 그려진다. 실물 화면에서 이 중복이 폭의 절반을 먹었다 — 게다가 사람이 읽을 형태도 아니다.
 */
export function stripGateBlock(plan: string): string {
  return plan.replace(/```[a-zA-Z]*\s*\{[\s\S]*?"gates"[\s\S]*?```/g, '').trim()
}

/**
 * 승인 화면을 한 통에 담는다.
 *
 * **게이트와 경고를 먼저 자리잡게 하고 남는 공간에 계획을 넣는다.** 4096자 제한에 걸릴 때
 * 잘려도 되는 것은 계획의 서술이지 완료 기준이 아니다 — 무엇으로 완료를 판정하는지가
 * 승인의 실체이고, 그것이 잘린 화면은 승인을 물을 자격이 없다.
 *
 * **어느 실행인지를 맨 위에 적는다.** 실물에서 같은 모양의 요청이 연달아 오면 구별이
 * 되지 않았다 — 승인은 "무엇에 대한 승인인가"를 아는 상태에서만 승인이다.
 */
export function compose(
  plan: string,
  gates: Gate[],
  warnings: GateWarning[],
  context?: RunContext,
  timeoutMs?: number,
): string {
  const suggested = gates.filter(g => g.source !== 'user').length
  const head: string[] = [HEAD_ASK]
  if (context) {
    head.push(`<b>${escapeHtml(context.intent)}</b>`)
    const meta = [`<code>${escapeHtml(context.cwd)}</code>`]
    if (context.budget !== undefined) meta.push(`예산 ${context.budget}라운드`)
    if (context.maxCostUsd !== undefined) meta.push(`상한 $${context.maxCostUsd}`)
    head.push(`<i>${meta.join(' · ')}</i>`)
  }

  const tail: string[] = []
  tail.push(`<b>📋 완료 기준</b> · ${gates.length}개`)
  for (const g of gates)
    tail.push(`${g.source === 'user' ? '●' : '○'} <code>${escapeHtml(g.name)}</code> — <code>${escapeHtml(g.cmd)}</code>`)
  // 글머리를 게이트와 달리 한다 — 실물에서 `○`로 시작하니 네 번째 게이트로 보였다
  if (suggested > 0) tail.push(`   <i>↳ ○ 표시 ${suggested}개는 에이전트가 제안한 기준입니다</i>`)
  // 완료 기준이 통째로 에이전트 것이면 코드를 한 줄도 안 쓰고 success가 날 수 있다.
  // --yes는 이 경우를 아예 거부하는데, 사람이 보는 화면에서는 막는 대신 눈에 띄게 적는다
  if (gates.length > 0 && suggested === gates.length)
    tail.push('⚠️ <b>완료 기준이 전부 에이전트 제안입니다</b> — 사용자 게이트가 없습니다')
  if (warnings.length > 0) {
    tail.push('')
    tail.push('<b>⚠️ 경고</b>')
    for (const w of warnings)
      tail.push(`${w.kind === 'blocking' ? '⛔' : '⚠️'} <code>${escapeHtml(w.gate)}</code> — ${escapeHtml(w.reason)}`)
  }
  if (timeoutMs && timeoutMs > 0) {
    tail.push('')
    tail.push(`<i>⏱ ${Math.round(timeoutMs / 1000)}초 안에 답이 없으면 중단합니다</i>`)
  }

  const render = (middle: string) => `${head.join('\n')}\n\n${middle}\n\n${tail.join('\n')}`
  const quote = (body: string) => `<b>📝 계획</b>\n<blockquote expandable>${body}</blockquote>`
  // 계획에 내줄 수 있는 자리 = 전체 한도 - 나머지가 이미 쓴 만큼
  const room = MAX_MESSAGE_LEN - render(quote('')).length
  if (room < 200) return render('<i>계획 본문은 터미널에 있습니다</i>')
  // 이스케이프가 길이를 늘리므로 자르는 것은 이스케이프한 뒤에 한다
  return render(quote(truncate(escapeHtml(stripGateBlock(plan)), room)))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
