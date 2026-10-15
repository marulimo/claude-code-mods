import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, PromptOrigin } from 'claude-code'

const configured = { routerScript: '/home/demo/router/route.py', privateFolders: '/home/demo/private', privateWords: 'secret-project,confidential,internal,restricted,社外秘' }

const result = (data: unknown, exitCode = 0): ProcessRunResult => ({
  exitCode, stdout: JSON.stringify(data) + '\r\n', stderr: 'SECRET_STDERR', isStdoutTruncated: false, isStderrTruncated: false,
})
const success = (id = 'sol', label = 'Sol', p = 0.82) => result({ ok: true, top: [{ id, p }], label, entry: 'codex-impl スキル' })
const prompt = (text = 'ログイン画面のバグを修正してください', origin: PromptOrigin = { kind: 'composer' }) => ({ text, origin, wait: false })

function setup(on: On, cwd = 'C:/work/project') {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('session.cwd', () => ({ value: 'C:/work/project' }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: cwd } }))
  const seen = { clock, toasts, statuses, onToast: (_text: string) => {}, onStatus: (_text: string | undefined) => {} }
  on('ui.toast', (_, e) => { toasts.push(e.text); seen.onToast(e.text); return { value: undefined } })
  on('ui.status', (_, e) => { statuses.push(e.text); seen.onStatus(e.text); return { value: undefined } })
  on('prompt.submit', (_, e) => ({ text: e.text, origin: e.origin }))
  return seen
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('returns next before process resolves, passes stdin and fixed argv', { options: configured }, async ($, on) => {
  const seen = setup(on)
  const pending = deferred<ProcessRunResult>()
  const started = deferred<boolean>()
  const displayed = deferred<boolean>()
  seen.onToast = () => { displayed.resolve(true) }
  on('process.run', async (_, e) => {
    expect(e.argv).toEqual(['python', '/home/demo/router/route.py', '--backend', 'jev'])
    expect(e.init?.stdin).toBe(prompt().text)
    expect(e.init?.timeoutMs).toBe(12000)
    started.resolve(true)
    return { value: await pending.promise }
  })
  const returned = await $.prompt.submit(prompt())
  expect(returned.text).toBe(prompt().text)
  await seen.clock.settle()
  await started.promise
  expect(seen.toasts.length).toBe(0)
  pending.resolve(success())
  await seen.clock.settle()
  await displayed.promise
  expect(seen.toasts).toEqual(['→ Sol 82%｜codex-impl スキル'])
})

for (const [name, text, origin, cwd] of [
  ['plugin', 'プラグイン由来の入力です', { kind: 'plugin', name: 'other' }, 'C:/work'],
  ['notification', 'バックグラウンドの通知です', { kind: 'task-notification' }, 'C:/work'],
  ['peer', 'ピアセッションからの依頼です', { kind: 'peer' }, 'C:/work'],
  ['slash', '/review this code', { kind: 'composer' }, 'C:/work'],
  ['short', '  七文字以下  ', { kind: 'composer' }, 'C:/work'],
  ['whitespace', 'a   b   c   d', { kind: 'composer' }, 'C:/work'],
  ['private cwd', 'このファイルを確認してください', { kind: 'composer' }, '/HOME/DEMO/PRIVATE/project'],
  ...['secret-project', 'confidential', 'internal', 'restricted', '社外秘', 'SeCrEt-PrOjEcT', '~/secret-project'].map(word => [word, `${word}について詳しく調べてください`, { kind: 'composer' }, 'C:/work']),
] as [string, string, PromptOrigin, string][]) {
  test(`skips ${name} without process`, { options: configured }, async ($, on) => {
    const seen = setup(on, cwd)
    let calls = 0
    on('process.run', () => { calls++; return { value: success() } })
    await $.prompt.submit(prompt(text, origin))
    // Flush the finite cwd/stat continuations, without a real clock or process.
    await seen.clock.settle()
    expect(calls).toBe(0)
    expect(seen.toasts.length).toBe(0)
  })
}

test('only latest submission displays when first completes last', { options: configured }, async ($, on) => {
  const seen = setup(on)
  const first = deferred<ProcessRunResult>()
  const firstStarted = deferred<boolean>()
  const secondShown = deferred<boolean>()
  let calls = 0
  seen.onToast = () => { secondShown.resolve(true) }
  on('process.run', async () => {
    calls++
    if (calls === 1) { firstStarted.resolve(true); return { value: await first.promise } }
    return { value: success('astra', 'Astra', 0.91) }
  })
  await $.prompt.submit(prompt())
  await seen.clock.settle()
  await firstStarted.promise
  await $.prompt.submit(prompt('次の設計書をレビューしてください'))
  await seen.clock.settle()
  await secondShown.promise
  first.resolve(success())
  await seen.clock.settle()
  expect(seen.toasts).toEqual(['→ Astra 91%｜codex-impl スキル'])
  expect(seen.statuses.at(-1)).toBe('→ Astra 91%｜codex-impl スキル')
})

for (const [name, response, reason] of [
  ['failure JSON', result({ ok: false, reason: 'decisions_key_missing' }), 'decisions_key_missing'],
  ['nonzero exit', result({}, 2), 'exit_2'],
  ['invalid JSON', { ...result({}), stdout: '{bad' }, 'invalid_json'],
] as const) {
  test(name, { options: configured }, async ($, on) => {
    const seen = setup(on)
    const displayed = deferred<boolean>()
    seen.onStatus = text => { if (text === `AI判別: 失敗（${reason}）`) displayed.resolve(true) }
    on('process.run', () => ({ value: response }))
    await $.prompt.submit(prompt())
    await seen.clock.settle()
  await displayed.promise
    expect(seen.statuses.at(-1)).toBe(`AI判別: 失敗（${reason}）`)
    expect(JSON.stringify(seen)).not.toContain('SECRET_STDERR')
    expect(seen.toasts.length).toBe(0)
  })
}

test('runner up and decisions backend', { options: { ...configured, backend: 'decisions' } }, async ($, on) => {
  const seen = setup(on)
  const shown = deferred<boolean>()
  seen.onToast = () => { shown.resolve(true) }
  on('process.run', (_, e) => {
    expect(e.argv.at(-1)).toBe('decisions')
    return { value: result({ ok: true, top: [{ id: 'sol', p: 0.82 }, { id: 'astra', p: 0.11 }], label: 'Sol', entry: 'codex-impl スキル' }) }
  })
  await $.prompt.submit(prompt())
  await seen.clock.settle()
  await shown.promise
  expect(seen.toasts.length).toBe(1)
})

test('unconfigured script shows guidance and does not classify', async ($, on) => {
  const seen = setup(on)
  let calls = 0
  on('process.run', () => { calls++; return { value: success() } })
  await $.prompt.submit(prompt())
  await seen.clock.settle()
  expect(calls).toBe(0)
  expect(seen.statuses.at(-1)).toBe('AI判別: 判定スクリプト未設定')
})
