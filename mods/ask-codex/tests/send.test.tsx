import { expect, mock, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/devin sends a guarded prompt and the pane shows the answer (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const spawned: { argv: readonly string[]; input?: string }[] = []
    const toasts: string[] = []
    const filled: string[] = []

    on('env.get', () => ({ value: '/home/demo' }))
    on('session.cwd', () => ({ value: 'C:/work' }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.toast', (_$, e) => {
      toasts.push(JSON.stringify(e))
      return { value: undefined } as never
    })
    on('prompt.fill', (_$, e) => {
      filled.push(e.text)
      return { isFilled: true } as never
    })
    on('process.spawn', async function* (_$, e) {
      spawned.push({ argv: e.argv, input: e.input })
      yield { stream: 'stderr', text: 'session id: 01a13f26-aaaa\n' }
      yield { stream: 'stdout', text: '答えは2です' }
      return { value: { code: 0, signal: null } } as never
    })

    await $.session.start({ cwd: 'C:/work' } as never)
    const ran = await $.command.run({ command: 'devin', args: '1+1は？', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(ran.text).toContain('Devin に送信しました')
    await clock.settle()

    expect(spawned.length).toBe(1)
    const argv = spawned[0]!.argv
    expect(argv).toContain('swe-2-high')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv[argv.indexOf('-p') + 1]).toContain('ツール禁止')
    expect(argv[argv.indexOf('-p') + 1]).toContain('1+1は？')
    expect(toasts[0]).toContain('返答が届きました')

    const ui = await $.ui.mount({ plugin: 'ask-codex', surface, component: 'Pane', requestId: 'ask-codex', props: {} as never })
    expect((await ui.find({ type: 'Markdown', text: '答えは2です' }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /完了/ }))).toBeDefined()

    const runId = (await ui.findAll({ type: 'Button' })).map(b => b.key).find(k => k?.startsWith('claude-'))
    await $.ui.press({ plugin: 'ask-codex', key: runId!, surface } as never)
    expect(filled[0]).toContain('> 答えは2です')
  })
}

test('/codex runs with full access in the session folder', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: (readonly string[])[] = []
  on('env.get', () => ({ value: '/home/demo' }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout', text: 'done' }
    return { value: { code: 0, signal: null } } as never
  })

  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'codex', args: 'README を直して', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.settle()

  const argv = spawned[0]!
  expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(argv).not.toContain('read-only')
  expect(argv[argv.indexOf('-C') + 1]).toBe('C:/work')
  expect(argv).toContain('model_reasoning_effort=high')
})

test('a failed run is shown as an error with stderr', async ($, on) => {
  const clock = mock.clock(on)
  on('env.get', () => ({ value: '/home/demo' }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.spawn', async function* () {
    yield { stream: 'stderr', text: 'ERROR: not logged in\n' }
    return { value: { code: 1, signal: null } } as never
  })

  await $.session.start({ cwd: 'C:/work' } as never)
  await $.command.run({ command: 'devin', args: 'hi', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'terminal', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /エラー/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /not logged in/ })).toBeDefined()
})

test('session.start still starts when a command registration is refused', async ($, on) => {
  const listed: string[] = []
  on('env.get', () => ({ value: undefined }))
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

test('the effort picked in the pane is used, and the composer draft is sent', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: { argv: readonly string[]; input?: string }[] = []
  const fills: string[] = []
  on('env.get', () => ({ value: '/home/demo' }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '1行目\n2行目', cursor: 0 } }) as never)
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true } as never
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, input: e.input })
    yield { stream: 'stdout', text: 'ok' }
    return { value: { code: 0, signal: null } } as never
  })

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.select({ key: 'mode', value: 'codex' })
  await ui.select({ key: 'effort', value: 'xhigh' })
  await ui.press({ key: 'send-composer' })
  await clock.settle()

  expect(spawned[0]!.argv).toContain('model_reasoning_effort=xhigh')
  expect(spawned[0]!.input).toContain('1行目\n2行目')
  expect(fills).toEqual([''])
  expect(await ui.find({ type: 'Text', text: /Codex xhigh/ })).toBeDefined()
})

test('typing in the pane field sends to Devin without a slash command', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: { argv: readonly string[]; input?: string }[] = []
  on('env.get', () => ({ value: '/home/demo' }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, input: e.input })
    yield { stream: 'stdout', text: '晴れです' }
    return { value: { code: 0, signal: null } } as never
  })

  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'ask-codex', surface: 'desktop', component: 'Pane', requestId: 'ask-codex', props: {} as never })
  await ui.input({ key: 'prompt', text: '明日の天気は？' })
  await clock.settle()

  expect(spawned[0]!.argv).toContain('swe-2-high')
  expect(spawned[0]!.argv.join(' ')).toContain('明日の天気は？')
  expect(await ui.find({ type: 'Markdown', text: '晴れです' })).toBeDefined()
})

test('/devin asks SWE-2 in the trusted chat folder with the guard', { options: { devinDir: '/home/demo/devin-ask' } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawned: { argv: readonly string[]; cwd?: string }[] = []
  on('env.get', () => ({ value: '/home/demo' }))
  on('session.cwd', () => ({ value: 'C:/work' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, cwd: e.cwd })
    yield { stream: 'stdout', text: '2' }
    return { value: { code: 0, signal: null } } as never
  })

  await $.session.start({ cwd: 'C:/work' } as never)
  const ran = await $.command.run({ command: 'devin', args: '1+1は？', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(ran.text).toContain('Devin に送信しました')
  await clock.settle()

  const { argv, cwd } = spawned[0]!
  expect(argv[0]).toBe('devin')
  expect(argv).toContain('swe-2-high')
  expect(argv).toContain('auto')
  expect(argv[argv.indexOf('-p') + 1]).toContain('ツール禁止')
  expect(argv[argv.indexOf('-p') + 1]).toContain('1+1は？')
  expect(cwd).toBe('/home/demo/devin-ask')
})

for (const homeKey of ['USERPROFILE', 'HOME'] as const) {
  test(`empty Devin folder uses ${homeKey}`, async ($, on) => {
    const clock = mock.clock(on)
    on('env.get', (_, e) => ({ value: e.name === homeKey ? '/home/demo' : undefined }))
    on('session.cwd', () => ({ value: '/home/demo/project' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }))
    const folders: (string | undefined)[] = []
    on('process.spawn', async function* (_, e) {
      folders.push(e.cwd)
      yield { stream: 'stdout', text: 'ok' }
      return { value: { code: 0, signal: null } } as never
    })
    await $.command.run({ command: 'devin', args: 'hello' } as never)
    await clock.settle()
    expect(folders).toEqual(['/home/demo/devin-ask'])
  })
}
