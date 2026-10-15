import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Run } from '../types'

const PANE = 'ask-codex'
const runs = atom({ plugin: 'ask-codex', key: 'runs' } as const, [] as Run[])
const mode = atom({ plugin: 'ask-codex', key: 'mode' } as const, 'devin' as Mode)
// パネルで選んだ推論強度。未選択の送り先は設定の既定値
const efforts = atom({ plugin: 'ask-codex', key: 'effort' } as const, {} as Partial<Record<Mode, string>>)

const EFFORTS: Record<Mode, string[]> = {
  devin: ['medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
}

// /devin は相談だけ。ファイルやシェルに手を出さないよう冒頭で縛る
const CHAT_GUARD =
  'これは相談です。ツール禁止・ファイル読取禁止・コマンド実行禁止。質問にそのまま日本語で答えてください。\n\n'

const LABEL: Record<Mode, string> = { devin: 'Devin', codex: 'Codex' }

type Sandbox = 'workspace-write' | 'danger-full-access'

type Config = {
  codexPath: string
  model: string
  codexSandbox: Sandbox
  devinPath: string
  devinDir: string
  effort: Record<Mode, string>
}

type Paths = { codex: string; devin: string; devinDir: string; errorLog: string }

// 実行中の子プロセス。止めるボタンが return() で殺す
const live = new Map<string, AsyncGenerator<unknown, unknown>>()
let resolved: Paths | undefined

async function exists($: EngineInterface, path: string) {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

// Windows の npm は codex.cmd を置くが、シェルなしでは起動できない。隣の node_modules から本体の exe を探す
async function findCodexOnWindows($: EngineInterface): Promise<string | undefined> {
  try {
    const { stdout } = await $.process.run(['where.exe', 'codex'])
    for (const line of stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      if (/\.exe$/i.test(line)) return line
      const dir = line.replace(/[\\/][^\\/]+$/, '')
      for (const [pkg, triple] of [
        ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
        ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
      ] as const) {
        const exe = `${dir}/node_modules/@openai/codex/node_modules/@openai/${pkg}/vendor/${triple}/bin/codex.exe`
        if (await exists($, exe)) return exe
      }
    }
  } catch {
    // where.exe が無い、または codex が PATH に無い
  }
  return undefined
}

async function resolvePaths($: EngineInterface, cfg: Config): Promise<Paths> {
  if (resolved) return resolved
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (windows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? '.'
  const base = `${home}/.ask-codex`

  const codex = cfg.codexPath || (windows ? ((await findCodexOnWindows($)) ?? 'codex') : 'codex')

  let devin = cfg.devinPath || 'devin'
  if (!cfg.devinPath && windows) {
    const local = await $.env.get('LOCALAPPDATA')
    const exe = local ? `${local}/devin/cli/bin/devin.exe` : ''
    if (exe && (await exists($, exe))) devin = exe
  }

  // Devin は中身の空な専用フォルダーで動かす
  const devinDir = cfg.devinDir || `${base}/devin-chat`
  await $.fs.write(`${devinDir}/.keep`, '').catch(() => undefined)

  resolved = { codex, devin, devinDir, errorLog: `${base}/errors.log` }
  return resolved
}

// 信頼確認はその1回だけ省き、auto は読み取り系ツールだけ通す
function devinArgv(paths: Paths, run: Run): string[] {
  return [
    paths.devin, '--model', `swe-2-${run.effort}`, '--permission-mode', 'auto',
    '--respect-workspace-trust', 'false', '-p', CHAT_GUARD + run.prompt,
  ]
}

function codexArgv(cfg: Config, paths: Paths, run: Run, cwd: string): string[] {
  const access =
    cfg.codexSandbox === 'danger-full-access'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-s', 'workspace-write', '-c', 'approval_policy="never"']
  return [
    paths.codex, 'exec', '--skip-git-repo-check', '-C', cwd,
    ...(cfg.model ? ['-c', `model="${cfg.model}"`] : []),
    '-c', `model_reasoning_effort=${run.effort}`,
    ...access, '-',
  ]
}

function patch($: EngineInterface, id: string, fields: Partial<Run>) {
  return update($, runs, list => list.map(r => (r.id === id ? { ...r, ...fields } : r)))
}

async function watch($: EngineInterface, cfg: Config, run: Run, cwd: string) {
  let stdout = ''
  let stderrTail = ''
  let code: number | null = null
  try {
    const paths = await resolvePaths($, cfg)
    const child = $.process.spawn(
      run.mode === 'devin'
        ? { argv: devinArgv(paths, run), cwd: paths.devinDir }
        : { argv: codexArgv(cfg, paths, run, cwd), input: run.prompt },
    )
    live.set(run.id, child)
    while (true) {
      const step = await child.next()
      if (step.done) {
        code = step.value.code
        break
      }
      const { stream, text } = step.value
      if (stream === 'stdout') {
        stdout += text
        continue
      }
      stderrTail = (stderrTail + text).slice(-4000)
      const sid = stderrTail.match(/session id: ([0-9a-f-]+)/)?.[1]
      const last = stderrTail
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('warning:') && !s.includes('is ignored'))
        .pop()
      await patch($, run.id, { progress: last?.slice(0, 200), ...(sid ? { sessionId: sid } : {}) })
    }
  } catch (err) {
    stderrTail += `\n${String(err)}`
  } finally {
    live.delete(run.id)
  }

  const now = (await read($, runs)).find(r => r.id === run.id)
  if (now?.status === 'cancelled') return
  const ok = code === 0 && stdout.trim() !== ''
  await patch($, run.id, {
    status: ok ? 'done' : 'error',
    endedAt: await $.clock.now(),
    answer: ok ? stdout.trim() : `exit ${code}\n\n${stderrTail.slice(-1500)}`,
    progress: undefined,
  })
  if (!ok) noteError($, `run ${run.mode} exit=${code}`, stderrTail.slice(-1500))
  $.ui.toast(`${LABEL[run.mode]} ${ok ? 'の返答が届きました' : 'がエラーで終了しました'}`)
}

async function send($: EngineInterface, cfg: Config, m: Mode, prompt: string) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const cwd = await $.session.cwd()
  const effort = (await read($, efforts))[m] ?? cfg.effort[m]
  const run: Run = { id, mode: m, effort, prompt, status: 'running', startedAt: await $.clock.now() }
  await update($, runs, list => [run, ...list].slice(0, 30))
  void openPane($)
  // dispatch を越えて走らせる。ループが子プロセスの寿命
  void watch($, cfg, run, cwd)
}

// 右のドックに出たときの幅（文字数）。置き場所そのものは表示側が決める
const DOCK_COLUMNS = 64

function openPane($: EngineInterface, focus?: true) {
  return $.ui.open({ id: PANE, title: 'Devin / Codex', columns: DOCK_COLUMNS, ...(focus ? { focus } : {}) })
}

async function cancel($: EngineInterface, id: string) {
  await patch($, id, { status: 'cancelled', endedAt: await $.clock.now(), progress: undefined })
  await live.get(id)?.return(undefined)
}

function fillClaude($: EngineInterface, r: Run) {
  return $.prompt.fill({
    text: `${LABEL[r.mode]} の返答:\n${(r.answer ?? '').replace(/^/gm, '> ')}\n\n`,
    mode: 'insert',
  })
}

function copyAnswer($: EngineInterface, r: Run, surface: string) {
  return $.ui.copy({ text: r.answer ?? '', surface: surface as never })
}

// 長い文や複数行の文は Claude の入力欄で書いて、そのまま送る（Claude は呼ばない）
async function sendComposer($: EngineInterface, cfg: Config, m: Mode) {
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    $.ui.toast('Claudeの入力欄が空です')
    return
  }
  await send($, cfg, m, text.trim())
  await $.prompt.fill({ text: '', mode: 'replace' })
}

function pickEffort($: EngineInterface, m: Mode, v: string) {
  return update($, efforts, map => ({ ...map, [m]: v }))
}

function pickMode($: EngineInterface, v: string) {
  return update($, mode, () => v as Mode)
}

function removeRun($: EngineInterface, id: string) {
  return update($, runs, l => l.filter(x => x.id !== id))
}

// 失敗の理由を ~/.ask-codex/errors.log に残す。置き場所が決まる前の失敗は残さない
function noteError($: EngineInterface, step: string, err: unknown) {
  const log = resolved?.errorLog
  if (!log) return
  const line = `${new Date().toISOString()} ${step}: ${String(err)}\n`
  void $.fs
    .read(log)
    .catch(() => '')
    .then(prev => $.fs.write(log, String(prev).slice(-8000) + line))
    .catch(() => undefined)
}

async function registerCommands($: EngineInterface) {
  for (const spec of [DEVIN_COMMAND, CODEX_COMMAND, PANEL_COMMAND]) {
    try {
      await $.command.register(spec)
    } catch (err) {
      noteError($, `command.register /${spec.name}`, err)
    }
  }
}

const CODEX_COMMAND = {
  name: 'codex',
  description: 'Codex に作業を頼む。今の作業フォルダーで動く',
  argumentHint: '<プロンプト>',
}
const DEVIN_COMMAND = {
  name: 'devin',
  description: 'Devin SWE-2 にチャットで質問する。ツールは使わせない',
  argumentHint: '<プロンプト>',
}

const PANEL_COMMAND = { name: 'codex-panel', description: 'Devin / Codex のパネルを開く' }

export const register: Register = (on, options) => {
  const cfg: Config = {
    codexPath: String(options.codexPath ?? ''),
    model: String(options.model ?? ''),
    codexSandbox: options.codexSandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
    devinPath: String(options.devinPath ?? ''),
    devinDir: String(options.devinDir ?? ''),
    effort: {
      codex: String(options.codexEffort),
      devin: String(options.devinEffort),
    },
  }
  const codexNote =
    cfg.codexSandbox === 'danger-full-access'
      ? 'Codex は今の作業フォルダーを確認なしで全権限で書き換えます'
      : 'Codex は今の作業フォルダーの中だけ書き換えます'

  on('session.start', async ($, e, next) => {
    // 1つ失敗しても残りとセッション開始は続ける。理由はファイルに残す
    await resolvePaths($, cfg).catch(() => undefined)
    await registerCommands($)
    const started = await next(e)
    // 起動時に開いておく。ドックできる画面では右のサイドバーになる
    void openPane($).catch(err => noteError($, 'ui.open', err))
    return started
  }).catch(($, e, next) => next(e))

  for (const m of ['devin', 'codex'] as const) {
    on('command.run', { command: m }, async ($, e) => {
      const prompt = e.args.trim()
      if (!prompt) {
        await pickMode($, m)
        await openPane($, true)
        return { text: `パネルを開きました。${LABEL[m]} に送る文を入力してください。` }
      }
      await send($, cfg, m, prompt)
      return { text: `${LABEL[m]} に送信しました。返答はパネルに出ます。` }
    })
  }

  on('command.run', { command: 'codex-panel' }, async $ => {
    await openPane($, true)
    return { text: 'Devin / Codex のパネルを開きました。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button, Input, Select, Markdown } = ui
    const list = await read($, runs)
    const stored = await read($, mode)
    const current: Mode = stored in LABEL ? stored : 'devin'
    const effort = (await read($, efforts))[current] ?? cfg.effort[current]
    const now = await $.clock.now()
    const secs = (r: Run) => Math.round(((r.endedAt ?? now) - r.startedAt) / 1000)
    const mark = { running: '実行中', done: '完了', error: 'エラー', cancelled: '中止' }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button
              key="mode-devin"
              label="Devin（相談）"
              variant={current === 'devin' ? 'primary' : 'secondary'}
              dimColor={current !== 'devin'}
              onPress={() => pickMode($, 'devin')}
            />
            <Button
              key="mode-codex"
              label="Codex（作業）"
              variant={current === 'codex' ? 'primary' : 'secondary'}
              dimColor={current !== 'codex'}
              onPress={() => pickMode($, 'codex')}
            />
          </Box>
          {current === 'codex' ? <Text dimColor>{codexNote}</Text> : null}
          {Select ? (
            <Select
              key="effort"
              label="推論"
              value={effort}
              options={EFFORTS[current].map(v => ({ value: v, label: v }))}
              onSelect={(v: string) => pickEffort($, current, v)}
            />
          ) : null}
          {Input ? (
            <Input
              key="prompt"
              label={`${LABEL[current]}に質問`}
              placeholder="ここに書いて Enter（コマンドは不要）"
              submitLabel="送信"
              autoFocus
              value=""
              onSubmit={(v: string) => {
                if (v.trim()) void send($, cfg, current, v.trim())
              }}
            />
          ) : (
            <Text dimColor>この画面では入力欄が使えません。/devin /codex で送ってください。</Text>
          )}
          <Box flexDirection="row">
            <Button
              key="send-composer"
              label="Claudeの入力欄の文を送る"
              dimColor
              onPress={() => sendComposer($, cfg, current)}
            />
          </Box>
        </Box>
        {list.length === 0 && <Text dimColor>まだ送信していません。</Text>}
        {list.map(r => (
          <Box key={r.id} flexDirection="column">
            <Text bold>
              [{LABEL[r.mode]} {r.effort}] {mark[r.status]} {secs(r)}秒
              {r.sessionId ? ` ${r.sessionId.slice(0, 8)}` : ''}
            </Text>
            <Text dimColor>{r.prompt.length > 300 ? `${r.prompt.slice(0, 300)}…` : r.prompt}</Text>
            {r.status === 'running' && r.progress ? <Text dimColor>{r.progress}</Text> : null}
            {r.answer ? <Markdown key={`a-${r.id}`} text={r.answer} /> : null}
            <Box flexDirection="row" gap={1}>
              {r.status === 'running' ? (
                <Button key={`stop-${r.id}`} label="止める" onPress={() => cancel($, r.id)} />
              ) : null}
              {r.answer ? (
                <Button
                  key={`copy-${r.id}`}
                  label="コピー"
                  onPress={(pe: { surface: string }) => copyAnswer($, r, pe?.surface ?? e.surface)}
                />
              ) : null}
              {r.answer ? (
                <Button
                  key={`claude-${r.id}`}
                  label="Claudeの入力欄へ"
                  variant="primary"
                  onPress={() => fillClaude($, r)}
                />
              ) : null}
              {r.status !== 'running' ? (
                <Button key={`del-${r.id}`} label="消す" dimColor onPress={() => removeRun($, r.id)} />
              ) : null}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
