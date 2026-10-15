export type Post = {
  id: string
  handle: string
  name: string
  text: string
  time: string
  url: string
}

export type Feed = {
  tags: string[]
  isPaused: boolean
  isFetching: boolean
  lastRunAt?: number
  lastAdded?: number
  lastDropped?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'tag-feed': { posts: Post[]; feed: Feed }
  }
}
