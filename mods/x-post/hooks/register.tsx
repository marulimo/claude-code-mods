import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mention, Mentions } from '../types'

const PANE = 'x-post'
// 横に並ぶときは columns、プロンプトの上に出るときは rows が効く。手で広げた大きさのほうが優先される
const PANE_OPEN = { id: PANE, title: 'X', columns: 100, rows: 40 }
const TAGS_KEY = 'hashtags'
const GATE_KEY = 'gated'
const ACCOUNT_KEY = 'account'
const MAX_TAGS = 10
const MAX_TAG_LENGTH = 50
const MAX_WEIGHT = 280

const isThinking = atom({ plugin: 'x-post', key: 'isThinking' } as const, false)
const isGated = atom({ plugin: 'x-post', key: 'isGated' } as const, false)
const tags = atom({ plugin: 'x-post', key: 'tags' } as const, [])
const account = atom({ plugin: 'x-post', key: 'account' } as const, '')
const mentions = atom({ plugin: 'x-post', key: 'mentions' } as const, { status: 'idle', items: [] })
const draft = atom({ plugin: 'x-post', key: 'draft' } as const, '')
const replyTo = atom({ plugin: 'x-post', key: 'replyTo' } as const, '')
const lastResult = atom({ plugin: 'x-post', key: 'lastResult' } as const, '')
const tagDraft = atom({ plugin: 'x-post', key: 'tagDraft' } as const, '')
const tagNote = atom({ plugin: 'x-post', key: 'tagNote' } as const, '')

const USAGE_TAG = [
  '/x-tag            登録済みの一覧',
  '/x-tag add 朝活 AI  登録（# はあってもなくてもよい）',
  '/x-tag rm 朝活      削除',
  '/x-tag clear       全部削除',
].join('\n')

// "#朝活" "＃朝活" "朝活" を同じ "朝活" にそろえる。空白や記号だけのものは捨てる
export const normalizeTag = (raw: string): string | undefined => {
  const tag = raw.trim().replace(/^[#＃]+/, '')
  if (!tag || /[\s#＃]/.test(tag) || tag.length > MAX_TAG_LENGTH) return undefined

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

export const postWeight = (text: string): number => {
  let weight = 0
  const rest = text.replace(/https?:\/\/\S+/g, () => {
    weight += 23
    return ''
  })
  for (const ch of rest) {
    const c = ch.codePointAt(0) ?? 0
    const isNarrow =
      c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)
    weight += isNarrow ? 1 : 2
  }

  return weight
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

// /x-tag add とペインの欄が共通で使う。返り値は結果の一文
const addTags = async ($: EngineInterface, words: readonly string[]): Promise<string> => {
  const added = words.map(normalizeTag).filter((t): t is string => !!t)
  if (added.length === 0) return `タグにできる文字がありません（空白と # は使えず、${MAX_TAG_LENGTH}文字まで）。`
  const next = [...new Set([...(await readList($)), ...added])]
  if (next.length > MAX_TAGS) return `ハッシュタグは ${MAX_TAGS} 個までです。減らしてから足してください。`
  await saveTags($, next)

  return `登録しました。現在: ${tagLine(next)}`
}

const removeTags = async ($: EngineInterface, words: readonly string[]): Promise<string> => {
  const removing = new Set(words.map(normalizeTag).filter((t): t is string => !!t))
  const next = (await readList($)).filter(t => !removing.has(t))
  await saveTags($, next)

  return next.length ? `削除しました。現在: ${tagLine(next)}` : '削除しました。登録中のハッシュタグはありません。'
}

// 推論中だけモードで、いまは投稿させないときの断り文。投稿してよいなら undefined
const gateRefusal = async ($: EngineInterface): Promise<string | undefined> => {
  if (!(await read($, isGated))) return undefined
  if (await read($, isThinking)) return undefined

  return '推論中だけ投稿できるモードです。Claude が考えている間に打ってください（解除は /x-mode off）。'
}

// URL をいつものブラウザで開くコマンド。Windows、macOS、それ以外(xdg-open)の順に判定する
const openerFor = async ($: EngineInterface): Promise<string[]> => {
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') return ['rundll32', 'url.dll,FileProtocolHandler']
  } catch {
    // 環境変数が読めなければ uname で判定する
  }
  try {
    const { stdout } = await $.process.run(['uname', '-s'])
    if (stdout.trim() === 'Darwin') return ['open']
  } catch {
    // uname が無ければ xdg-open に任せる
  }

  return ['xdg-open']
}

const openIntent = async ($: EngineInterface, url: string): Promise<boolean> => {
  // 投稿画面を開くだけで、投稿はしない
  try {
    const { exitCode } = await $.process.run([...(await openerFor($)), url])

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
  const weight = postWeight(text)
  if (weight > MAX_WEIGHT) {
    return { isOpened: false, message: `長すぎます（${weight}/${MAX_WEIGHT}。日本語は1文字2と数えます）。` }
  }
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
      [
        'hermes',
        '-z',
        prompt,
        '-m',
        (await $.env.get('X_POST_HERMES_MODEL')) || 'grok-4.3',
        '--provider',
        (await $.env.get('X_POST_HERMES_PROVIDER')) || 'xai-oauth',
      ],
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
    await update($, mentions, m => ({
      ...m,
      status: 'error' as const,
      note: `メンション検索には hermes（Grok の X 検索）が要ります。README を見てください。（${String(err).slice(0, 120)}）`,
    }))
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
    await update($, account, () => (typeof handle === 'string' ? handle : ''))

    void $.ui.open(PANE_OPEN)

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
    const opened = await $.ui.open(PANE_OPEN)
    if (opened.isPlaced) return { text: 'Xのペインを開きました。' }

    // 開いたが、どの画面にも描かれていないとき
    return { text: `Xのペインは開きましたが、この画面には表示されていません。理由: ${opened.reason}` }
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
      if (rest.length === 0) return { text: `追加するタグを指定してください。
${USAGE_TAG}` }
      return { text: await addTags($, rest) }
    }

    if (sub === 'rm') return { text: await removeTags($, rest) }

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
    const tagText = await read($, tagDraft)
    const tagNoteText = await read($, tagNote)
    const isBlocked = gated && !thinking

    // 表示幅は30文字前後しか取れないので、どの行も短くする
    const modeLine = !gated ? 'いつでも投稿できます' : thinking ? '推論中: 投稿できます' : '待機中: 投稿できません'

    const submit = async (value: string) => {
      const outcome = await openPost($, value, await read($, replyTo))
      await update($, lastResult, () =>
        outcome.url ? (outcome.isOpened ? '投稿画面を開きました' : 'ブラウザを開けませんでした') : outcome.message,
      )
      if (outcome.url) {
        await update($, draft, () => '')
        await update($, replyTo, () => '')
      }
    }

    // 投稿欄はペインの下端に寄せる。上はタグとメンション
    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold>ハッシュタグ</Text>
          {list.length === 0 && <Text dimColor>なし（下の欄で追加）</Text>}
          {list.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {list.map(tag => (
                <Button key={`tag-${tag}`} plain onPress={async () => {
                    const note = await removeTags($, [tag])
                    await update($, tagNote, () => note)
                  }}
                >
                  #{tag} <Text dimColor>×</Text>
                </Button>
              ))}
            </Box>
          )}
          {Input && (
            <Input
              key="tagAdd"
              placeholder="タグを足す（空白で複数）"
              value={tagText}
              submitLabel="追加"
              onInput={value => void update($, tagDraft, () => value)}
              onSubmit={async value => {
                const note = await addTags($, value.split(/\s+/).filter(Boolean))
                await update($, tagNote, () => note)
                if (note.startsWith('登録')) await update($, tagDraft, () => '')
              }}
            />
          )}
          {tagNoteText && <Text dimColor>{tagNoteText}</Text>}
          <Text> </Text>
          <Text bold>メンション</Text>
          <Text dimColor>{handle ? `@${handle}` : '/x-account @名前 で設定'}</Text>
          <Box flexDirection="row">
            <Button
              key="refresh"
              label={m.status === 'loading' ? '検索中…' : '更新'}
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
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold>投稿</Text>
          <Text color={isBlocked ? 'red' : 'green'}>{modeLine}</Text>
          <Box flexDirection="row">
            <Button
              key="mode"
              label={gated ? '推論中だけ オン' : '推論中だけ オフ'}
              onPress={async () => {
                const nextGated = !(await read($, isGated))
                await $.store.set(GATE_KEY, nextGated)
                await update($, isGated, () => nextGated)
              }}
            />
          </Box>
          {body.trim() && (
            <Box flexDirection="column">
              <Text dimColor color={postWeight(composeText(body.trim(), list)) > MAX_WEIGHT ? 'red' : undefined}>
                プレビュー {postWeight(composeText(body.trim(), list))}/{MAX_WEIGHT}
              </Text>
              <Text wrap="wrap">{composeText(body.trim(), list)}</Text>
            </Box>
          )}
          {result && <Text dimColor>{result}</Text>}
          {Input ? (
            <Box flexDirection="column">
              <Text dimColor>返信先（返信のときだけ）</Text>
              <Input
                key="replyTo"
                placeholder="ポストのURL"
                value={target}
                submitLabel="決定"
                onInput={value => void update($, replyTo, () => value)}
                onSubmit={value => void update($, replyTo, () => value)}
              />
              <Text dimColor>本文（Enterで投稿画面へ）</Text>
              <Input
                key="body"
                placeholder={isBlocked ? '考えている間だけ書けます' : 'ここに書く'}
                value={body}
                submitLabel="投稿画面へ"
                onInput={value => void update($, draft, () => value)}
                onSubmit={value => void submit(value)}
              />
            </Box>
          ) : (
            <Text dimColor>入力欄なし。/x 本文 で投稿</Text>
          )}
        </Box>
      </Box>
    )
  })
}
