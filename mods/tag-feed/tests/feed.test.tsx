import { expect, mock, test } from 'claude-code/testing'

import { extractIds, normalizeTags } from '../hooks/register'

const GROK_OUT = [
  'https://x.com/alice/status/2110681400164946083',
  'https://x.com/i/status/2110445844675838148',
  'https://twitter.com/carol/status/2110000000000000001',
  'https://x.com/alice/status/2110681400164946083',
].join('\n')

const TWEETS: Record<string, unknown> = {
  // タグあり・新しい
  '2110681400164946083': {
    text: 'Claude Code で1日半で作った &amp; 公開 #ClaudeCode',
    created_at: '2026-10-15T10:37:15.000Z',
    user: { screen_name: 'alice', name: 'Alice' },
    entities: { hashtags: [{ text: 'ClaudeCode' }] },
  },
  // タグあり(entities のみ)・古い
  '2110445844675838148': {
    text: '並列セッションが速くなった',
    created_at: '2026-10-14T01:00:00.000Z',
    user: { screen_name: 'bob', name: 'Bob' },
    entities: { hashtags: [{ text: 'claudecode' }] },
  },
  // タグなし → 除外
  '2110000000000000001': {
    text: '関係ない投稿',
    created_at: '2026-10-15T11:00:00.000Z',
    user: { screen_name: 'carol', name: 'Carol' },
    entities: { hashtags: [] },
  },
}

function world(on: any, opts: { grok?: string; fail?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const runs: (readonly string[])[] = []
  const fetched: string[] = []
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('process.run', (_$: unknown, e: any) => {
    runs.push(e.argv)
    if (opts.fail) return { value: { exitCode: 1, stdout: '', stderr: 'no final response' } } as never
    return { value: { exitCode: 0, stdout: opts.grok ?? GROK_OUT, stderr: '' } } as never
  })
  on('http.fetch', (_$: unknown, e: any) => {
    const id = /id=(\d+)/.exec(e.url)![1]!
    fetched.push(id)
    const t = TWEETS[id]
    return {
      value: { status: t ? 200 : 404, ok: !!t, headers: {}, text: t ? JSON.stringify(t) : '' },
    } as never
  })
  return { clock, runs, fetched }
}

test('extractIds picks every status id form once', () => {
  expect(extractIds(GROK_OUT)).toEqual([
    '2110681400164946083',
    '2110445844675838148',
    '2110000000000000001',
  ])
  expect(normalizeTags('#ClaudeCode ＃生成AI, #ClaudeCode')).toEqual(['ClaudeCode', '生成AI'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/tag-feed asks Grok, keeps only tagged originals, newest first (${surface})`, async ($, on) => {
    const { clock, runs, fetched } = world(on)
    await $.session.start({ cwd: 'C:/work' } as never)
    const ran = await $.command.run({ command: 'tag-feed', args: '#ClaudeCode', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(ran.text).toContain('#ClaudeCode')
    await clock.settle()

    expect(runs.length).toBe(1)
    const argv = runs[0]!
    expect(argv.slice(0, 3)).toEqual(['py', '-3.13', '-c'])
    expect(argv.some(a => a.includes('#ClaudeCode'))).toBe(true)
    expect(argv).toContain('grok-4.3')
    expect(fetched.sort()).toEqual(Object.keys(TWEETS).sort())

    const ui = await $.ui.mount({ plugin: 'tag-feed', surface, component: 'Pane', requestId: 'tag-feed', props: {} as never })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
    const iAlice = texts.findIndex(t => t.includes('1日半で作った & 公開'))
    const iBob = texts.findIndex(t => t.includes('並列セッション'))
    expect(iAlice).toBeGreaterThan(-1)
    expect(iBob).toBeGreaterThan(iAlice)
    expect(texts.some(t => t.includes('関係ない投稿'))).toBe(false)
    expect(texts.some(t => t.includes('新着2件') && t.includes('除外1件'))).toBe(true)

    // 2回目は同じURLしか来ないので取り直さない
    await $.ui.press({ plugin: 'tag-feed', key: 'now', surface } as never)
    await clock.settle()
    expect(runs.length).toBe(2)
    expect(fetched.length).toBe(3)
  })
}

test('a Grok failure is shown and the feed keeps its posts', async ($, on) => {
  const { clock } = world(on, { fail: true })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: 'ClaudeCode', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'tag-feed', surface: 'terminal', component: 'Pane', requestId: 'tag-feed', props: {} as never })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  expect(texts.some(t => t.includes('取得エラー') || t.includes('no final response'))).toBe(true)
})
