import type { SessionUsage } from 'claude-code'
import type { UsageCard, UsagePayload, UsageRow } from '../types'

const EMPTY_CLAUDE = 'まだ数値がありません（Claude が応答すると出ます）'

// Shared pure conversions: the Node 24 collector and the Mod tests use the same code.
export function geminiRows(buckets?: { window?: string; remaining_fraction?: unknown; reset_time?: string }[]): UsageRow[] {
  return (['5h', 'weekly'] as const).map(window => {
    const bucket = buckets?.find(bucket => bucket.window === window)
    const remaining = bucket?.remaining_fraction
    const valid = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1
    return { label: window === '5h' ? '5時間' : '週次', used: valid ? Math.round((1 - remaining) * 100) : null,
      reset: bucket?.reset_time ?? null, ...(!valid ? { state: 'データなし' } : {}) }
  })
}

export function devinRows(plan?: {
  dailyQuotaRemainingPercent?: unknown; weeklyQuotaRemainingPercent?: unknown
  dailyQuotaResetAtUnix?: string; weeklyQuotaResetAtUnix?: string; planInfo?: { planName?: string }
}): UsageRow[] {
  return (['daily', 'weekly'] as const).map(window => {
    const remaining = plan?.[`${window}QuotaRemainingPercent`]
    const valid = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    const seconds = plan?.[`${window}QuotaResetAtUnix`]
    const reset = seconds ? new Date(Number(seconds) * 1000) : null
    return { label: `${window === 'daily' ? '日次' : '週次'}${plan?.planInfo?.planName ? ` · ${plan.planInfo.planName}` : ''}`,
      used: valid ? 100 - remaining : null,
      reset: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
      ...(!valid ? { state: '取得失敗' } : {}) }
  })
}

export function parseUsage(stdout: string): UsagePayload {
  const data: unknown = JSON.parse(stdout)
  if (!data || typeof data !== 'object' || !('groups' in data) || !Array.isArray(data.groups)) {
    throw new Error('Invalid usage groups')
  }
  const groups = data.groups.map((group: unknown) => {
    if (!group || typeof group !== 'object' || !('name' in group) || typeof group.name !== 'string' ||
        !('rows' in group) || !Array.isArray(group.rows)) throw new Error('Invalid usage group')
    const rows: UsageRow[] = group.rows.map((row: unknown) => {
      if (!row || typeof row !== 'object' || !('label' in row) || typeof row.label !== 'string' ||
          !('used' in row) || !(row.used === null || (typeof row.used === 'number' && Number.isFinite(row.used)))) {
        throw new Error('Invalid usage row')
      }
      return {
        label: row.label, used: row.used,
        reset: 'reset' in row && typeof row.reset === 'string' ? row.reset : null,
        state: 'state' in row && typeof row.state === 'string' ? row.state : undefined,
        ...('star' in row && row.star === true ? { star: true } : {}),
      }
    })
    return {
      name: group.name, rows,
      stale: 'stale' in group && group.stale === true,
      note: 'note' in group && typeof group.note === 'string' ? group.note : null,
    }
  })
  return { groups }
}

export function buildCards(payload: UsagePayload | null, usage: SessionUsage | null): UsageCard[] {
  const codex = payload?.groups.find(group => group.name === 'CODEX')
  const grok = payload?.groups.find(group => group.name === 'GROK')
  const claude = payload?.groups.find(group => group.name === 'CLAUDE')
  const gemini = payload?.groups.find(group => group.name === 'GEMINI')
  const devin = payload?.groups.find(group => group.name === 'DEVIN')
  let grokRows = grok?.rows ?? []
  const [first, second] = grokRows
  if (grokRows.length === 2 && first && second &&
      typeof first.used === 'number' && typeof second.used === 'number' && first.used === second.used &&
      Number.isFinite(Date.parse(first.reset ?? '')) && Date.parse(first.reset!) === Date.parse(second.reset ?? '')) {
    grokRows = [{ ...first, label: '週次 · 共有枠（Grok + Grok Bot）' }]
  }
  const claudeRows = (['five_hour', 'seven_day'] as const).map((kind): UsageRow => {
    const limit = usage?.rateLimits.find(limit => limit.kind === kind)
    const fallback = claude?.rows.find(row => kind === 'five_hour' ? row.label === '5時間' :
      row.label.startsWith('週次') && !row.star && !row.label.includes('Fable'))
    const used = limit && Number.isFinite(limit.percentUsed) ? limit.percentUsed : fallback?.used ?? null
    return {
      label: kind === 'five_hour' ? '5時間' : '週次',
      used,
      reset: limit && Number.isFinite(limit.percentUsed) ? limit.resetsAt : fallback?.reset,
      state: used === null ? fallback?.state || claude?.note || EMPTY_CLAUDE : undefined,
    }
  })
  const fable = claude?.rows.find(row => row.star || row.label.includes('Fable'))
  if (fable) claudeRows.push({ ...fable, label: '週次 · Fable' })
  const cards: UsageCard[] = [
    { name: 'Claude', color: '#d97757', rows: claudeRows, context: usage?.context.percent, note: claude?.note },
    { name: 'Codex', color: '#59c39a', rows: codex?.rows ?? [], note: codex?.note },
    { name: 'Grok', color: '#e8e8ea', rows: grokRows, note: grok?.note },
    { name: 'Gemini', color: '#4c8bf5', rows: gemini?.rows ?? [], note: gemini?.note },
    { name: 'Devin', color: '#2dd4bf', rows: devin?.rows ?? [], note: devin?.note },
  ]
  for (const card of cards.slice(1)) {
    if (card.rows.length === 0) card.rows = [{ label: '使用率', used: null, state: card.note || 'データなし' }]
  }
  return cards
}

export function retainCard(previous: UsageCard | undefined, incoming: UsageCard, failedAt?: number): UsageCard {
  if (failedAt === undefined) return incoming
  if (incoming.rows.every(row => row.used === null) && previous?.rows.some(row => row.used !== null)) {
    return { ...incoming, rows: previous.rows, context: incoming.context ?? previous.context,
      note: incoming.note || incoming.rows.find(row => row.state)?.state, failedAt }
  }
  const rows = incoming.rows.map(row => {
    if (row.used !== null) return row
    const old = previous?.rows.find(old => old.label === row.label) ??
      (previous?.rows.length === 1 && previous.rows[0]?.label === '週次 · 共有枠（Grok + Grok Bot）'
        ? { ...previous.rows[0], label: row.label } : undefined) ??
      (incoming.rows.length === 1 && previous?.rows.length === 1 ? previous.rows[0] : undefined)
    return old?.used !== null && old?.used !== undefined ? old : row
  })
  return { ...incoming, rows, context: incoming.context ?? previous?.context, failedAt }
}

export function recommend(cards: UsageCard[]): string | null {
  let best: { name: string; max: number } | undefined
  for (const card of cards) {
    const values = card.rows.flatMap(row => row.used === null ? [] : [row.used])
    if (card.failedAt !== undefined || values.length === 0) continue
    const max = Math.max(...values)
    if (!best || max < best.max) best = { name: card.name, max }
  }
  if (!best) return null
  const conserve = cards.find(card => card.name === 'Claude')?.rows.some(row => row.label === '5時間' && (row.used ?? 0) >= 80)
  return `いまは ${best.name} を使うのがおすすめ${conserve ? ' · Claudeの5時間枠を温存' : ''}`
}

const pad = (value: number) => String(value).padStart(2, '0')

export function timeLabel(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function resetLabel(reset: string | null | undefined, now: number): string {
  const end = Date.parse(reset ?? '')
  if (!Number.isFinite(end)) return ''
  const remaining = Math.max(0, end - now)
  if (remaining === 0) return `リセット ${timeLabel(end)} · リセット待ち`
  if (remaining < 86_400_000) {
    const minutes = Math.ceil(remaining / 60_000)
    return `リセット ${timeLabel(end)} · あと${Math.floor(minutes / 60)}h${minutes % 60}m`
  }
  const date = new Date(end)
  return `リセット ${date.getMonth() + 1}/${date.getDate()} ${timeLabel(end)} · あと${Math.floor(remaining / 86_400_000)}日`
}

export function barColor(used: number, color: string): string {
  return used >= 80 ? '#ef4444' : color
}

export function textBar(used: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, used)) / 5)
  return '█'.repeat(filled) + '░'.repeat(20 - filled)
}

export function svgBar(used: number, color: string): string {
  const width = Math.min(100, Math.max(0, used)) * 3
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="10" viewBox="0 0 300 10"><rect width="300" height="10" rx="5" fill="#3f3f46"/><rect width="${width}" height="10" rx="5" fill="${barColor(used, color)}"/></svg>`
}
