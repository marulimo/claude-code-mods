export type Speaker = 'dots' | 'grok'

export type Line = {
  id: string
  who: Speaker
  text: string
  at: number
  turnId: string
}

export type Chat = {
  isEnabled: boolean
  isBlocked: boolean
  turnId?: string
  turnStartedAt?: number
  busy?: Speaker
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'side-chat': { lines: Line[]; chat: Chat }
  }
}
