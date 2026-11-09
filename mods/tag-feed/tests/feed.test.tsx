import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { extractIds, normalizeTags, tick } from '../hooks/register'

const MINUTE = 60_000
const SHARED_PATH = 'C:/mock-user/.claude/tag-feed/shared.json'
const CFG = { python: 'py', pythonVersion: '-3.13', model: 'grok-4.3', intervalMs: 30 * MINUTE }
const QUOTA = {
  exitCode: 1,
  stdout: '',
  stderr: "hermes -z: no final response was produced; treating the run as failed.\nhermes-dump: {'type': 'APIStatusError', 'message': 'personal-team-blocked:spending-limit', 'status_code': 402}",
}
type Reply = { exitCode: number; stdout: string; stderr: string }

async function finish(clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }) {
  await clock.settle()
  await clock.advance(1500)
  await clock.settle()
}

async function pane($: any, surface = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'tag-feed', surface, component: 'Pane', requestId: 'tag-feed', props: {} as never })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
  return { ui, text: texts.join('\n') }
}

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
    mediaDetails: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AAA.jpg', original_info: { width: 1600, height: 900 } },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/1/img/BBB.jpg', original_info: { width: 1920, height: 1080 } },
    ],
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

function world(on: any, opts: {
  grok?: string; fail?: boolean; replies?: Reply[]; shared?: string; env?: Record<string, string>
} = {}) {
  const rawClock = mock.clock(on, { now: 1_000_000 })
  let now = 1_000_000
  const clock = {
    ...rawClock,
    advance: async (ms: number) => { now += ms; await rawClock.advance(ms) },
  }
  const stored: Record<string, unknown> = {}
  on('store.get', (_$: unknown, e: any) => ({ value: stored[e.key] }) as never)
  on('store.set', (_$: unknown, e: any) => { stored[e.key] = e.value; return { value: undefined } as never })
  mock.env(on, opts.env ?? { USERPROFILE: 'C:/mock-user' })
  const files: Record<string, string> = {}
  if (opts.shared !== undefined) files[SHARED_PATH] = opts.shared
  const paths: string[] = []
  on('fs.exists', (_$: unknown, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    paths.push(path)
    return { value: path in files } as never
  })
  on('fs.read', (_$: unknown, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    paths.push(path)
    if (!(path in files)) throw new Error('mock file missing')
    return { value: files[path] } as never
  })
  on('fs.write', (_$: unknown, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    paths.push(path)
    files[path] = e.text
    return { value: undefined } as never
  })
  const runs: (readonly string[])[] = []
  const thumbAsks: string[][] = []
  const fetched: string[] = []
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('process.run', (_$: unknown, e: any) => {
    if (e.argv.some((a: string) => a.includes('urllib'))) {
      const urls: string[] = JSON.parse(e.init?.stdin ?? '[]')
      thumbAsks.push(urls)
      return { value: { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(urls.map(u => [u, 'QUJD']))), stderr: '' } } as never
    }
    runs.push(e.argv)
    const reply = opts.replies?.[runs.length - 1]
    if (reply) return { value: reply } as never
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
  // 別セッションの atom は別メモリーに置き、fs だけ同じ模擬を共有する。
  function isolated(): EngineInterface {
    const state: Record<string, unknown> = { feed: { tags: ['ClaudeCode'], isPaused: false, isFetching: false } }
    const stored: Record<string, unknown> = {}
    return {
      env: { get: async (name: string) => name === 'USERPROFILE' ? 'C:/mock-user' : undefined },
      fs: {
        exists: async (path: string) => path in files,
        read: async (path: string) => files[path],
        write: async (path: string, text: string) => { files[path] = text },
      },
      clock: { now: async () => now, sleep: (ms: number) => rawClock.sleep(ms) },
      state: {
        get: async (ref: any) => ({ isSet: ref.key in state, value: state[ref.key], version: 0 }),
        set: async (ref: any, value: unknown) => { state[ref.key] = value; return { isSet: true } },
      },
      store: { get: async (key: string) => stored[key], set: async (key: string, value: unknown) => { stored[key] = value } },
      process: { run: async (argv: readonly string[]) => { runs.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
      ui: { status: () => {} },
    } as unknown as EngineInterface
  }
  return { clock, runs, fetched, thumbAsks, files, paths, stored, isolated, now: () => now }
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
  test(`/tag-feed asks Grok, keeps only tagged originals, newest first (${surface})`, { options: { tags: '' } }, async ($, on) => {
    const { clock, runs, fetched, thumbAsks } = world(on)
    await $.session.start({ cwd: 'C:/work' } as never)
    const ran = await $.command.run({ command: 'tag-feed', args: '#ClaudeCode' })
    expect(ran.text).toContain('#ClaudeCode')
    await finish(clock)

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

    // 画像は縮小版URLで1回だけ取りに行き、デスクトップでは Svg、ターミナルでは枚数の文字
    const asked = thumbAsks.flat()
    expect(asked).toContain('https://pbs.twimg.com/media/AAA?format=jpg&name=360x360')
    expect(asked).toContain('https://pbs.twimg.com/amplify_video_thumb/1/img/BBB?format=jpg&name=360x360')
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs.length).toBe(2)
      expect(JSON.stringify(svgs)).toContain('data:image/jpeg;base64,QUJD')
      expect(JSON.stringify(svgs)).toContain('polygon')
    } else {
      expect(svgs.length).toBe(0)
      expect(texts.some(t => t.includes('画像1枚') && t.includes('動画1本'))).toBe(true)
    }

    // 2回目は同じURLしか来ないので取り直さない
    await $.ui.press({ plugin: 'tag-feed', key: 'now', surface } as never)
    await finish(clock)
    expect(runs.length).toBe(2)
    expect(fetched.length).toBe(3)
  })
}

test('a Grok failure is shown and the feed keeps its posts', { options: { tags: '' } }, async ($, on) => {
  const { clock } = world(on, { fail: true })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: 'ClaudeCode' })
  await finish(clock)
  const ui = await $.ui.mount({ plugin: 'tag-feed', surface: 'terminal', component: 'Pane', requestId: 'tag-feed', props: {} as never })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  expect(texts.some(t => t.includes('取得エラー') || t.includes('no final response'))).toBe(true)
})

test('the session starts quiet and /tag-feed starts the default tag', async ($, on) => {
  const { clock, runs } = world(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await finish(clock)
  await clock.advance(30 * 60_000)
  await finish(clock)
  expect(runs.length).toBe(0)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  expect(runs.length).toBe(1)
  expect(runs[0]!.some(a => a.includes('#ClaudeModsHack'))).toBe(true)
})

test('T1 quota dumps stop fetching, preserve posts, and use only the mock shared path', async ($, on) => {
  const { clock, runs, files, paths, stored } = world(on, { replies: [QUOTA] })
  await $.session.start({ cwd: 'C:/work' } as never)
  stored.posts = [{ id: 'saved', text: '保存済み', name: 'Saved', handle: 'saved', time: '', url: '' }]
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  const blocked = JSON.parse(files[SHARED_PATH]!)
  expect(blocked.blockedAt).toBeGreaterThan(0)
  expect(blocked.blockedReason).toContain('spending-limit')
  expect(blocked.lease).toBe(undefined)
  expect(stored.blockedAt).toBe(blocked.blockedAt)
  const { ui, text } = await pane($)
  expect(text).toContain('Grok枠切れで停止中')
  expect(text).toContain('6時間後（')
  expect(text).toContain('保存済み')
  expect((await ui.findAll({ type: 'Button' })).some(b => b.key === 'now')).toBe(false)
  for (let i = 0; i < 11; i++) {
    await clock.advance(30 * MINUTE)
    await finish(clock)
  }
  expect(runs.length).toBe(1)
  expect([...new Set(paths)]).toEqual([SHARED_PATH])
})

test('T2 quota probes once after six hours, then only resume-quota retries', async ($, on) => {
  const { clock, runs, files } = world(on, { replies: [QUOTA, QUOTA, QUOTA] })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  const blockedAt = JSON.parse(files[SHARED_PATH]!).blockedAt
  for (let i = 0; i < 13; i++) {
    await clock.advance(30 * MINUTE)
    await finish(clock)
  }
  expect(runs.length).toBe(2)
  expect(JSON.parse(files[SHARED_PATH]!).blockedAt).toBe(blockedAt)
  expect(JSON.parse(files[SHARED_PATH]!).probedAt).toBeGreaterThan(blockedAt)
  for (let i = 0; i < 24; i++) {
    await clock.advance(30 * MINUTE)
    await finish(clock)
  }
  expect(runs.length).toBe(2)
  expect((await pane($)).text).toContain('自動では再開しません。「再開」で1回試します')
  await $.ui.press({ plugin: 'tag-feed', key: 'resume-quota', surface: 'terminal' } as never)
  await finish(clock)
  expect(runs.length).toBe(3)
  expect(JSON.parse(files[SHARED_PATH]!).blockedAt).toBeGreaterThan(blockedAt)
  expect(JSON.parse(files[SHARED_PATH]!).probedAt).toBe(undefined)
})

test('T3 a successful probe clears quota state and restores the thirty-minute timer', async ($, on) => {
  const { clock, runs, files } = world(on, { replies: [QUOTA] })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  // 最初の停止から6時間に届く tick は次の30分境界。
  for (let i = 0; i < 13; i++) {
    await clock.advance(30 * MINUTE)
    await finish(clock)
  }
  expect(runs.length).toBe(2)
  const shared = JSON.parse(files[SHARED_PATH]!)
  expect(shared.blockedAt).toBe(undefined)
  expect(shared.blockedReason).toBe(undefined)
  expect(shared.probedAt).toBe(undefined)
  expect((await pane($)).text.includes('Grok枠切れで停止中')).toBe(false)
  await clock.advance(30 * MINUTE)
  await finish(clock)
  expect(runs.length).toBe(3)
})

test('T4 concurrent different owners require shared-file verification to fetch only once', async ($, on) => {
  const { clock, runs, files, isolated } = world(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  // command は実行しない。タイマーもセッション内の取得ガードもこの2本をまとめない。
  const pending = Promise.all([tick(isolated(), CFG, 'timer', 'session-a'), tick(isolated(), CFG, 'timer', 'session-b')])
  await finish(clock)
  await pending
  expect(runs.length).toBe(1)
  expect(JSON.parse(files[SHARED_PATH]!).lease).toBe(undefined)
})

test('T5 recent fetches and foreign leases block requests, expired leases allow manual fetch', async ($, on) => {
  const { clock, runs, files, isolated, now } = world(on, {
    shared: JSON.stringify({ lastFetchAt: 1_000_000 - 10 * MINUTE, lease: { owner: 'other', until: 2_000_000 } }),
  })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  // 初回の手動取得も別ownerのleaseで止める。
  await finish(clock)
  expect(runs.length).toBe(0)
  files[SHARED_PATH] = JSON.stringify({ lastFetchAt: 1_000_000 - 10 * MINUTE })
  let pending = tick(isolated(), CFG, 'timer', 'session-b')
  await finish(clock)
  await pending
  expect(runs.length).toBe(0)
  await clock.advance(19 * MINUTE)
  pending = tick(isolated(), CFG, 'timer', 'session-b')
  await finish(clock)
  await pending
  expect(runs.length).toBe(0)
  await clock.advance(MINUTE)
  pending = tick(isolated(), CFG, 'timer', 'session-b')
  await finish(clock)
  await pending
  expect(runs.length).toBe(1)
  files[SHARED_PATH] = JSON.stringify({ lease: { owner: 'other', until: now() + MINUTE } })
  await pane($)
  await $.ui.press({ plugin: 'tag-feed', key: 'now', surface: 'terminal' } as never)
  await finish(clock)
  expect(runs.length).toBe(1)
  await clock.advance(MINUTE)
  await $.ui.press({ plugin: 'tag-feed', key: 'now', surface: 'terminal' } as never)
  await finish(clock)
  expect(runs.length).toBe(2)
})

test('T6 an interval option of five minutes is clamped to thirty', { options: { intervalMinutes: 5 } }, async ($, on) => {
  const { clock, runs } = world(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  const result = await $.command.run({ command: 'tag-feed', args: 'ClaudeCode' })
  expect(result.text).toContain('30分おき')
  await finish(clock)
  await clock.advance(29 * MINUTE)
  await finish(clock)
  expect(runs.length).toBe(1)
  await clock.advance(MINUTE)
  await finish(clock)
  expect(runs.length).toBe(2)
  expect((await pane($)).text).toContain('30分おきに取得')
})

test('broken shared JSON prevents fetching and shows an error', async ($, on) => {
  const { clock, runs } = world(on, { shared: '{broken' })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  expect(runs.length).toBe(0)
  expect((await pane($)).text).toContain('取得エラー')
})

test('missing config and home directories prevent fetching', async ($, on) => {
  const { clock, runs, paths } = world(on, { env: {} })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  expect(runs.length).toBe(0)
  expect(paths.length).toBe(0)
  expect((await pane($)).text).toContain('保存先が不明')
})

test('quota text on stdout blocks even with exit zero, bare 402 does not', async ($, on) => {
  const { clock, runs, files } = world(on, {
    replies: [
      { exitCode: 0, stdout: 'https://x.com/alice/status/2110681402402000001', stderr: '' },
      { exitCode: 0, stdout: 'HTTP: 402 run out of credits', stderr: '' },
    ],
  })
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  expect(JSON.parse(files[SHARED_PATH]!).blockedAt).toBe(undefined)
  await pane($)
  await $.ui.press({ plugin: 'tag-feed', key: 'now', surface: 'terminal' } as never)
  await finish(clock)
  expect(runs.length).toBe(2)
  expect(JSON.parse(files[SHARED_PATH]!).blockedAt).toBeGreaterThan(0)
})

test('session start reflects shared quota state and a skipped timer reloads stored posts', async ($, on) => {
  const { files, clock, runs, stored } = world(on, { shared: JSON.stringify({ blockedAt: 500_000 }) })
  await $.session.start({ cwd: 'C:/work' } as never)
  const { ui, text } = await pane($)
  expect(text).toContain('Grok枠切れで停止中')
  files[SHARED_PATH] = JSON.stringify({ lastFetchAt: 1_000_000 })
  stored.posts = [{ id: 'other', name: 'Other', handle: 'other', text: '他セッションの投稿', time: '', url: '' }]
  await $.command.run({ command: 'tag-feed', args: '' })
  await finish(clock)
  files[SHARED_PATH] = JSON.stringify({ lastFetchAt: 2_799_999 })
  await clock.advance(30 * MINUTE)
  await finish(clock)
  expect(runs.length).toBe(1)
  expect((await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).join('\n')).toContain('他セッションの投稿')
})
