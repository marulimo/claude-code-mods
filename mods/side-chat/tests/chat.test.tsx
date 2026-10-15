import { expect, mock, test } from 'claude-code/testing'

type Run = { argv: readonly string[]; stdin?: string }

function wire(on: any, cwd: string, replies: string[]) {
  const runs: Run[] = []
  mock.store(on)
  on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: cwd }) as never)
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('process.run', (_$: unknown, e: any) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const stdout = replies[runs.length - 1] ?? 'こんにちは'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  return runs
}

async function walk(clock: { advance: (ms: number) => Promise<void> }, ms: number) {
  for (let t = 0; t < ms; t += 2_000) await clock.advance(2_000)
}

const done = (turnId: string) =>
  ({ turnId, reason: 'answer', answer: '', durationMs: 1, isAborted: false }) as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Dots と GrokBot が待ち時間に交互に話し、ターンが終われば黙る (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const runs = wire(on, 'C:/work', ['Dots: 「お茶でも淹れる？」\n', 'じゃあ俺はXでも眺めとくか'])

    await $.session.start({ cwd: 'C:/work' } as never)
    await $.turn.start({ text: 'ログイン画面の不具合を直して', turnId: 't1' })
    await ($.tool.call as any)({ tool: 'Bash', command: 'ls' })
    // サブエージェントのターンは数えない
    await $.turn.start({ text: 'sub', turnId: 'sub1' })
    await $.turn.complete(done('sub1'))

    await walk(clock, 12_000)
    expect(runs.length).toBe(0)

    await walk(clock, 12_000)
    expect(runs.length).toBe(1)
    const first = runs[0]!
    expect(first.argv).toContain('read-only')
    expect(first.argv).toContain('model="gpt-6.1-sol"')
    expect(first.stdin).toContain('ツール禁止')
    expect(first.stdin).toContain('ログイン画面の不具合を直して')
    expect(first.stdin).toContain('Bash')

    await walk(clock, 22_000)
    expect(runs.length).toBe(2)
    const second = runs[1]!
    expect(second.argv[0]).toBe('py')
    expect(second.argv).toContain('grok-4.3')
    expect(second.argv.join(' ')).toContain('Dots: お茶でも淹れる？')

    const ui = await $.ui.mount({ plugin: 'side-chat', surface, component: 'Pane', requestId: 'side-chat', props: {} as never })
    expect(await ui.find({ type: 'Text', text: /お茶でも淹れる？/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Xでも眺めとくか/ })).toBeDefined()

    await $.turn.complete(done('t1'))
    await walk(clock, 80_000)
    expect(runs.length).toBe(2)
  })
}

test('設定したフォルダーのセッションでは何も送らない', { options: { privateFolders: '/home/demo/private' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs = wire(on, '/home/demo/private/app', [])
  await $.session.start({ cwd: '/home/demo/private/app' } as never)
  await $.turn.start({ text: '非公開アプリ', turnId: 't1' })
  await walk(clock, 120_000)
  expect(runs.length).toBe(0)
})

test('1ターンの発言は maxLines で止まる', { options: { maxLines: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs = wire(on, 'C:/work', [])
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.turn.start({ text: '長い作業', turnId: 't1' })
  await walk(clock, 300_000)
  expect(runs.length).toBe(2)
})

test('/side-chat off で止まり、on で再開する', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const runs = wire(on, 'C:/work', [])
  await $.session.start({ cwd: 'C:/work' } as never)
  const off = await $.command.run({ command: 'side-chat', args: 'off' } as never)
  expect(off.text).toContain('止めました')
  await $.turn.start({ text: '作業', turnId: 't1' })
  await walk(clock, 60_000)
  expect(runs.length).toBe(0)
  await $.command.run({ command: 'side-chat', args: 'on' } as never)
  await walk(clock, 6_000)
  expect(runs.length).toBe(1)
})
