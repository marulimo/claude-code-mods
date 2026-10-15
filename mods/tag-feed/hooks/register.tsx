import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Feed, Post } from '../types'

const PANE = 'tag-feed'
const posts = atom({ plugin: 'tag-feed', key: 'posts' } as const, [] as Post[])
const feed = atom({ plugin: 'tag-feed', key: 'feed' } as const, {
  tags: [],
  isPaused: false,
  isFetching: false,
} as Feed)

const MAX_POSTS = 300
const MAX_SEEN = 3000

type Config = { python: string; pythonVersion: string; model: string; intervalMs: number }

// 投稿URLから status id を拾う。x.com/i/status/ の形も来る
const STATUS_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]+|i(?:\/web)?)\/status\/(\d{6,25})/g

export function normalizeTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,、]+/)
        .map(s => s.replace(/^[#＃]/, '').trim())
        .filter(Boolean),
    ),
  ]
}

export function extractIds(text: string): string[] {
  return [...new Set([...text.matchAll(STATUS_RE)].map(m => m[1] ?? ''))].filter(Boolean)
}

// 埋め込み(publish/syndication)と同じ計算。id は数値の近似で足りる
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

// Grok は関係ない投稿を混ぜることがあるので、本文かハッシュタグ欄にタグがあるものだけ通す
export function hasTag(text: string, hashtags: string[], tags: string[]): boolean {
  const lower = text.toLowerCase()
  const own = hashtags.map(h => h.toLowerCase())
  return tags.some(t => {
    const k = t.toLowerCase()
    return own.includes(k) || lower.includes(`#${k}`) || lower.includes(`＃${k}`)
  })
}

export function parseTweet(id: string, body: string): (Post & { hashtags: string[] }) | undefined {
  let j: any
  try {
    j = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!j || j.__typename === 'TweetTombstone' || !j.user || typeof j.text !== 'string') return undefined
  const handle = String(j.user.screen_name ?? '')
  return {
    id,
    handle,
    name: String(j.user.name ?? handle),
    text: decodeEntities(j.text),
    time: String(j.created_at ?? ''),
    url: `https://x.com/${handle || 'i'}/status/${id}`,
    hashtags: (j.entities?.hashtags ?? []).map((h: any) => String(h.text ?? '')),
  }
}

function grokPrompt(tags: string[]): string {
  const q = tags.map(t => `#${t}`).join(' または ')
  return (
    `Xで、ハッシュタグ ${q} が付いた投稿を検索してください。` +
    'できるだけ新しい投稿から順に、最大20件。' +
    '出力は投稿URL（https://x.com/ユーザー名/status/数字 の形）だけを1行に1つ並べてください。' +
    '説明・要約・本文・前置きは不要です。'
  )
}

async function askGrok($: EngineInterface, cfg: Config, tags: string[]): Promise<string> {
  const code =
    'import sys\n' +
    'from hermes_cli.main import main\n' +
    `sys.argv=['hermes','-z',sys.argv[1],'-m',sys.argv[2],'--provider','xai-oauth']\n` +
    'main()\n'
  const argv = [
    cfg.python,
    ...(cfg.pythonVersion ? [cfg.pythonVersion] : []),
    '-c',
    code,
    grokPrompt(tags),
    cfg.model,
  ]
  const r = await $.process.run(argv, {
    timeoutMs: 5 * 60_000,
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  if (r.exitCode !== 0) throw new Error(`hermes exit ${r.exitCode}: ${r.stderr.slice(-400)}`)
  return r.stdout
}

async function fetchTweet($: EngineInterface, id: string) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ja&token=${syndicationToken(id)}`
  try {
    const res = await $.http.fetch(url)
    return res.ok ? parseTweet(id, res.text) : undefined
  } catch {
    return undefined
  }
}

function patchFeed($: EngineInterface, fields: Partial<Feed>) {
  return update($, feed, f => ({ ...f, ...fields }))
}

async function loadSeen($: EngineInterface): Promise<string[]> {
  const v = await $.store.get('seen')
  return Array.isArray(v) ? (v as string[]) : []
}

export async function runOnce($: EngineInterface, cfg: Config) {
  const now = await read($, feed)
  if (now.isFetching || now.tags.length === 0) return
  await patchFeed($, { isFetching: true, error: undefined })
  try {
    const tags = now.tags
    const out = await askGrok($, cfg, tags)
    const seen = await loadSeen($)
    const seenSet = new Set(seen)
    const fresh = extractIds(out).filter(id => !seenSet.has(id))

    const got = await Promise.all(fresh.map(id => fetchTweet($, id)))
    const kept: Post[] = []
    let dropped = 0
    got.forEach(p => {
      if (p && hasTag(p.text, p.hashtags, tags)) {
        const { hashtags: _h, ...post } = p
        kept.push(post)
      } else {
        dropped++
      }
    })
    kept.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))

    // 取れなかったものも seen に入れ、毎回 Grok が返す同じURLで枠を使い直さない
    await $.store.set('seen', [...fresh, ...seen].slice(0, MAX_SEEN))
    if (kept.length) {
      await update($, posts, list => {
        const merged = [...kept, ...list.filter(x => !kept.some(k => k.id === x.id))]
        merged.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
        return merged.slice(0, MAX_POSTS)
      })
      await $.store.set('posts', (await read($, posts)).slice(0, 100))
    }
    await patchFeed($, { lastRunAt: await $.clock.now(), lastAdded: kept.length, lastDropped: dropped })
    $.ui.status(kept.length ? `#${tags[0]} 新着${kept.length}件` : undefined)
  } catch (err) {
    await patchFeed($, { lastRunAt: await $.clock.now(), error: String(err).slice(0, 500) })
  } finally {
    await patchFeed($, { isFetching: false })
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const jst = new Date(d.getTime() + 9 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(jst.getUTCMonth() + 1)}/${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
}

let timer: Timer | undefined

async function setTags($: EngineInterface, cfg: Config, raw: string) {
  const tags = normalizeTags(raw)
  await $.store.set('tags', tags)
  await $.store.set('seen', [])
  await update($, posts, () => [])
  await $.store.set('posts', [])
  await patchFeed($, { tags, error: undefined, lastAdded: undefined, lastDropped: undefined })
  if (tags.length) void runOnce($, cfg)
  return tags
}

async function togglePause($: EngineInterface) {
  const f = await read($, feed)
  await patchFeed($, { isPaused: !f.isPaused })
  await $.store.set('paused', !f.isPaused)
}

export const register: Register = (on, options) => {
  const minutes = Math.max(2, Number(options.intervalMinutes) || 10)
  const cfg: Config = {
    python: String(options.python || 'py'),
    pythonVersion: String(options.pythonVersion ?? ''),
    model: String(options.model || 'grok-4.3'),
    intervalMs: minutes * 60_000,
  }
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tag-feed',
      description: 'Xのハッシュタグの新着をパネルに流す。引数でタグを指定（例: /tag-feed #ClaudeCode）',
      argumentHint: '[#タグ ...]',
    })
    const storedTags = await $.store.get('tags')
    const storedPosts = await $.store.get('posts')
    const paused = (await $.store.get('paused')) === true
    const tags = Array.isArray(storedTags) ? (storedTags as string[]) : []
    if (Array.isArray(storedPosts)) await update($, posts, () => storedPosts as Post[])
    await patchFeed($, { tags, isPaused: paused, isFetching: false })

    timer?.cancel()
    timer = $.clock.every(cfg.intervalMs, () => {
      void (async () => {
        const f = await read($, feed)
        if (!f.isPaused) await runOnce($, cfg)
      })()
    })
    if (tags.length && !paused) {
      void $.ui.open({ id: PANE, title: `#${tags.join(' #')}` })
      void runOnce($, cfg)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    return next(e)
  })

  on('command.run', { command: 'tag-feed' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg) {
      const tags = await setTags($, cfg, arg)
      await $.ui.open({ id: PANE, title: `#${tags.join(' #')}`, focus: true })
      return { text: `#${tags.join(' #')} を${minutes}分おきに取りに行きます。最初の取得は1〜2分かかります。` }
    }
    const f = await read($, feed)
    await $.ui.open({ id: PANE, title: f.tags.length ? `#${f.tags.join(' #')}` : 'タグフィード', focus: true })
    return { text: f.tags.length ? 'パネルを開きました。' : 'パネルを開きました。タグを入力してください。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button, Input, Link } = ui
    const list = await read($, posts)
    const f = await read($, feed)
    const now = await $.clock.now()
    const ago = f.lastRunAt ? Math.round((now - f.lastRunAt) / 60_000) : undefined
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 40) - 8) / 4))
    const shown = e.surface === 'terminal' ? list.slice(0, room) : list.slice(0, 100)

    const state = f.isFetching
      ? 'Grokで検索中…'
      : f.isPaused
        ? '停止中'
        : f.tags.length
          ? `${minutes}分おきに取得${ago !== undefined ? `（前回 ${ago}分前・新着${f.lastAdded ?? 0}件${f.lastDropped ? `・除外${f.lastDropped}件` : ''}）` : ''}`
          : 'タグ未設定'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{f.tags.length ? `#${f.tags.join(' #')}` : 'タグ未設定'}</Text>
          <Text dimColor>{state}</Text>
          {f.error ? <Text color="red">取得エラー: {f.error}</Text> : null}
          {Input ? (
            <Input
              key="tags"
              label="タグ >"
              placeholder="#ClaudeCode など（空白区切りで複数）"
              submitLabel="切り替え"
              value=""
              onSubmit={(v: string) => {
                if (v.trim()) {
                  void setTags($, cfg, v).then(t => $.ui.open({ id: PANE, title: `#${t.join(' #')}` }))
                }
              }}
            />
          ) : (
            <Text dimColor>タグは /tag-feed #タグ で切り替え</Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Button
              key="now"
              label="今すぐ取得"
              variant="primary"
              onPress={() => void runOnce($, cfg)}
            />
            <Button key="pause" label={f.isPaused ? '再開' : '止める'} onPress={() => togglePause($)} />
          </Box>
        </Box>
        {shown.length === 0 && f.tags.length > 0 ? (
          <Text dimColor>{f.isFetching ? '最初の取得中です（1〜2分）' : 'まだ投稿がありません。'}</Text>
        ) : null}
        {shown.map(p => (
          <Box key={p.id} flexDirection="column">
            <Text>
              <Text bold>{p.name}</Text>
              <Text dimColor>
                {' '}@{p.handle} {fmtTime(p.time)}
              </Text>
            </Text>
            <Text>{p.text}</Text>
            {Link ? <Link key={`l-${p.id}`} href={p.url} label="Xで開く" /> : <Text dimColor>{p.url}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
