import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mention, Mentions } from '../types'

const PANE = 'x-post'
const TAGS_KEY = 'hashtags'
const GATE_KEY = 'gated'
const ACCOUNT_KEY = 'account'
// /x-account で別のアカウントを登録するまではこれを使う
const DEFAULT_ACCOUNT = ''

const isThinking = atom({ plugin: 'x-post', key: 'isThinking' } as const, false)
const isGated = atom({ plugin: 'x-post', key: 'isGated' } as const, false)
const tags = atom({ plugin: 'x-post', key: 'tags' } as const, [])
const account = atom({ plugin: 'x-post', key: 'account' } as const, '')
const mentions = atom({ plugin: 'x-post', key: 'mentions' } as const, { status: 'idle', items: [] })
const draft = atom({ plugin: 'x-post', key: 'draft' } as const, '')
const replyTo = atom({ plugin: 'x-post', key: 'replyTo' } as const, '')
const lastResult = atom({ plugin: 'x-post', key: 'lastResult' } as const, '')

const USAGE_TAG = [
  '/x-tag            登録済みの一覧',
  '/x-tag add 朝活 AI  登録（# はあってもなくてもよい）',
  '/x-tag rm 朝活      削除',
  '/x-tag clear       全部削除',
].join('\n')

// "#朝活" "＃朝活" "朝活" を同じ "朝活" にそろえる。空白や記号だけのものは捨てる
export const normalizeTag = (raw: string): string | undefined => {
  const tag = raw.trim().replace(/^[#＃]+/, '')
  if (!tag || /[\s#＃]/.test(tag)) return undefined

  return tag
}

export const normalizeAccount = (raw: string): string | undefined => {
  const handle = raw.trim().replace(/^[@＠]/, '')

  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined
}

// 本文にすでに書いてあるタグは二重に足さない
export const composeText = (body: string, list: readonly string[]): string => {
  const missing = list.filter(tag => !body.includes(`#${tag}`) && !body.includes(`＃${tag}`))
  if (missing.length === 0) return body

  return `${body}\n\n${missing.map(tag => `#${tag}`).join(' ')}`
}

export const intentUrl = (text: string, replyTo?: string): string =>
  `https://x.com/intent/post?${replyTo ? `in_reply_to=${replyTo}&` : ''}text=${encodeURIComponent(text)}`

export const statusId = (url: string): string | undefined =>
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/.exec(url.trim())?.[1]

// hermes の返答から、投稿URLで裏付けられた行だけを拾う
export const parseMentions = (out: string): Mention[] =>
  out
    .split(/\r?\n/)
    .map(line => {
      const url = /https:\/\/(?:x|twitter)\.com\/\S+?\/status\/\d+/.exec(line)?.[0]
      if (!url) return undefined
      const text = line
        .replace(url, '')
        .replace(/[【】|｜]/g, ' ')
        .replace(/^[\s\-*・\d.]+/, '')
        .replace(/\s+/g, ' ')
        .trim()

      return { text: text || '(本文なし)', url }
    })
    .filter((m): m is Mention => !!m)
    .slice(0, 20)

const readList = async ($: EngineInterface): Promise<string[]> => {
  const value = await $.store.get(TAGS_KEY)

  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

const saveTags = async ($: EngineInterface, list: string[]) => {
  await $.store.set(TAGS_KEY, list)
  await update($, tags, () => list)
}

const tagLine = (list: readonly string[]) => list.map(t => `#${t}`).join(' ')

// 推論中だけモードで、いまは投稿させないときの断り文。投稿してよいなら undefined
const gateRefusal = async ($: EngineInterface): Promise<string | undefined> => {
  if (!(await read($, isGated))) return undefined
  if (await read($, isThinking)) return undefined

  return '推論中だけ投稿できるモードです。Claude が考えている間に打ってください（解除は /x-mode off）。'
}

const openIntent = async ($: EngineInterface, url: string): Promise<boolean> => {
  // 投稿画面を開くだけで、投稿はしない
  try {
    const { exitCode } = await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url])

    return exitCode === 0
  } catch {
    return false
  }
}

const composeReply = (opened: boolean, text: string, url: string) =>
  [
    opened ? 'Xの投稿画面を開きました。内容を確かめて「ポスト」を押してください。' : '下のリンクからXの投稿画面を開いてください。',
    '',
    text,
    '',
    url,
  ].join('\n')

type PostOutcome = { isOpened: boolean; message: string; url?: string }

// コマンドとペインの入力欄が共通で使う。replyTo はポストのURL
const openPost = async ($: EngineInterface, body: string, replyTo?: string): Promise<PostOutcome> => {
  const refusal = await gateRefusal($)
  if (refusal) return { isOpened: false, message: refusal }
  if (!body.trim()) return { isOpened: false, message: '本文が空です。' }

  let id: string | undefined
  if (replyTo?.trim()) {
    id = statusId(replyTo)
    if (!id) return { isOpened: false, message: '返信先がポストのURL（…/status/数字）になっていません。' }
  }

  const text = composeText(body.trim(), await readList($))
  const url = intentUrl(text, id)
  const isOpened = await openIntent($, url)

  return { isOpened, url, message: composeReply(isOpened, text, url) }
}

const fetchMentions = async ($: EngineInterface) => {
  const handle = await read($, account)
  if (!handle) {
    await update($, mentions, m => ({ ...m, status: 'error' as const, note: '先に /x-account @名前 で自分のアカウントを登録してください。' }))
    return
  }
  await update($, mentions, m => ({ ...m, status: 'loading' as const, note: undefined }))

  const prompt =
    `Xで『@${handle} 宛てのリプライやメンション（to:${handle} または @${handle} を含む投稿、直近3日）』を検索し、` +
    'ヒットした投稿を1件1行で【@投稿者ハンドル | 投稿日時 | 本文 | 投稿URL】の形式でリスト化して。' +
    'あなた自身の要約・一般知識は加えず、実際の検索結果の投稿データだけを出して'
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['hermes', '-z', prompt, '-m', 'grok-4.3', '--provider', 'xai-oauth'],
      { timeoutMs: 240_000 },
    )
    const checkedAt = new Date(await $.clock.now()).toLocaleString('ja-JP')
    if (exitCode !== 0) {
      await update($, mentions, m => ({ ...m, status: 'error' as const, checkedAt, note: `hermes が失敗しました: ${(stderr || stdout).slice(0, 200)}` }))
      return
    }
    const items = parseMentions(stdout)
    await update($, mentions, () => ({
      status: 'done' as const,
      items,
      checkedAt,
      note: items.length ? undefined : '投稿URLつきの結果はありませんでした。',
    }))
    if (items.length) $.ui.toast(`Xのメンション ${items.length} 件`)
  } catch (err) {
    await update($, mentions, m => ({ ...m, status: 'error' as const, note: `hermes を起動できませんでした: ${String(err).slice(0, 200)}` }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const commands = [
      { name: 'x', description: '本文に登録ハッシュタグを付けてXの投稿画面を開く（投稿ボタンは自分で押す）', argumentHint: '本文' },
      { name: 'x-reply', description: '指定したポストへの返信画面を開く', argumentHint: 'ポストのURL 本文' },
      { name: 'x-tag', description: '/x で自動で付けるハッシュタグを登録・削除する', argumentHint: 'add|rm|clear タグ' },
      { name: 'x-mode', description: '推論中だけ投稿できるモードを切り替える', argumentHint: 'on|off' },
      { name: 'x-account', description: 'メンションを探す自分のXアカウントを登録する', argumentHint: '@名前' },
      { name: 'x-pane', description: 'Xのペインを右側に開く' },
    ]
    for (const command of commands) {
      // 推論中にも打てるよう、ターンの終わりを待たずに走らせる
      await $.command.register({ ...command, immediate: true })
    }

    const saved = await readList($)
    await update($, tags, () => saved)
    const gated = (await $.store.get(GATE_KEY)) === true
    await update($, isGated, () => gated)
    const handle = await $.store.get(ACCOUNT_KEY)
    await update($, account, () => (typeof handle === 'string' ? handle : DEFAULT_ACCOUNT))

    void $.ui.open({ id: PANE, title: 'X' })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, isThinking, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isThinking, () => false)

    return next(e)
  })

  on('command.run', { command: 'x-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'X' })

    return { text: 'Xのペインを開きました。' }
  })

  on('command.run', { command: 'x-mode' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== 'on' && arg !== 'off') {
      const gated = await read($, isGated)
      return { text: `推論中だけモード: ${gated ? 'オン' : 'オフ'}（切り替えは /x-mode on か /x-mode off）` }
    }
    const gated = arg === 'on'
    await $.store.set(GATE_KEY, gated)
    await update($, isGated, () => gated)

    return {
      text: gated
        ? '推論中だけ投稿できるモードをオンにしました。Claude が考えている間だけ /x と /x-reply が使えます。'
        : '推論中だけモードをオフにしました。いつでも投稿画面を開けます。',
    }
  })

  on('command.run', { command: 'x-account' }, async ($, e) => {
    const handle = normalizeAccount(e.args)
    if (!handle) {
      const current = await read($, account)
      return { text: current ? `登録中のアカウント: @${current}` : '使い方: /x-account @名前' }
    }
    await $.store.set(ACCOUNT_KEY, handle)
    await update($, account, () => handle)

    return { text: `@${handle} を登録しました。ペインの「更新」でメンションを探します。` }
  })

  on('command.run', { command: 'x-tag' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const list = await readList($)

    if (sub === '') {
      return { text: list.length ? `登録中のハッシュタグ: ${tagLine(list)}` : `登録中のハッシュタグはありません。\n${USAGE_TAG}` }
    }

    if (sub === 'add') {
      const added = rest.map(normalizeTag).filter((t): t is string => !!t)
      if (added.length === 0) return { text: `追加するタグを指定してください。\n${USAGE_TAG}` }
      const next = [...new Set([...list, ...added])]
      await saveTags($, next)

      return { text: `登録しました。現在: ${tagLine(next)}` }
    }

    if (sub === 'rm') {
      const removing = new Set(rest.map(normalizeTag).filter((t): t is string => !!t))
      const next = list.filter(t => !removing.has(t))
      await saveTags($, next)

      return { text: next.length ? `削除しました。現在: ${tagLine(next)}` : '削除しました。登録中のハッシュタグはありません。' }
    }

    if (sub === 'clear') {
      await saveTags($, [])

      return { text: 'ハッシュタグを全部削除しました。' }
    }

    return { text: USAGE_TAG }
  })

  on('command.run', { command: 'x' }, async ($, e) => {
    if (!e.args.trim()) return { text: '使い方: /x 投稿したい本文' }

    return { text: (await openPost($, e.args)).message }
  })

  on('command.run', { command: 'x-reply' }, async ($, e) => {
    const [target = '', ...words] = e.args.trim().split(/\s+/)
    const body = words.join(' ')
    if (!statusId(target) || !body.trim()) return { text: '使い方: /x-reply https://x.com/名前/status/123… 返信の本文' }

    return { text: (await openPost($, body, target)).message }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Link } = table
    const Input = 'Input' in table ? table.Input : undefined
    const gated = await read($, isGated)
    const thinking = await read($, isThinking)
    const list = await read($, tags)
    const handle = await read($, account)
    const m: Mentions = await read($, mentions)
    const body = await read($, draft)
    const target = await read($, replyTo)
    const result = await read($, lastResult)
    const isBlocked = gated && !thinking

    const modeLine = !gated
      ? '投稿: いつでも可'
      : thinking
        ? '投稿: 可（推論中）'
        : '投稿: 不可（推論中だけモード・待機中）'

    const submit = async (value: string) => {
      const outcome = await openPost($, value, await read($, replyTo))
      await update($, lastResult, () =>
        outcome.url ? (outcome.isOpened ? '投稿画面を開きました。ブラウザで「ポスト」を押してください。' : 'ブラウザを開けませんでした。/x で出るリンクから開いてください。') : outcome.message,
      )
      if (outcome.url) {
        await update($, draft, () => '')
        await update($, replyTo, () => '')
      }
    }

    return (
      <Box flexDirection="column">
        <Text bold>投稿</Text>
        <Text color={isBlocked ? 'red' : 'green'}>{modeLine}</Text>
        {Input ? (
          <Box flexDirection="column">
            <Input
              key="body"
              label="本文 "
              placeholder={isBlocked ? 'Claude が考えている間だけ書けます' : 'ここに書いて Enter で投稿画面を開く'}
              value={body}
              submitLabel="投稿画面へ"
              onInput={value => void update($, draft, () => value)}
              onSubmit={value => void submit(value)}
            />
            <Input
              key="replyTo"
              label="返信先 "
              placeholder="返信するときだけポストのURL"
              value={target}
              submitLabel="決定"
              onInput={value => void update($, replyTo, () => value)}
              onSubmit={value => void update($, replyTo, () => value)}
            />
          </Box>
        ) : (
          <Text dimColor>この画面では入力欄が使えません。/x 本文 で投稿してください。</Text>
        )}
        {result && <Text dimColor>{result}</Text>}
        <Box flexDirection="row">
          <Button
            key="mode"
            label={gated ? '推論中だけ: オン' : '推論中だけ: オフ'}
            onPress={async () => {
              const nextGated = !(await read($, isGated))
              await $.store.set(GATE_KEY, nextGated)
              await update($, isGated, () => nextGated)
            }}
          />
        </Box>
        <Text> </Text>
        <Text bold>ハッシュタグ</Text>
        <Text dimColor={list.length === 0}>{list.length ? tagLine(list) : 'なし（/x-tag add で登録）'}</Text>
        <Text> </Text>
        <Text bold>メンション{handle ? `（@${handle}）` : '（/x-account @名前 で設定）'}</Text>
        <Box flexDirection="row">
          <Button
            key="refresh"
            label={m.status === 'loading' ? '探しています…' : '更新'}
            onPress={() => (m.status === 'loading' ? undefined : fetchMentions($))}
          />
          {m.checkedAt && <Text dimColor> {m.checkedAt}</Text>}
        </Box>
        {m.note && <Text dimColor>{m.note}</Text>}
        {m.items.map((item, i) => (
          <Box key={`m${i}`} flexDirection="column">
            <Text>{item.text}</Text>
            <Link href={item.url} label="開く" />
          </Box>
        ))}
      </Box>
    )
  })
}
