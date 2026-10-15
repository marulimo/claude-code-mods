export type Mode = 'devin' | 'codex'

export type Run = {
  id: string
  mode: Mode
  effort: string
  prompt: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  answer?: string
  progress?: string
  sessionId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'ask-codex': { runs: Run[]; mode: Mode; effort: Partial<Record<Mode, string>> }
  }
}
