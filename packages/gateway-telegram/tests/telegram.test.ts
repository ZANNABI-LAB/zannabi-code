import { describe, expect, test } from 'bun:test'
import { TelegramBot, TelegramError, truncate, escapeHtml, stripTags, MAX_MESSAGE_LEN } from '../src/telegram'

function botWith(responder: (url: string, init: RequestInit) => unknown) {
  const seen: Array<{ url: string; body: any }> = []
  const bot = new TelegramBot('tok', (async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(responder(String(url), init)), { status: 200 })
  }) as unknown as typeof fetch)
  return { bot, seen }
}

describe('Bot API 클라이언트', () => {
  test('토큰을 경로에 넣어 sendMessage를 부른다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: { message_id: 1 } }))
    await bot.send('42', '안녕')
    expect(seen[0]!.url).toBe('https://api.telegram.org/bottok/sendMessage')
    expect(seen[0]!.body).toMatchObject({ chat_id: '42', text: '안녕' })
  })

  test('HTML 서식으로 보낸다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: { message_id: 7 } }))
    expect(await bot.send('42', '<b>굵게</b>', { html: true })).toBe(7)
    expect(seen[0]!.body.parse_mode).toBe('HTML')
  })

  test('★ 서식이 깨지면 태그를 벗겨 다시 보낸다 — 승인 화면이 아예 안 뜨는 것이 최악이다', async () => {
    let first = true
    const { bot, seen } = botWith(() => {
      if (first) {
        first = false
        return { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" }
      }
      return { ok: true, result: { message_id: 8 } }
    })
    expect(await bot.send('42', '<b>깨진', { html: true })).toBe(8)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.body.parse_mode).toBeUndefined()
    expect(seen[1]!.body.text).toBe('깨진')
  })

  test('파싱과 무관한 오류는 재시도하지 않는다 — 401은 다시 보내도 401이다', async () => {
    const { bot, seen } = botWith(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }))
    expect(bot.send('42', 'x', { html: true })).rejects.toThrow('Unauthorized')
    await Bun.sleep(1)
    expect(seen).toHaveLength(1)
  })

  test('인라인 버튼을 실어 보낸다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: { message_id: 1 } }))
    await bot.send('42', 'x', { buttons: [{ text: '✅ 승인', data: 'zannabi:approve' }] })
    expect(seen[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '✅ 승인', callback_data: 'zannabi:approve' }]],
    })
  })

  test('버튼 클릭을 업데이트로 읽는다 — 어느 메시지의 버튼인지가 함께 온다', async () => {
    const { bot } = botWith(() => ({
      ok: true,
      result: [{
        update_id: 5,
        callback_query: { id: 'cb1', data: 'zannabi:approve', from: { id: 9 }, message: { message_id: 77, chat: { id: 5 } } },
      }],
    }))
    expect(await bot.updates(0, 0)).toEqual([
      { kind: 'callback', updateId: 5, chatId: 5, data: 'zannabi:approve', messageId: 77, callbackId: 'cb1', fromId: 9 },
    ])
  })

  test('메시지를 고칠 때 버튼을 지운다 — 지나간 요청의 버튼이 남으면 다시 눌린다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: {} }))
    await bot.edit('42', 7, '끝났습니다', { html: true })
    expect(seen[0]!.url).toContain('editMessageText')
    expect(seen[0]!.body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  test('4096자를 넘으면 잘라서 보낸다 — 텔레그램이 거부하면 승인 화면이 안 뜬다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: { message_id: 1 } }))
    await bot.send('42', 'x'.repeat(MAX_MESSAGE_LEN + 500))
    expect(seen[0]!.body.text.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN)
  })

  test('메시지가 아닌 업데이트는 걸러낸다', async () => {
    const { bot } = botWith(() => ({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 5 }, text: 'y', from: { id: 9 } } },
        { update_id: 2, message: { chat: { id: 5 } } },
        { update_id: 3, edited_message: { chat: { id: 5 }, text: 'n' } },
      ],
    }))
    const msgs = await bot.updates(0, 0)
    expect(msgs).toEqual([{ kind: 'message', updateId: 1, chatId: 5, text: 'y', fromId: 9 }])
  })

  test('long polling 인자를 그대로 넘긴다 — 버튼 클릭도 받아야 한다', async () => {
    const { bot, seen } = botWith(() => ({ ok: true, result: [] }))
    await bot.updates(77, 30)
    expect(seen[0]!.body).toMatchObject({ offset: 77, timeout: 30, allowed_updates: ['message', 'callback_query'] })
  })

  test('★ 409를 코드까지 실어 세운다 — 폴백 판단이 이 코드에 달려 있다', async () => {
    const { bot } = botWith(() => ({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }))
    try {
      await bot.updates(0, 0)
      throw new Error('세워야 했다')
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError)
      expect((err as TelegramError).code).toBe(409)
    }
  })

  test('ok:false는 설명을 그대로 옮긴다 — 401(토큰 오류)이 침묵하면 원인을 못 찾는다', async () => {
    const { bot } = botWith(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }))
    expect(bot.send('1', 'x')).rejects.toThrow('Unauthorized')
  })
})

describe('본문 줄이기', () => {
  test('앞이 아니라 가운데를 버린다 — 계획의 머리와 게이트가 판단의 재료다', () => {
    const text = `머리${'중'.repeat(500)}꼬리`
    const out = truncate(text, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.startsWith('머리')).toBe(true)
    expect(out.endsWith('꼬리')).toBe(true)
    expect(out).toContain('중략')
  })

  test('짧으면 손대지 않는다', () => {
    expect(truncate('짧다', 100)).toBe('짧다')
  })
})

describe('HTML 이스케이프', () => {
  test('텔레그램 HTML이 특별히 보는 셋만 바꾼다 — MarkdownV2의 18자보다 좁아서 고른 것이다', () => {
    expect(escapeHtml('a<b>&"\'c')).toBe('a&lt;b&gt;&amp;"\'c')
  })

  test('되돌리면 원문이다 — 서식 폴백이 성립하는 근거다', () => {
    const raw = 'if (a < b && c > d) return "x"'
    expect(stripTags(escapeHtml(raw))).toBe(raw)
  })

  test('태그를 벗긴다', () => {
    expect(stripTags('<b>굵게</b> 그리고 <code>코드</code>')).toBe('굵게 그리고 코드')
  })
})
