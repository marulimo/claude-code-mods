import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Feed, Media, Post } from '../types'

const PANE = 'tag-feed'
const posts = atom({ plugin: 'tag-feed', key: 'posts' } as const, [] as Post[])
const feed = atom({ plugin: 'tag-feed', key: 'feed' } as const, {
  tags: [],
  isPaused: false,
  isFetching: false,
} as Feed)
// 縮小画像(base64 JPEG)。URL→中身。新しい投稿の分だけ持つ
const thumbs = atom({ plugin: 'tag-feed', key: 'thumbs' } as const, {} as Record<string, string>)

const MAX_POSTS = 300
const MAX_SEEN = 3000
const THUMB_POSTS = 40
// Svg の source は 131072 文字まで。枠と再生マークの分を残す
const MAX_THUMB_B64 = 120_000

type Config = { python: string; pythonVersion: string; model: string; intervalMs: number }
type Kind = 'timer' | 'manual' | 'probe'
type Shared = {
  lease?: { owner: string; until: number }
  lastFetchAt?: number
  blockedAt?: number
  blockedReason?: string
  probedAt?: number
}
const LEASE_MS = 10 * 60_000
const VERIFY_MS = 1500
const PROBE_AFTER_MS = 6 * 3600_000
const busyOwners = new Set<string>()
class QuotaError extends Error {}

async function sharedPath($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = config || (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) throw new Error('共有ファイルの保存先が不明なため取得しません')
  return `${home.replace(/\\/g, '/').replace(/\/$/, '')}${config ? '' : '/.claude'}/tag-feed/shared.json`
}

async function readShared($: EngineInterface, path: string): Promise<Shared> {
  if (!(await $.fs.exists(path))) return {}
  const s = JSON.parse(await $.fs.read(path))
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('共有ファイルが壊れているため取得しません')
  return s as Shared
}

async function changeShared($: EngineInterface, path: string, change: (s: Shared) => void) {
  const s = await readShared($, path)
  change(s)
  await $.fs.write(path, JSON.stringify(s))
  return s
}

function syncBlocked($: EngineInterface, s: Shared) {
  return patchFeed($, { blockedAt: s.blockedAt, blockedReason: s.blockedReason, probedAt: s.probedAt })
}

async function claim($: EngineInterface, cfg: Config, path: string, kind: Kind, owner: string) {
  const now = await $.clock.now()
  const s = await readShared($, path)
  if (s.lease && s.lease.until > now && s.lease.owner !== owner) return false
  if (kind === 'timer' && s.lastFetchAt !== undefined && now - s.lastFetchAt < cfg.intervalMs) return false
  if (s.blockedAt !== undefined && kind !== 'manual' && kind !== 'probe') return false
  await $.fs.write(path, JSON.stringify({ ...s, lease: { owner, until: now + LEASE_MS }, lastFetchAt: now }))
  await $.clock.sleep(VERIFY_MS)
  const verified = await readShared($, path)
  return verified.lease?.owner === owner
}

async function release($: EngineInterface, path: string, owner: string) {
  const s = await readShared($, path)
  if (s.lease?.owner === owner) {
    delete s.lease
    await $.fs.write(path, JSON.stringify(s))
  }
}

function clearBlocked(s: Shared) {
  delete s.blockedAt
  delete s.blockedReason
  delete s.probedAt
}

// owner を分けた呼び出しは atom の取得中フラグに頼らず、共有ファイルで調停する。
export async function tick($: EngineInterface, cfg: Config, kind: Kind, owner = defaultOwner, resume = false) {
  if (busyOwners.has(owner)) return
  busyOwners.add(owner)
  let path: string | undefined
  try {
    path = await sharedPath($)
    let s = await readShared($, path)
    await syncBlocked($, s)
    const f = await read($, feed)
    if (!f.tags.length || (kind === 'timer' && f.isPaused)) return
    if (resume) {
      s = await changeShared($, path, clearBlocked)
      await syncBlocked($, s)
    }
    if (s.blockedAt !== undefined) {
      if (kind !== 'timer') return
      const now = await $.clock.now()
      if (now - s.blockedAt < PROBE_AFTER_MS || (s.probedAt !== undefined && s.probedAt >= s.blockedAt)) return
      s = await changeShared($, path, latest => { latest.probedAt = now })
      await syncBlocked($, s)
      kind = 'probe'
    }
    if (await claim($, cfg, path, kind, owner)) {
      const ok = await runOnce($, cfg, owner, kind)
      if (ok && kind === 'probe') await changeShared($, path, clearBlocked)
    } else if (kind === 'timer') {
      const stored = await $.store.get('posts')
      if (Array.isArray(stored)) await update($, posts, () => stored as Post[])
    }
    await syncBlocked($, await readShared($, path))
  } catch (err) {
    await patchFeed($, { error: String(err).slice(0, 500) })
  } finally {
    try {
      if (path) await release($, path, owner)
    } catch (err) {
      await patchFeed($, { error: String(err).slice(0, 500) })
    }
    busyOwners.delete(owner)
  }
}

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
    media: parseMedia(j.mediaDetails),
  }
}

// pbs.twimg.com は ?format=jpg&name=360x360 で縮小版を返す（1枚7〜21KB）
export function parseMedia(details: unknown): Media[] | undefined {
  if (!Array.isArray(details)) return undefined
  const media = details
    .map((m: any): Media | undefined => {
      const u = String(m?.media_url_https ?? '')
      if (!u.startsWith('https://pbs.twimg.com/')) return undefined
      const kind = m.type === 'video' ? 'video' : m.type === 'animated_gif' ? 'gif' : 'photo'
      return {
        kind,
        thumb: `${u.replace(/\.(jpe?g|png|webp)$/i, '')}?format=jpg&name=360x360`,
        w: Number(m.original_info?.width) || 16,
        h: Number(m.original_info?.height) || 9,
      }
    })
    .filter((m): m is Media => !!m)
  return media.length ? media : undefined
}

const THUMB_SCRIPT = [
  'import sys,json,base64,urllib.request',
  'out={}',
  'for u in json.load(sys.stdin):',
  '  try:',
  "    r=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=20)",
  '    out[u]=base64.b64encode(r.read()).decode()',
  '  except Exception:',
  '    pass',
  'print(json.dumps(out))',
].join('\n')

// http.fetch は本文を文字列でしか返さないので、画像は Python で base64 にして受け取る
async function loadThumbs($: EngineInterface, cfg: Config) {
  const list = (await read($, posts)).slice(0, THUMB_POSTS)
  const wanted = list.flatMap(p => (p.media ?? []).map(m => m.thumb))
  const have = await read($, thumbs)
  const missing = wanted.filter(u => !(u in have))
  let got: Record<string, string> = {}
  if (missing.length) {
    try {
      const r = await $.process.run(
        [cfg.python, ...(cfg.pythonVersion ? [cfg.pythonVersion] : []), '-c', THUMB_SCRIPT],
        { stdin: JSON.stringify(missing), timeoutMs: 120_000 },
      )
      if (r.exitCode === 0) got = JSON.parse(r.stdout || '{}')
    } catch {
      got = {}
    }
  }
  await update($, thumbs, cur => {
    const next: Record<string, string> = {}
    for (const u of wanted) {
      const v = got[u] ?? cur[u]
      if (v && v.length <= MAX_THUMB_B64) next[u] = v
    }
    return next
  })
}

export function thumbSvg(m: Media, b64: string, width: number): { source: string; width: number; height: number } {
  const ratio = m.h / m.w
  let w = width
  let h = Math.round(width * ratio)
  if (h > 360) {
    h = 360
    w = Math.round(360 / ratio)
  }
  const play =
    m.kind === 'photo'
      ? ''
      : `<circle cx="${w / 2}" cy="${h / 2}" r="22" fill="#000" fill-opacity="0.55"/>` +
        `<polygon points="${w / 2 - 7},${h / 2 - 11} ${w / 2 - 7},${h / 2 + 11} ${w / 2 + 12},${h / 2}" fill="#fff"/>`
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image href="data:image/jpeg;base64,${b64}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>` +
    play +
    '</svg>'
  return { source, width: w, height: h }
}

function mediaLabel(media: Media[]): string {
  const n = (k: Media['kind']) => media.filter(m => m.kind === k).length
  return [
    n('photo') ? `画像${n('photo')}枚` : '',
    n('video') ? `動画${n('video')}本` : '',
    n('gif') ? `GIF${n('gif')}本` : '',
  ]
    .filter(Boolean)
    .join('・')
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
    'import sys,time,json\n' +
    'from pathlib import Path\n' +
    'from hermes_constants import get_hermes_home\n' +
    'from hermes_cli.main import main\n' +
    `sys.argv=['hermes','-z',sys.argv[1],'-m',sys.argv[2],'--provider','xai-oauth']\n` +
    'started=time.time()\n' +
    'code=0\n' +
    'try:\n' +
    '  main()\n' +
    'except SystemExit as e:\n' +
    '  code=e.code\n' +
    'if code is not None and code != 0:\n' +
    '  try:\n' +
    "    dumps=(Path(get_hermes_home())/'sessions').glob('request_dump_*.json')\n" +
    '    for p in dumps:\n' +
    '      try:\n' +
    '        if p.stat().st_mtime >= started:\n' +
    "          error=json.loads(p.read_text(encoding='utf-8')).get('error')\n" +
    "          if error: print('hermes-dump: '+str(error)[:300].replace('\\n',' ').replace('\\r',' '),file=sys.stderr)\n" +
    '      except Exception:\n' +
    '        pass\n' +
    '  except Exception:\n' +
    '    pass\n' +
    'sys.exit(code)\n'
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
  const combined = `${r.stdout}\n${r.stderr}`
  if (/personal-team-blocked|spending-limit|run out of credits|(?:Error code|HTTP)[:\s]*402\b/i.test(combined)) {
    throw new QuotaError(combined.slice(0, 300))
  }
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

export async function runOnce($: EngineInterface, cfg: Config, owner?: string, kind: Kind = 'manual') {
  const now = await read($, feed)
  if ((!owner && now.isFetching) || now.tags.length === 0) return false
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
    if (kept.some(p => p.media)) await loadThumbs($, cfg)
    $.ui.status(kept.length ? `#${tags[0]} 新着${kept.length}件` : undefined)
    return true
  } catch (err) {
    if (err instanceof QuotaError) {
      const blockedAt = await $.clock.now()
      const s = await changeShared($, await sharedPath($), latest => {
        if (kind !== 'probe' || latest.blockedAt === undefined) latest.blockedAt = blockedAt
        latest.blockedReason = err.message.slice(0, 300)
      })
      await $.store.set('blockedAt', blockedAt)
      await syncBlocked($, s)
      $.ui.status('tag-feed: Grok枠切れで停止中')
    }
    await patchFeed($, { lastRunAt: await $.clock.now(), error: String(err).slice(0, 500) })
    return false
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

let defaultOwner = ''

async function setTags($: EngineInterface, cfg: Config, raw: string, owner: string) {
  const tags = normalizeTags(raw)
  await $.store.set('tags', tags)
  await $.store.set('seen', [])
  await update($, posts, () => [])
  await update($, thumbs, () => ({}))
  await $.store.set('posts', [])
  await patchFeed($, { tags, error: undefined, lastAdded: undefined, lastDropped: undefined })
  if (tags.length) void tick($, cfg, 'manual', owner)
  return tags
}

async function togglePause($: EngineInterface) {
  const f = await read($, feed)
  await patchFeed($, { isPaused: !f.isPaused })
  await $.store.set('paused', !f.isPaused)
}

export const register: Register = (on, options) => {
  const owner = `${Date.now()}-${Math.random()}`
  defaultOwner = owner
  let timer: Timer | undefined
  const minutes = Math.max(30, Number(options.intervalMinutes) || 30)
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
    const tags =
      Array.isArray(storedTags) && storedTags.length
        ? (storedTags as string[])
        : normalizeTags(String(options.tags ?? ''))
    if (Array.isArray(storedPosts)) await update($, posts, () => storedPosts as Post[])
    await patchFeed($, { tags, isPaused: paused, isFetching: false })
    try {
      await syncBlocked($, await readShared($, await sharedPath($)))
    } catch (err) {
      await patchFeed($, { error: String(err).slice(0, 500) })
    }

    // 起動時には取りに行かない。/tag-feed か使用量パネルのボタンで始める
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    return next(e)
  })

  on('command.run', { command: 'tag-feed' }, async ($, e) => {
    if (!timer) {
      timer = $.clock.every(cfg.intervalMs, () => {
        void tick($, cfg, 'timer', owner)
      })
      void loadThumbs($, cfg)
      const f = await read($, feed)
      if (!e.args.trim() && f.tags.length && !f.isPaused) void tick($, cfg, 'manual', owner)
    }
    const arg = e.args.trim()
    if (arg) {
      const tags = await setTags($, cfg, arg, owner)
      await $.ui.open({ id: PANE, title: `#${tags.join(' #')}`, focus: true })
      return { text: `#${tags.join(' #')} を${minutes}分おきに取りに行きます。最初の取得は1〜2分かかります。` }
    }
    const f = await read($, feed)
    await $.ui.open({ id: PANE, title: f.tags.length ? `#${f.tags.join(' #')}` : 'タグフィード', focus: true })
    return { text: f.tags.length ? 'パネルを開きました。' : 'パネルを開きました。タグを入力してください。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button, Input, Link, Svg } = ui
    const list = await read($, posts)
    const pics = await read($, thumbs)
    // resolve は無い要素も空の部品で埋めるので、Svg の有無は画面の種類で見る（ターミナルだけ Svg が無い）
    const canSvg = e.surface !== 'terminal'
    const f = await read($, feed)
    const now = await $.clock.now()
    const ago = f.lastRunAt ? Math.round((now - f.lastRunAt) / 60_000) : undefined
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 40) - 8) / 4))
    const shown = e.surface === 'terminal' ? list.slice(0, room) : list.slice(0, 100)

    const state = f.blockedAt !== undefined
      ? `Grok枠切れで停止中（${fmtTime(new Date(f.blockedAt).toISOString())} から）`
      : f.isFetching
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
          {f.blockedAt !== undefined ? (
            <Text dimColor>{f.probedAt !== undefined && f.probedAt >= f.blockedAt
              ? '自動では再開しません。「再開」で1回試します'
              : `6時間後（${fmtTime(new Date(f.blockedAt + PROBE_AFTER_MS).toISOString())}）に1回だけ試します`}</Text>
          ) : null}
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
                  void setTags($, cfg, v, owner).then(t => $.ui.open({ id: PANE, title: `#${t.join(' #')}` }))
                }
              }}
            />
          ) : (
            <Text dimColor>タグは /tag-feed #タグ で切り替え</Text>
          )}
          <Box flexDirection="row" gap={1}>
            {f.blockedAt !== undefined ? (
              <Button key="resume-quota" label="再開" variant="primary" onPress={() => void tick($, cfg, 'manual', owner, true)} />
            ) : <Button
              key="now"
              label="今すぐ取得"
              variant="primary"
              onPress={() => void tick($, cfg, 'manual', owner)}
            />}
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
            {p.media && canSvg ? (
              <Box flexDirection="column" gap={1}>
                {p.media.map((m, i) => {
                  const b64 = pics[m.thumb]
                  if (!b64) return <Text key={`m-${p.id}-${i}`} dimColor>画像を読み込み中</Text>
                  const svg = thumbSvg(m, b64, 300)
                  return (
                    <Svg
                      key={`m-${p.id}-${i}`}
                      source={svg.source}
                      width={svg.width}
                      height={svg.height}
                      alt={m.kind === 'photo' ? '投稿の画像' : '投稿の動画の先頭コマ'}
                    />
                  )
                })}
              </Box>
            ) : p.media ? (
              <Text dimColor>{`[${mediaLabel(p.media)}]`}</Text>
            ) : null}
            {Link ? <Link key={`l-${p.id}`} href={p.url} label="Xで開く" /> : <Text dimColor>{p.url}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
