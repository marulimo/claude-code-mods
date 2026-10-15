import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { HubState } from '../types'
import { barColor, buildCards, parseUsage, recommend, resetLabel, retainCard, svgBar, textBar, timeLabel } from './usage'

const PANE = 'ai-usage-hub'
const hub = atom({ plugin: 'ai-usage-hub', key: 'hub' } as const, {
  cards: buildCards(null, null), updatedAt: null, lastAttempt: null, collecting: false, now: 0,
} as HubState)

async function collect($: EngineInterface): Promise<void> {
  const started = await $.clock.now()
  let claimed = false
  await update($, hub, state => {
    claimed = !state.collecting && (state.lastAttempt === null || started - state.lastAttempt >= 60_000)
    return claimed ? { ...state, collecting: true, lastAttempt: started } : state
  })
  if (!claimed) return
  try {
    const [external, claude] = await Promise.allSettled([
      (async () => {
        const node = (await $.env.get('AI_USAGE_NODE')) || 'node'
        const dir = (await $.env.get('AI_USAGE_DASH_DIR')) ||
          `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/ai-usage-dashboard`
        const result = await $.process.run([node, `${dir.replace(/[\\/]$/, '')}/server.mjs`, '--json', 'codex,grok,gemini,devin,claude'], {
          cwd: dir, timeoutMs: 180_000,
        })
        if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Usage process failed')
        return parseUsage(result.stdout)
      })(),
      $.session.usage(),
    ])
    const now = await $.clock.now()
    const cards = buildCards(external.status === 'fulfilled' ? external.value : null,
      claude.status === 'fulfilled' ? claude.value : null)
    await update($, hub, state => ({
      ...state, now, updatedAt: now,
      cards: cards.map((card, index) => {
        const failed = index === 0 ? card.rows.some(row => row.used === null) ||
          (external.status === 'rejected' && state.cards[0]?.rows.some(row => row.star || row.label.includes('Fable')) === true) ||
          (external.status === 'fulfilled' && external.value.groups.find(group => group.name === 'CLAUDE')?.stale === true) :
          external.status === 'rejected' || card.rows.some(row => row.used === null) ||
          (index === 1 && external.value.groups.find(group => group.name === 'CODEX')?.stale === true)
        // A completely failed fetch must keep every previous row, including labels.
        let incoming = (index === 0 ? claude.status === 'rejected' && external.status === 'rejected' : external.status === 'rejected')
          ? { ...card, rows: state.cards[index]?.rows ?? card.rows } : card
        if (index === 0 && !incoming.rows.some(row => row.star || row.label.includes('Fable')) &&
            (external.status === 'rejected' || external.value.groups.find(group => group.name === 'CLAUDE')?.stale === true)) {
          const fable = state.cards[0]?.rows.find(row => row.star || row.label.includes('Fable'))
          if (fable) incoming = { ...incoming, rows: [...incoming.rows, fable] }
        }
        return retainCard(state.cards[index], incoming, failed ? now : undefined)
      }),
    }))
  } finally {
    await update($, hub, state => ({ ...state, collecting: false }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-hub', description: 'AI使用率のペインを開きます' })
    void $.ui.open({ id: PANE, title: 'AI Usage Hub' })
    const now = await $.clock.now()
    await update($, hub, state => ({ ...state, collecting: false, now }))
    $.clock.every(300_000, () => { void collect($) })
    $.clock.every(60_000, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, hub, state => ({ ...state, now }))
      })()
    })
    void collect($)
    return next(e)
  })

  on('command.run', { command: 'usage-hub' }, async $ => {
    await $.ui.open({ id: PANE, title: 'AI Usage Hub' })
    return { text: 'AI Usage Hub を開きました' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, hub)
    const advice = recommend(state.cards)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>AI Usage Hub</Text>
        <Text dimColor>最終更新 {state.updatedAt === null ? '--:--' : timeLabel(state.updatedAt)}</Text>
        <Button key="refresh" label="更新" onPress={() => { void collect($) }} />
        {state.collecting && <Text dimColor>取得中…</Text>}
        {state.cards.map(card => (
          <Box key={card.name} flexDirection="column" borderStyle="round" borderColor={card.color} paddingX={1}>
            <Text bold color={card.color}>{card.name}</Text>
            {card.context !== undefined && <Text dimColor>Context {card.context}%</Text>}
            {card.rows.map(row => (
              <Box flexDirection="column">
                <Text>{row.label}</Text>
                {row.used === null ? <Text dimColor>{row.state || card.note || 'データなし'}</Text> : (
                  <Box flexDirection="column">
                    <Text bold color={card.color}>{row.used}%</Text>
                    {e.surface === 'terminal' ? (
                      <Text color={barColor(row.used, card.color)}>{textBar(row.used)}</Text>
                    ) : (() => {
                      const { Svg } = $.ui.resolve(e)
                      return <Svg source={svgBar(row.used, card.color)} alt={`${row.used}% 使用`} height={10} />
                    })()}
                    {!!row.reset && <Text dimColor>{resetLabel(row.reset, state.now)}</Text>}
                  </Box>
                )}
              </Box>
            ))}
            {!!card.note && <Text dimColor>{card.note}</Text>}
            {card.failedAt !== undefined && <Text dimColor>取得失敗 {timeLabel(card.failedAt)}</Text>}
          </Box>
        ))}
        {advice !== null && <Text>おすすめ: {advice}</Text>}
      </Box>
    )
  })
}
