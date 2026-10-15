export type UsageRow = {
  label: string
  used: number | null
  reset?: string | null
  state?: string
  star?: boolean
}

export type UsageGroup = {
  name: string
  rows: UsageRow[]
  stale?: boolean
  note?: string | null
}

export type UsagePayload = { updatedAt?: string; groups: UsageGroup[] }

export type UsageCard = {
  name: string
  color: string
  rows: UsageRow[]
  note?: string | null
  context?: number
  failedAt?: number
}

export type HubState = {
  cards: UsageCard[]
  updatedAt: number | null
  lastAttempt: number | null
  collecting: boolean
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'ai-usage-hub': { hub: HubState }
  }
}
