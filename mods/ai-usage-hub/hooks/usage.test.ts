import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'
import { barColor, buildCards, devinRows, geminiRows, parseUsage, recommend, resetLabel, retainCard, svgBar, textBar, timeLabel } from './usage'

const NOW = Date.parse('2026-10-15T07:00:00Z')
const RESET = '2026-10-21T00:14:00Z'
const PAYLOAD = {
  updatedAt: '2026-10-15T07:00:00Z',
  groups: [
    { name: 'CODEX', rows: [{ label: '週次', used: 45, reset: RESET }] },
    { name: 'GROK', rows: [
      { label: '週次 · X Premium', used: 26, reset: RESET },
      { label: '週次 · Grok Bot', used: 26, reset: RESET },
    ] },
    { name: 'GEMINI', rows: geminiRows([
      { window: 'weekly', remaining_fraction: 0.4, reset_time: RESET },
      { window: '5h', remaining_fraction: 0.82, reset_time: RESET },
    ]) },
    { name: 'DEVIN', rows: devinRows({ dailyQuotaRemainingPercent: 82, weeklyQuotaRemainingPercent: 40,
      dailyQuotaResetAtUnix: String(Date.parse(RESET) / 1000), weeklyQuotaResetAtUnix: String(Date.parse(RESET) / 1000),
      planInfo: { planName: 'Pro' } }) },
    { name: 'CLAUDE', rows: [
      { label: '5時間', used: 70, reset: RESET },
      { label: '週次 · 全モデル', used: 30, reset: RESET },
      { label: '週次 · Scoped', used: 52, reset: RESET, star: true },
    ] },
  ],
}
const USAGE: SessionUsage = {
  startedAt: NOW,
  context: { window: 200_000, percent: 31 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 82, resetsAt: RESET },
    { kind: 'seven_day', percentUsed: 34, resetsAt: RESET },
  ],
}

test('JSON and session usage build five ordered cards with context, Fable and merged quota', () => {
  const cards = buildCards(parseUsage(JSON.stringify(PAYLOAD)), USAGE)
  expect(cards.map(card => card.name)).toEqual(['Claude', 'Codex', 'Grok', 'Gemini', 'Devin'])
  expect(cards.map(card => card.rows.map(row => row.used))).toEqual([[82, 34, 52], [45], [26], [18, 60], [18, 60]])
  expect(cards[0]?.context).toBe(31)
  expect(cards[2]?.color).toBe('#e8e8ea')
  expect(cards[3]?.color).toBe('#4c8bf5')
  expect(cards[4]?.color).toBe('#2dd4bf')
  expect(cards[0]?.rows[2]?.label).toBe('週次 · Fable')
  expect(cards[2]?.rows[0]?.label).toBe('週次 · 共有枠（Grok + Grok Bot）')
  const equivalent = buildCards({ groups: [{ name: 'GROK', rows: [
    PAYLOAD.groups[1]!.rows[0]!, { label: '週次 · Grok Bot', used: 26, reset: '2026-10-21T00:14:00+00:00' },
  ] }] }, USAGE)
  expect(equivalent[2]?.rows).toEqual(cards[2]?.rows)
  const different = buildCards({ groups: [PAYLOAD.groups[0]!, {
    name: 'GROK', rows: [PAYLOAD.groups[1]!.rows[0]!, { label: '週次 · Grok Bot', used: 27, reset: RESET }],
  }] }, USAGE)
  expect(different[2]?.rows.map(row => row.used)).toEqual([26, 27])
  expect(different[2]?.rows.map(row => row.label)).toEqual(['週次 · X Premium', '週次 · Grok Bot'])
})

test('Gemini converts remaining fractions, orders windows and leaves missing or invalid readings null', () => {
  expect(PAYLOAD.groups[2]?.rows.map(row => row.used)).toEqual([18, 60])
  expect(PAYLOAD.groups[2]?.rows.map(row => row.label)).toEqual(['5時間', '週次'])
  expect(geminiRows().map(row => row.used)).toEqual([null, null])
  for (const remaining_fraction of [undefined, null, '0.82', NaN, Infinity, -0.1, 1.1]) {
    const rows = geminiRows([{ window: '5h', remaining_fraction }])
    expect(rows.map(row => row.used)).toEqual([null, null])
    expect(rows.every(row => !!row.state)).toBe(true)
  }
  expect(geminiRows([{ window: '5h', remaining_fraction: 1 }, { window: 'weekly', remaining_fraction: 0 }])
    .map(row => row.used)).toEqual([0, 100])
})

test('Devin converts remaining percentages and reset seconds without inventing missing readings', () => {
  expect(PAYLOAD.groups[3]?.rows.map(row => row.used)).toEqual([18, 60])
  expect(PAYLOAD.groups[3]?.rows.map(row => row.label)).toEqual(['日次 · Pro', '週次 · Pro'])
  expect(PAYLOAD.groups[3]?.rows.map(row => row.reset)).toEqual(['2026-10-21T00:14:00.000Z', '2026-10-21T00:14:00.000Z'])
  expect(devinRows().map(row => row.used)).toEqual([null, null])
  for (const dailyQuotaRemainingPercent of [undefined, null, '82', NaN, Infinity, -1, 101]) {
    const rows = devinRows({ dailyQuotaRemainingPercent, dailyQuotaResetAtUnix: 'invalid' })
    expect(rows[0]?.used).toBe(null)
    expect(rows[0]?.reset).toBe(null)
    expect(rows.every(row => !!row.state)).toBe(true)
  }
})

test('Claude falls back to collected base windows and recognizes Fable by label as well as star', () => {
  const cards = buildCards(parseUsage(JSON.stringify(PAYLOAD)), { ...USAGE, rateLimits: [] })
  expect(cards[0]?.rows.map(row => row.used)).toEqual([70, 30, 52])
  expect(cards[0]?.rows.map(row => row.label)).toEqual(['5時間', '週次', '週次 · Fable'])
  expect(buildCards({ groups: [{ name: 'CLAUDE', rows: [
    { label: '週次 · Fable', used: 17, reset: RESET },
  ] }] }, null)[0]?.rows.map(row => row.used)).toEqual([null, null, 17])
})

test('Grok keeps separate rows for different or invalid resets, failed readings and extra rows', () => {
  const rows = PAYLOAD.groups[1]!.rows
  for (const reset of ['2026-10-22T00:14:00Z', 'bad-date', null]) {
    expect(buildCards({ groups: [{ name: 'GROK', rows: [rows[0]!, { ...rows[1]!, reset }] }] }, null)[2]?.rows)
      .toHaveLength(2)
  }
  const invalid = rows.map(row => ({ ...row, reset: 'bad-date' }))
  expect(buildCards({ groups: [{ name: 'GROK', rows: invalid }] }, null)[2]?.rows).toEqual(invalid)
  for (const failedIndex of [0, 1]) {
    const partial = rows.map((row, index) => index === failedIndex ? { ...row, used: null, state: '要ログイン' } : row)
    const card = buildCards({ groups: [{ name: 'GROK', rows: partial }] }, null)[2]!
    expect(card.rows).toEqual(partial)
    const previous = buildCards(PAYLOAD, USAGE)[2]!
    const retained = retainCard(previous, card, NOW)
    expect(retained.rows.map(row => row.used)).toEqual([26, 26])
    expect(retained.rows.map(row => row.label)).toEqual(rows.map(row => row.label))
    expect(retained.failedAt).toBe(NOW)
    const failed = { ...card, rows: partial.map(row => ({ ...row, used: null })) }
    expect(retainCard(previous, failed, NOW).rows).toEqual(previous.rows)
  }
  const extra = [...rows, { label: '追加枠', used: 12, reset: RESET }]
  expect(buildCards({ groups: [{ name: 'GROK', rows: extra }] }, null)[2]?.rows).toEqual(extra)
})

test('recommendation compares the maximum per card, excludes failed cards and conserves Claude', () => {
  const cards = buildCards(PAYLOAD, USAGE)
  expect(recommend(cards)).toBe('いまは Grok を使うのがおすすめ · Claudeの5時間枠を温存')
  expect(recommend(cards.map(card => ({ ...card, failedAt: NOW })))).toBe(null)
  expect(recommend(buildCards(null, null))).toBe(null)
  expect(recommend(cards.map(card => card.name.startsWith('Grok') ? { ...card, failedAt: NOW } : card)))
    .toBe('いまは Codex を使うのがおすすめ · Claudeの5時間枠を温存')
  for (const name of ['Gemini', 'Devin']) {
    expect(recommend(cards.map(card => card.name === name ? { ...card, rows: [{ label: '週次', used: 1 }] } : card)))
      .toBe(`いまは ${name} を使うのがおすすめ · Claudeの5時間枠を温存`)
  }
})

test('reset labels below and above 24 hours, invalid and expired timestamps', () => {
  const near = NOW + (2 * 60 + 25) * 60_000
  expect(resetLabel(new Date(near).toISOString(), NOW)).toBe(`リセット ${timeLabel(near)} · あと2h25m`)
  const far = NOW + 5 * 86_400_000
  const date = new Date(far)
  expect(resetLabel(new Date(far).toISOString(), NOW))
    .toBe(`リセット ${date.getMonth() + 1}/${date.getDate()} ${timeLabel(far)} · あと5日`)
  expect(resetLabel(new Date(NOW + 86_400_000).toISOString(), NOW)).toMatch('あと1日')
  expect(resetLabel('bad-date', NOW)).toBe('')
  expect(resetLabel(new Date(NOW).toISOString(), NOW)).toMatch('リセット待ち')
})

test('missing readings and failures keep state strings and previous values', () => {
  expect(buildCards(null, { ...USAGE, rateLimits: [] })[0]?.rows[0]?.state)
    .toBe('まだ数値がありません（Claude が応答すると出ます）')
  const previous = buildCards(PAYLOAD, USAGE)[1]!
  const incoming = { ...previous, rows: [{ label: '週次', used: null, state: '要ログイン' }] }
  expect(retainCard(previous, incoming, NOW).rows[0]?.used).toBe(45)
  expect(retainCard(previous, incoming, NOW).failedAt).toBe(NOW)
  expect(retainCard(undefined, incoming, NOW).rows[0]?.state).toBe('要ログイン')
  const multiple = { ...previous, rows: [previous.rows[0]!, { label: '5時間', used: 10 }] }
  expect(retainCard(multiple, { ...incoming, rows: [{ label: '使用率', used: null, state: '取得失敗' }] }, NOW).rows)
    .toEqual(multiple.rows)
  expect(retainCard(previous, incoming).failedAt).toBe(undefined)
  expect(() => parseUsage('{')).toThrow()
  expect(() => parseUsage('{"groups":[{"name":"CODEX","rows":[{"label":"週次","used":"45"}]}]}')).toThrow()
})

test('bars clamp their width, turn red at 80 percent and preserve 20 terminal characters', () => {
  expect(textBar(0)).toBe('░'.repeat(20))
  expect(textBar(100)).toBe('█'.repeat(20))
  expect(textBar(150)).toHaveLength(20)
  expect(textBar(-10)).toHaveLength(20)
  expect(barColor(79, '#59c39a')).toBe('#59c39a')
  expect(svgBar(80, '#59c39a')).toMatch('fill="#ef4444"')
})

function setup(on: On, variables: Record<string, string> = { AI_USAGE_NODE: 'custom-node', AI_USAGE_DASH_DIR: 'C:/dashboard' }) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, variables)
  const calls: string[][] = []
  let failing = false
  let externalFailing = false
  let sessionFailing = false
  let payload: { groups: { name: string; rows: { label: string; used: number | null; reset?: string | null; star?: boolean }[]; stale?: boolean }[] } = PAYLOAD
  let usage = USAGE
  let delay = 0
  on('session.usage', async () => {
    if (failing || sessionFailing) throw new Error('usage unavailable')
    return { value: usage }
  })
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (delay) await clock.sleep(delay)
    if (failing || externalFailing) throw new Error('process unavailable')
    return { value: { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return { clock, calls, fail: () => { failing = true }, empty: () => { usage = { ...USAGE, rateLimits: [] } },
    failExternal: () => { externalFailing = true }, failSession: () => { sessionFailing = true },
    staleClaude: () => { payload = { groups: PAYLOAD.groups.map(group => group.name === 'CLAUDE' ? { ...group, rows: [], stale: true } : group) } },
    freshSession: () => { usage = { ...USAGE, rateLimits: USAGE.rateLimits.map(limit => ({ ...limit, percentUsed: limit.percentUsed + 1 })) } },
    slow: () => { delay = 120_000 } }
}

const pane = {
  plugin: 'ai-usage-hub', component: 'Pane', requestId: 'ai-usage-hub',
  props: {
    title: 'AI Usage Hub', isFocused: true, bodyColumns: 44, placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 }, view: {},
  },
} as const

test('pane returns valid trees on terminal, desktop, vscode and mobile', async ($, on) => {
  const { clock, calls } = setup(on)
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'terminal' ? 0 : 9)
    expect(await ui.find({ type: 'Text', text: 'Gemini' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Devin' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '週次 · Fable' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Grokと同じ枠' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: '週次 · 共有枠（Grok + Grok Bot）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context 31%' })).toBeDefined()
    await ui.press({ key: 'refresh' })
    expect(calls).toHaveLength(1)
    await ui.unmount()
  }
  expect(calls[0]).toEqual(['custom-node', 'C:/dashboard/server.mjs', '--json', 'codex,grok,gemini,devin,claude'])
  expect(await $.command.run({ command: 'usage-hub', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 144 } })).toMatchObject({ text: 'AI Usage Hub を開きました' })
})

test('manual refresh throttle, minute redraw, five-minute poll and failure retention', async ($, on) => {
  const { clock, calls, fail } = setup(on)
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  await clock.advance(59_999)
  await ui.press({ key: 'refresh' })
  expect(calls).toHaveLength(1)
  await clock.advance(1)
  await ui.press({ key: 'refresh' })
  expect(calls).toHaveLength(2)
  await clock.advance(240_000)
  expect(calls).toHaveLength(3)
  fail()
  await clock.advance(300_000)
  expect(calls).toHaveLength(4)
  expect(await ui.findAll({ type: 'Text', text: /取得失敗/ })).toHaveLength(5)
  expect(await ui.find({ type: 'Text', text: '45%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /いまは/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: 'Grokと同じ枠' })).toBe(undefined)
  await ui.unmount()
})

test('HOME fallback, default node and empty session usage render collected Claude readings', async ($, on) => {
  const { clock, calls, empty } = setup(on, { HOME: '/home/demo' })
  empty()
  await $.session.start({ cwd: '/home/demo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls[0]).toEqual(['node', '/home/demo/ai-usage-dashboard/server.mjs', '--json', 'codex,grok,gemini,devin,claude'])
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Text', text: /まだ数値がありません/ })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: '70%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
  await ui.unmount()
})

test('session failure uses collected Claude values', async ($, on) => {
  const { clock, failSession } = setup(on)
  failSession()
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '70%' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /取得失敗/ })).toHaveLength(0)
  await ui.unmount()
})

test('external failure preserves Fable and provider values while session usage stays live', async ($, on) => {
  const { clock, failExternal, freshSession } = setup(on)
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  failExternal()
  freshSession()
  await clock.advance(300_000)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '週次 · Fable' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '45%' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /取得失敗/ })).toHaveLength(5)
  await ui.unmount()
})

test('stale Claude collector retains previous Fable while session windows update', async ($, on) => {
  const { clock, staleClaude, freshSession } = setup(on)
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  staleClaude()
  freshSession()
  await clock.advance(300_000)
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '週次 · Fable' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /取得失敗/ })).toHaveLength(1)
  await ui.unmount()
})

test('slow collection leaves the pane drawable and prevents overlapping refreshes', async ($, on) => {
  const { clock, calls, slow } = setup(on)
  slow()
  await $.session.start({ cwd: 'C:/dashboard', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '取得中…' })).toBeDefined()
  await clock.advance(60_000)
  await ui.press({ key: 'refresh' })
  expect(calls).toHaveLength(1)
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: '取得中…' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: '45%' })).toBeDefined()
  await ui.unmount()
})
