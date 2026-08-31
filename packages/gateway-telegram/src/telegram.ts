// packages/gateway-telegram/src/telegram.ts

/** 텔레그램이 한 메시지에 허용하는 최대 길이 */
export const MAX_MESSAGE_LEN = 4096

export interface TelegramMessage {
  kind: 'message'
  updateId: number
  chatId: number
  text: string
  /** 보낸 사람의 id. 그룹에서는 chat과 다르다 */
  fromId?: number
}

/** 인라인 버튼을 누른 것. 어느 메시지의 버튼인지가 실려 온다 — 그것이 텍스트보다 나은 점이다 */
export interface TelegramCallback {
  kind: 'callback'
  updateId: number
  chatId: number
  /** 버튼에 심어 둔 값 */
  data: string
  /** 이 버튼이 달려 있던 메시지 */
  messageId: number
  /** 스피너를 멈추려면 이 id로 답해야 한다 */
  callbackId: string
  fromId?: number
}

export type Incoming = TelegramMessage | TelegramCallback

export interface InlineButton {
  text: string
  data: string
}

export class TelegramError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
    this.name = 'TelegramError'
  }
}

export interface SendOptions {
  /** 인라인 버튼 한 줄 */
  buttons?: InlineButton[]
  /** HTML 서식으로 보낸다. 실패하면 태그를 벗겨 다시 보낸다 */
  html?: boolean
}

/**
 * Bot API 최소 클라이언트. 의존성 없이 `fetch`만 쓴다.
 *
 * 승인에 필요한 것은 **보내기·받기·고치기**뿐이라 SDK를 들이지 않는다.
 * 게이트웨이가 무거워지면 core가 채널을 모른다는 계약의 값이 깎인다 —
 * 채널 패키지는 갈아끼울 수 있을 만큼 작아야 그 주장이 성립한다.
 */
export class TelegramBot {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { ok?: boolean; result?: unknown; description?: string; error_code?: number }
    if (json.ok !== true)
      throw new TelegramError(json.description ?? `${method} 실패 (HTTP ${res.status})`, json.error_code)
    return json.result
  }

  /**
   * 텍스트를 보내고 message_id를 돌려준다.
   *
   * **서식이 깨지면 서식을 버리고 다시 보낸다.** 텔레그램은 파싱에 실패한 메시지를
   * 거부하므로, 서식을 쓰는 대가가 "승인 화면이 아예 안 뜨는 것"이어서는 안 된다.
   * 계획 본문은 사람이 쓴 것도 에이전트가 쓴 것도 아닌 **모델 출력**이라 무엇이 들어올지
   * 알 수 없다 — 이스케이프를 아무리 해도 이 안전망은 있어야 한다.
   */
  async send(chatId: string, text: string, opts: SendOptions = {}): Promise<number> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      disable_web_page_preview: true,
      ...(opts.buttons ? { reply_markup: keyboard(opts.buttons) } : {}),
    }
    if (opts.html) {
      try {
        const sent = await this.call('sendMessage', {
          ...body,
          text: clamp(text),
          parse_mode: 'HTML',
        })
        return (sent as { message_id: number }).message_id
      } catch (err) {
        if (!(err instanceof TelegramError)) throw err
        // 파싱 실패로 보이면 서식을 버리고 한 번 더. 그 밖의 오류(401·429)는 다시 시도해도 같다
        if (!/parse|entity|tag/i.test(err.message)) throw err
      }
    }
    const sent = await this.call('sendMessage', { ...body, text: clamp(stripTags(text)) })
    return (sent as { message_id: number }).message_id
  }

  /** 이미 보낸 메시지를 고쳐 쓴다 — 승인이 끝난 뒤 버튼을 지우고 결과를 그 자리에 적는다 */
  async edit(chatId: string, messageId: number, text: string, opts: SendOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      ...(opts.buttons ? { reply_markup: keyboard(opts.buttons) } : { reply_markup: { inline_keyboard: [] } }),
    }
    try {
      await this.call('editMessageText', { ...body, text: clamp(text), ...(opts.html ? { parse_mode: 'HTML' } : {}) })
    } catch (err) {
      if (!(err instanceof TelegramError) || !/parse|entity|tag/i.test(err.message)) throw err
      await this.call('editMessageText', { ...body, text: clamp(stripTags(text)) })
    }
  }

  /** 버튼의 로딩 스피너를 멈춘다. 이걸 안 하면 누른 쪽 화면이 계속 도는 것처럼 보인다 */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) })
  }

  /**
   * `offset` 이후의 업데이트를 가져온다. `timeoutSec`이 0보다 크면 long polling이다.
   *
   * **같은 토큰으로 이 호출이 동시에 둘 이상 돌면 텔레그램이 409를 낸다.** 그것이
   * 이 패키지에 락이 있는 이유다 — 자세한 근거는 `lock.ts`.
   */
  async updates(offset: number, timeoutSec: number): Promise<Incoming[]> {
    const result = (await this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    })) as Array<{
      update_id: number
      message?: { chat?: { id?: number }; from?: { id?: number }; text?: string }
      callback_query?: {
        id?: string
        data?: string
        from?: { id?: number }
        message?: { message_id?: number; chat?: { id?: number } }
      }
    }>
    const out: Incoming[] = []
    for (const u of result ?? []) {
      const cb = u.callback_query
      if (cb?.id && typeof cb.data === 'string' && typeof cb.message?.message_id === 'number' && typeof cb.message?.chat?.id === 'number') {
        out.push({
          kind: 'callback',
          updateId: u.update_id,
          chatId: cb.message.chat.id,
          data: cb.data,
          messageId: cb.message.message_id,
          callbackId: cb.id,
          ...(typeof cb.from?.id === 'number' ? { fromId: cb.from.id } : {}),
        })
        continue
      }
      const chatId = u.message?.chat?.id
      const text = u.message?.text
      if (typeof chatId !== 'number' || typeof text !== 'string') continue
      out.push({
        kind: 'message',
        updateId: u.update_id,
        chatId,
        text,
        ...(typeof u.message?.from?.id === 'number' ? { fromId: u.message.from.id } : {}),
      })
    }
    return out
  }
}

function keyboard(buttons: InlineButton[]) {
  return { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] }
}

function clamp(text: string): string {
  return text.length > MAX_MESSAGE_LEN ? truncate(text, MAX_MESSAGE_LEN) : text
}

/**
 * HTML 모드에서 본문으로 들어가는 값을 안전하게 만든다.
 *
 * 텔레그램 HTML이 특별하게 보는 것은 `& < >` **셋뿐**이다 — MarkdownV2가 18자를
 * 이스케이프해야 하는 것과 비교하면 훨씬 좁고, 그래서 모델 출력을 담기에 이쪽이 낫다.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 서식 폴백용. 태그를 지우고 엔티티를 되돌린다 */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * 넘치는 본문을 자른다. **앞이 아니라 가운데를 버린다** — 계획의 첫머리(무엇을 하려는지)와
 * 끝(게이트 목록)이 승인 판단의 재료이고, 중간의 서술은 없어도 판단이 선다.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const mark = '\n\n… (중략 — 전문은 터미널에 있습니다) …\n\n'
  const room = max - mark.length
  const head = Math.ceil(room * 0.6)
  return text.slice(0, head) + mark + text.slice(text.length - (room - head))
}
