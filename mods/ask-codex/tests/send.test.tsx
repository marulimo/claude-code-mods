import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Spawned = { argv: readonly string[]; cwd?: string; input?: string }

// 下の世界をまとめて用意する。spawn は渡された出力を返す
function world(on: On, out: { stream: 'stdout' | 'stderr'; text: string }[], code = 0) {
  const spawned: Spawned[] = []
  const fills: string[] = []
  const toasts: string[] = []
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/u', LOCALAPPDATA: 'C:/Users/u/AppData/Local' })
  on('process.run', () =>
    ({ value: { exitCode: 0, stdout: 'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('fs.stat', (_$, e) => {
    const path = String((e as { path?: string }).path ?? e)
    if (/codex-win32-x64.*codex\.exe$|devin\.exe$/.test(path)) return { value: { kind: 'file' } } as never
    throw new Error('ENOENT')
  })
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('fs.read', () => ({ value: '' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '1行目\n2行目', cursor: 0 } }) as never)
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true } as never
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, cwd: e.cwd, input: e.input })
    for (const chunk of out) yield chunk
    return { value: { code, signal: null } } as never
  })
  return { spawned, fills, toasts }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/devin asks SWE-2 with the guard and the pane shows the answer (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, [{ stream: 'stdout', text: '答えは2です' }])

    await $.session.start({ cwd: 'C:/work' } as never)
    const ran = await $.command.run({ command: 'devin', args: '1+1は？' } as never)
    expect(ran.text).toContain('Devin に送信しました')
    await clock.settle()

    const { argv, cwd } = w.spawned[0]!
    expect(argv[0]).toBe('C:/Users/u/AppData/Local/devin/cli/bin/devin.exe')
    expect(argv).toContain('swe-2-high')
    expect(argv).toContain('auto')
    expect(argv[argv.indexOf('--respect-workspace-trust') + 1]).toBe('false')
    expect(argv[argv.indexOf('-p') + 1]).toContain('ツール禁止')
    expect(argv[argv.indexOf('-p') + 1]).toContain('1+1は？')
    expect(cwd).toBe('C:/Users/u/.ask-codex/devin-chat')
    expect(w.toasts[0]).toContain('返答が届きました')

    const ui = await $.ui.mount({ plugin: 'ask-codex', surface, component: 'Pane', requestId: 'ask-codex', props: {} as never })
    expect(await ui.find({ type: 'Markdown', text: '答えは2です' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Devin high\] 完了/ })).toBeDefined()

    const toClaude = (await ui.findAll({ type: 'Button' })).map(b => b.key).find(k => k?.startsWith('claude-'))
    await $.ui.press({ plugin: 'ask-codex', key: toClaude!, surface } as never)
    expect(w.fills[0]).toContain('> 答えは2です')
  })
}

test('/codex works only inside the session folder by default', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, [{ stream: 'stdout', text: 'done' }])

  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'codex', args: 'README を直して' } as never)
  await clock.settle()

  const { argv, input } = w.spawned[0]!
  expect(argv[0]).toBe(
    'C:\\npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  )
  expect(argv[argv.indexOf('-s') + 1]).toBe('workspace-write')
  expect(argv).toContain('approval_policy="never"')
  expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(argv.some(a => a.startsWith('model='))).toBe(false)
  expect(argv[argv.indexOf('-C') + 1]).toBe('C:/work')
  expect(argv).toContain('model_reasoning_effort=high')
  expect(input).toBe('README を直して')
})

test('/codex runs with full access and the chosen model when configured', {
  options: { codexSandbox: 'danger-full-access', model: 'gpt-6.1-sol' },
}, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, [{ stream: 'stdout', text: 'done' }])

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.press({ key: 'mode-codex' })
  expect(await ui.find({ type: 'Text', text: /確認なしで全権限/ })).toBeDefined()
  await $.command.run({ command: 'codex', args: 'README を直して' } as never)
  await clock.settle()

  const { argv } = w.spawned[0]!
  expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(argv).not.toContain('workspace-write')
  expect(argv).toContain('model="gpt-6.1-sol"')
})

test('a failed run is shown as an error with stderr', async ($, on) => {
  const clock = mock.clock(on)
  world(on, [{ stream: 'stderr', text: 'Error: Refusing to run in an untrusted workspace\n' }], 1)

  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'devin', args: 'hi' } as never)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'terminal', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /エラー/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /untrusted workspace/ })).toBeDefined()
})

test('session.start still starts when a command registration is refused', async ($, on) => {
  const listed: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    if (e.name === 'codex') throw new Error('already registered')
    listed.push(e.name)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.read', () => ({ value: '' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)

  const started = await $.session.start({ cwd: 'C:/work' } as never)
  expect(started.cwd).toBe('C:/work')
  expect(listed).toEqual(['devin', 'codex-panel'])
})

test('the strength picked in the pane is used, and the composer draft is sent', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, [{ stream: 'stdout', text: 'ok' }])

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.select({ key: 'effort', value: 'max' })
  await ui.press({ key: 'send-composer' })
  await clock.settle()

  const { argv } = w.spawned[0]!
  expect(argv).toContain('swe-2-max')
  expect(argv[argv.indexOf('-p') + 1]).toContain('1行目\n2行目')
  expect(w.fills).toEqual([''])
  expect(await ui.find({ type: 'Text', text: /Devin max/ })).toBeDefined()
})

test('typing in the pane field sends to Devin without a slash command', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, [{ stream: 'stdout', text: '晴れです' }])

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.input({ key: 'prompt', text: '明日の天気は？' })
  await clock.settle()

  const { argv } = w.spawned[0]!
  expect(argv[0]).toContain('devin.exe')
  expect(argv[argv.indexOf('-p') + 1]).toContain('明日の天気は？')
  expect(await ui.find({ type: 'Markdown', text: '晴れです' })).toBeDefined()
})

test('the Codex button switches the pane field to Codex without a slash command', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, [{ stream: 'stdout', text: '直しました' }])

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.press({ key: 'mode-codex' })
  expect(await ui.find({ type: 'Text', text: /作業フォルダーの中だけ/ })).toBeDefined()
  await ui.input({ key: 'prompt', text: 'README を直して' })
  await clock.settle()

  const { argv, input } = w.spawned[0]!
  expect(argv[0]).toContain('codex.exe')
  expect(argv).toContain('workspace-write')
  expect(input).toBe('README を直して')
  expect(await ui.find({ type: 'Text', text: /Codex high\] 完了/ })).toBeDefined()
})
