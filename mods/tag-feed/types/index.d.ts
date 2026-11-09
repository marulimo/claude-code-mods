export type Media = {
  kind: 'photo' | 'video' | 'gif'
  thumb: string
  w: number
  h: number
}

export type Post = {
  id: string
  handle: string
  name: string
  text: string
  time: string
  url: string
  media?: Media[]
}

export type Feed = {
  tags: string[]
  isPaused: boolean
  isFetching: boolean
  lastRunAt?: number
  lastAdded?: number
  lastDropped?: number
  error?: string
  blockedAt?: number
  blockedReason?: string
  probedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tag-feed': { posts: Post[]; feed: Feed; thumbs: Record<string, string> }
  }
}
