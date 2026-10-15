export type Mention = { text: string; url: string }

export type Mentions = {
  status: 'idle' | 'loading' | 'done' | 'error'
  items: Mention[]
  checkedAt?: string
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'x-post': {
      isThinking: boolean
      isGated: boolean
      tags: string[]
      account: string
      mentions: Mentions
      draft: string
      replyTo: string
      lastResult: string
    }
  }
}
