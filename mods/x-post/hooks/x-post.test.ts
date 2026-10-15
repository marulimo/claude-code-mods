import { expect, mock, test } from 'claude-code/testing'

import { composeText, intentUrl, normalizeAccount, normalizeTag, parseMentions, postWeight, statusId } from './register'

const PANE_PROPS = { title: 'X', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

test('タグとアカウントの正規化', async () => {
  expect(normalizeTag('#朝活')).toBe('朝活')
  expect(normalizeTag('＃朝活')).toBe('朝活')
  expect(normalizeTag(' AI ')).toBe('AI')
  expect(normalizeTag('#')).toBe(undefined)
  expect(normalizeTag('a#b')).toBe(undefined)
  expect(normalizeAccount('@PiClaudeCode')).toBe('PiClaudeCode')
  expect(normalizeAccount('あいう')).toBe(undefined)
})

test('本文にタグを付ける。既に書いてあるタグは足さない', async () => {
  expect(composeText('おはよう', ['朝活', 'AI'])).toBe('おはよう\n\n#朝活 #AI')
  expect(composeText('おはよう #朝活', ['朝活', 'AI'])).toBe('おはよう #朝活\n\n#AI')
  expect(composeText('おはよう', [])).toBe('おはよう')
  expect(intentUrl('a #b')).toBe('https://x.com/intent/post?text=a%20%23b')
  expect(intentUrl('a', '123')).toBe('https://x.com/intent/post?in_reply_to=123&text=a')
})

test('返信先URLからポストIDを取る', async () => {
  expect(statusId('https://x.com/foo/status/1234567890?s=20')).toBe('1234567890')
  expect(statusId('https://twitter.com/foo/status/42')).toBe('42')
  expect(statusId('https://x.com/foo')).toBe(undefined)
})

test('hermes の返答から投稿URLつきの行だけ拾う', async () => {
  const out = [
    '1. 【@alice | 2026-10-15 10:00 | おはよう @me | https://x.com/alice/status/111】',
    'URLの無い要約行',
    '- @bob | 本文だけ https://x.com/i/status/222',
  ].join('\n')
  const items = parseMentions(out)
  expect(items.length).toBe(2)
  expect(items[0]?.url).toBe('https://x.com/alice/status/111')
  expect(items[0]?.text).toContain('おはよう')
  expect(items[1]?.url).toBe('https://x.com/i/status/222')
  expect(parseMentions('No matching posts found.').length).toBe(0)
})

test('/x-tag と /x、/x-reply、推論中だけモード', async ($, on) => {
  const run = (command: string, args: string) =>
    $.command.run({
      command,
      args,
      origin: { kind: 'plugin', name: 'test' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  mock.store(on)
  on('process.run', async () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  expect((await run('x-tag', 'add #朝活 AI 朝活')).text).toBe('登録しました。現在: #朝活 #AI')
  expect((await run('x-tag', 'rm AI')).text).toBe('削除しました。現在: #朝活')

  const posted = await run('x', '今日も早起き')
  expect(posted.text).toContain(intentUrl('今日も早起き\n\n#朝活'))

  const replied = await run('x-reply', 'https://x.com/foo/status/99 ありがとう')
  expect(replied.text).toContain(intentUrl('ありがとう\n\n#朝活', '99'))

  expect((await run('x-mode', 'on')).text).toContain('オンにしました')
  const refused = await run('x', 'いま待機中')
  expect(refused.text).toContain('推論中だけ投稿できるモードです')
  expect(refused.text).not.toContain('intent/post')
  expect((await run('x-reply', 'https://x.com/foo/status/99 待機中')).text).toContain('推論中だけ')

  expect((await run('x-mode', 'off')).text).toContain('オフにしました')
  expect((await run('x', 'もう一度')).text).toContain('intent/post')
})

test('ペインにモードとタグが出て、ボタンでモードが切り替わる', async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'x-post', surface, component: 'Pane', requestId: 'x-post', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /いつでも投稿できます/ })).toBeDefined()
    await ui.press({ key: 'mode' })
    expect(await ui.find({ type: 'Text', text: /待機中: 投稿できません/ })).toBeDefined()
    await ui.press({ key: 'mode' })
    expect(await ui.find({ type: 'Text', text: /いつでも投稿できます/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
  }
})

test('ペインの投稿欄で Enter すると投稿画面を開き、返信先が不正なら開かない', async ($, on) => {
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT' })
  const opened: string[] = []
  on('process.run', async (_$, e) => {
    opened.push(String(e.argv[2]))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const ui = await $.ui.mount({ plugin: 'x-post', surface, component: 'Pane', requestId: 'x-post', props: PANE_PROPS })
    expect(await ui.find({ key: 'body' })).toBeDefined()

    await ui.input({ key: 'replyTo', text: 'https://x.com/foo/status/77', kind: 'change' })
    await ui.input({ key: 'body', text: 'ペインから', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: 'プレビュー' })).toBeDefined()
    await ui.input({ key: 'body', text: 'ペインから' })
    expect(opened).toEqual([intentUrl('ペインから', '77')])
    expect(await ui.find({ type: 'Text', text: /投稿画面を開きました/ })).toBeDefined()

    await ui.input({ key: 'replyTo', text: 'URLじゃない', kind: 'change' })
    await ui.input({ key: 'body', text: '二通目' })
    expect(opened.length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /返信先がポストのURL/ })).toBeDefined()
    await ui.input({ key: 'replyTo', text: '', kind: 'change' })
  }
})

test('文字数はXの数え方の目安で、日本語は2、URLは23', async () => {
  expect(postWeight('abc')).toBe(3)
  expect(postWeight('あいう')).toBe(6)
  expect(postWeight('見て https://example.com/very/long/path')).toBe(4 + 1 + 23)
  expect(normalizeTag('a'.repeat(51))).toBe(undefined)
})

test('長すぎる本文は投稿画面を開かない。タグは10個まで', async ($, on) => {
  const run = (command: string, args: string) =>
    $.command.run({
      command,
      args,
      origin: { kind: 'plugin', name: 'test' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  mock.store(on)
  const opened: string[] = []
  on('process.run', async (_$, e) => {
    opened.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  expect((await run('x', 'あ'.repeat(141))).text).toContain('長すぎます')
  expect(opened.filter(a => a.includes('intent/post')).length).toBe(0)
  expect((await run('x', 'あ'.repeat(140))).text).toContain('intent/post')
  expect((await run('x-tag', 'add a b c d e f g h i j')).text).toContain('登録しました')
  expect((await run('x-tag', 'add k')).text).toContain('10 個まで')
})

test('ペインのタグ欄で追加し、タグを押すと消える', async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'x-post', surface, component: 'Pane', requestId: 'x-post', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /なし/ })).toBeDefined()
    await ui.input({ key: 'tagAdd', text: '#朝活 AI' })
    expect(await ui.find({ key: 'tag-朝活' })).toBeDefined()
    expect(await ui.find({ key: 'tag-AI' })).toBeDefined()
    await ui.press({ key: 'tag-AI' })
    expect(await ui.find({ key: 'tag-AI' })).toBe(undefined)
    await ui.press({ key: 'tag-朝活' })
    expect(await ui.find({ key: 'tag-朝活' })).toBe(undefined)
  }
})
