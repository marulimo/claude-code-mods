import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Chat, Line, Speaker } from '../types'

const PANE = 'side-chat'
const DOCK_COLUMNS = 56
const TICK_MS = 4_000
const MAX_KEEP = 60

const lines = atom({ plugin: 'side-chat', key: 'lines' } as const, [] as Line[])
const chat = atom({ plugin: 'side-chat', key: 'chat' } as const, { isEnabled: true, isBlocked: false } as Chat)

export type Config = {
  codexPath: string
  gptModel: string
  python: string
  pythonVersion: string
  grokModel: string
  startDelayMs: number
  gapMs: number
  maxLines: number
}

const NAME: Record<Speaker, string> = { dots: 'Dots', grok: 'GrokBot' }

// 外へ送るのは依頼文の先頭とツール名だけ。モジュール変数なので再読込で消えてよい
let promptHead = ''
let toolsSeen: string[] = []

// 設定したフォルダーとその配下では外部に送らない
export function isBlockedPath(cwd: string, folders: string[]): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const path = normalize(cwd)
  return folders.some(folder => path === normalize(folder) || path.startsWith(`${normalize(folder)}/`))
}

export function nextSpeaker(chatNow: Chat, turnLines: Line[], now: number, cfg: Config): Speaker | undefined {
  if (!chatNow.isEnabled || chatNow.isBlocked || !chatNow.turnId || chatNow.busy) return undefined
  if (now - (chatNow.turnStartedAt ?? now) < cfg.startDelayMs) return undefined
  if (turnLines.length >= cfg.maxLines) return undefined
  const last = turnLines[turnLines.length - 1]
  if (last && now - last.at < cfg.gapMs) return undefined
  // 交互に話す。ターンの最初は前ターンの最後と逆側から
  if (last) return last.who === 'dots' ? 'grok' : 'dots'
  return turnLines.length % 2 === 0 ? 'dots' : 'grok'
}

const PERSONA: Record<Speaker, string> = {
  dots:
    'あなたは「Dots」。ユーザーの日常を支える穏やかな相棒（ChatGPT）。生活や体調、息抜きに目を向ける。',
  grok:
    'あなたは「GrokBot」。Xをよく見ている、ちょっと茶目っ気のある相棒（Grok）。軽いツッコミや小ネタが得意。',
}

export function buildPrompt(who: Speaker, head: string, tools: string[], recent: Line[]): string {
  const other = who === 'dots' ? 'GrokBot' : 'Dots'
  const log = recent.map(l => `${NAME[l.who]}: ${l.text}`).join('\n')
  return [
    'ツール禁止・ファイル読取禁止・検索禁止。考えたことだけで答える。',
    PERSONA[who],
    `いま、ユーザーは Claude Code にプログラミング作業を頼んで、返事を待っている。あなたは右側の小窓で ${other} と雑談している。`,
    `頼んだ内容の冒頭: 「${head || '（不明）'}」`,
    `Claude がここまでに使った道具: ${tools.length ? tools.join('、') : 'まだなし'}`,
    log ? `ここまでの雑談:\n${log}` : 'まだ誰も話していない。あなたから話し始める。',
    `次のあなたの一言を書く。40字以内、1文か2文。${other}の発言があれば受けて返してよい。`,
    '作業の中身や結果を知っているふりはしない。説教や助言の押しつけはしない。名前の前置きや引用符は付けない。',
  ].join('\n')
}

export function cleanReply(raw: string): string {
  const one = raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^(Dots|GrokBot|Grok)\s*[:：]\s*/i, '')
    .replace(/^[「"']+|[」"']+$/g, '')
    .trim()
  return one.length > 90 ? `${one.slice(0, 89)}…` : one
}

async function say($: EngineInterface, cfg: Config, who: Speaker, prompt: string): Promise<string> {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  if (who === 'dots') {
    const r = await $.process.run(
      [
        cfg.codexPath, 'exec', '--skip-git-repo-check',
        '-c', `model="${cfg.gptModel}"`, '-c', 'model_reasoning_effort=low',
        '-s', 'read-only', '-',
      ],
      { stdin: prompt, timeoutMs: 90_000, env },
    )
    if (r.exitCode !== 0) throw new Error(`codex exit ${r.exitCode}: ${r.stderr.slice(-300)}`)
    return r.stdout
  }
  const code =
    'import sys\n' +
    'from hermes_cli.main import main\n' +
    `sys.argv=['hermes','-z',sys.argv[1],'-m',sys.argv[2],'--provider','xai-oauth']\n` +
    'main()\n'
  const r = await $.process.run(
    [cfg.python, ...(cfg.pythonVersion ? [cfg.pythonVersion] : []), '-c', code, prompt, cfg.grokModel],
    { timeoutMs: 90_000, env },
  )
  if (r.exitCode !== 0) throw new Error(`hermes exit ${r.exitCode}: ${r.stderr.slice(-300)}`)
  return r.stdout
}

export async function tick($: EngineInterface, cfg: Config) {
  const c = await read($, chat)
  const all = await read($, lines)
  const turnLines = all.filter(l => l.turnId === c.turnId)
  const now = await $.clock.now()
  const who = nextSpeaker(c, turnLines, now, cfg)
  if (!who) return
  const turnId = c.turnId!
  await update($, chat, x => ({ ...x, busy: who, error: undefined }))
  try {
    const text = cleanReply(await say($, cfg, who, buildPrompt(who, promptHead, toolsSeen, all.slice(-6))))
    if (text) {
      const at = await $.clock.now()
      await update($, lines, list => [...list, { id: `${turnId}-${at}-${who}`, who, text, at, turnId }].slice(-MAX_KEEP))
    }
  } catch (err) {
    await update($, chat, x => ({ ...x, error: `${NAME[who]}: ${String(err).slice(0, 200)}` }))
  } finally {
    await update($, chat, x => ({ ...x, busy: undefined }))
  }
}

function openPane($: EngineInterface, focus?: boolean) {
  return $.ui.open({ id: PANE, title: '待ち時間の雑談', columns: DOCK_COLUMNS, ...(focus ? { focus } : {}) })
}

async function setEnabled($: EngineInterface, on: boolean) {
  await update($, chat, x => ({ ...x, isEnabled: on }))
  await $.store.set('enabled', on)
}

function fmtWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

let timer: Timer | undefined

export const register: Register = (on, options) => {
  const cfg: Config = {
    codexPath: String(options.codexPath || 'codex'),
    gptModel: String(options.gptModel || 'gpt-6.1-sol'),
    python: String(options.python || 'py'),
    pythonVersion: String(options.pythonVersion ?? ''),
    grokModel: String(options.grokModel || 'grok-4.3'),
    startDelayMs: Math.max(5, Number(options.startDelaySec) || 20) * 1000,
    gapMs: Math.max(5, Number(options.gapSec) || 20) * 1000,
    maxLines: Math.max(1, Number(options.maxLines) || 6),
  }

  const privateFolders = String(options.privateFolders || '').split(',').map(s => s.trim()).filter(Boolean)

  on('session.start', async ($, e, next) => {
    const res = await next(e)
    await $.command.register({
      name: 'side-chat',
      description: '推論待ちの雑談パネル。on / off で切り替え、引数なしでパネルを開く',
      argumentHint: '[on|off]',
    })
    const stored = await $.store.get('enabled')
    const cwd = String(e.cwd ?? (await $.session.cwd()) ?? '')
    await update($, chat, x => ({
      ...x,
      isEnabled: stored !== false,
      isBlocked: isBlockedPath(cwd, privateFolders),
      turnId: undefined,
      busy: undefined,
    }))
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => void tick($, cfg))
    void openPane($)
    return res
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const c = await read($, chat)
    // 実行中のターンの内側で始まったもの（サブエージェント等）は数えない
    if (!c.turnId) {
      promptHead = e.text.replace(/\s+/g, ' ').trim().slice(0, 200)
      toolsSeen = []
      const now = await $.clock.now()
      await update($, chat, x => ({ ...x, turnId: e.turnId, turnStartedAt: now }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const c = await read($, chat)
    if (c.turnId === e.turnId) await update($, chat, x => ({ ...x, turnId: undefined, turnStartedAt: undefined }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    try {
      const name = String(e.tool)
      if (!toolsSeen.includes(name)) toolsSeen = [...toolsSeen, name].slice(-10)
    } catch {
      // 記録に失敗してもツール呼び出しは止めない
    }
    return next(e)
  })

  on('command.run', { command: 'side-chat' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await setEnabled($, false)
      return { text: '雑談を止めました。/side-chat on で再開します。' }
    }
    if (arg === 'on') await setEnabled($, true)
    await openPane($, true)
    const c = await read($, chat)
    if (c.isBlocked) return { text: '除外設定されたフォルダーの作業なので、このセッションでは雑談を送りません。' }
    return { text: arg === 'on' ? '雑談を再開しました。' : 'パネルを開きました。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e) as any
    const c = await read($, chat)
    const all = await read($, lines)
    const now = await $.clock.now()
    const room = e.surface === 'terminal' ? Math.max(4, Math.floor(((e.viewport?.rows ?? 30) - 6) / 2)) : 40
    const shown = all.slice(-room)

    const state = c.isBlocked
      ? '除外設定されたフォルダーの作業なので送らない'
      : !c.isEnabled
        ? '停止中'
        : c.busy
          ? `${NAME[c.busy]} が考え中…`
          : c.turnId
            ? `Claude 考え中 ${fmtWait(now - (c.turnStartedAt ?? now))}`
            : '待機中（Claude が考え始めたら話します）'

    let lastTurn = ''
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{state}</Text>
          {c.error ? <Text color="red">{c.error}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button
              key="toggle"
              label={c.isEnabled ? '止める' : '再開'}
              onPress={() => void setEnabled($, !c.isEnabled)}
            />
            <Button key="clear" label="消す" onPress={() => void update($, lines, () => [])} />
          </Box>
        </Box>
        {shown.length === 0 ? <Text dimColor>まだ誰も話していません。</Text> : null}
        <Box flexDirection="column">
          {shown.map(l => {
            const sep = lastTurn && l.turnId !== lastTurn
            lastTurn = l.turnId
            return (
              <Box key={l.id} flexDirection="column" marginTop={sep ? 1 : 0}>
                <Text>
                  <Text bold color={l.who === 'dots' ? 'cyan' : 'magenta'}>
                    {NAME[l.who]}
                  </Text>
                  <Text> {l.text}</Text>
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
