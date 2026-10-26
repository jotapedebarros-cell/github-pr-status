/** One CI result on the branch's head commit: a check run or a commit status. */
export type GithubCheck = {
  name: string
  state: 'pass' | 'fail' | 'pending' | 'skip'
  url?: string
}

/** The open pull request whose head is the current branch. */
export type GithubPr = {
  number: number
  title: string
  url: string
  isDraft: boolean
  review: 'approved' | 'changes' | 'required' | 'none'
  /** Logins and team slugs still asked to review. */
  reviewers: string[]
}

/** What the pane draws, rewritten on every refresh. */
export type GithubView = {
  phase: 'starting' | 'no-repo' | 'ready' | 'error'
  /** Why there is nothing to show, for `no-repo` and `error`. */
  message?: string
  /** `owner/name` of the repository the pull request is opened against. */
  repo?: string
  branch?: string
  /** False when the branch has no commits on GitHub yet. */
  isPushed?: boolean
  pr?: GithubPr
  checks: GithubCheck[]
  hasToken: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'github-pr-status': { view: GithubView; isLoading: boolean }
  }
}
