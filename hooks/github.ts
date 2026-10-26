import type { EngineInterface } from 'claude-code'

import type { GithubCheck, GithubPr } from '../types'
import type { LocalRepo } from './repo'

/** A refusal the pane shows as is; a rate limit carries when to try again. */
export class GithubError extends Error {
  retryAt: number | undefined
  isAuth: boolean

  constructor(message: string, options: { retryAt?: number; isAuth?: boolean } = {}) {
    super(message)
    this.retryAt = options.retryAt
    this.isAuth = options.isAuth ?? false
  }
}

export type GithubStatus = { pr?: GithubPr; checks: GithubCheck[]; isPushed: boolean }

type ApiPull = {
  number: number
  title: string
  html_url: string
  draft?: boolean
  head: { sha: string }
  requested_reviewers?: { login: string }[]
  requested_teams?: { slug: string }[]
}
type ApiReview = { user: { login: string } | null; state: string }
type ApiCheckRun = {
  name: string
  status: string
  conclusion: string | null
  html_url: string | null
  details_url: string | null
}
type ApiStatus = { context: string; state: string; target_url: string | null }

const ORDER: Record<GithubCheck['state'], number> = { fail: 0, pending: 1, pass: 2, skip: 3 }

async function get($: EngineInterface, repo: LocalRepo, path: string, token: string | undefined) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'claude-code-github-pr-status',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await $.http.fetch(`${repo.api}${path}`, { headers })
  if (response.status === 401) {
    throw new GithubError('GitHub rejected the token. Check it in the plugin settings.', { isAuth: true })
  }
  if ((response.status === 403 || response.status === 429) && response.headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(response.headers['x-ratelimit-reset']) * 1000
    throw new GithubError(
      token ? 'GitHub rate limit reached.' : 'GitHub rate limit reached. Add a token to raise it.',
      { retryAt: Number.isFinite(reset) ? reset : undefined },
    )
  }

  return { status: response.status, body: response.ok ? (JSON.parse(response.text) as unknown) : undefined }
}

function runState(run: ApiCheckRun): GithubCheck['state'] {
  if (run.status !== 'completed') return 'pending'
  if (run.conclusion === 'success') return 'pass'
  if (run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'skip'

  return 'fail'
}

function reviewState(reviews: ApiReview[], reviewers: string[]): GithubPr['review'] {
  const latest = new Map<string, string>()
  for (const review of reviews) {
    if (review.user && review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      latest.set(review.user.login, review.state)
    }
  }
  const states = [...latest.values()]
  if (states.includes('CHANGES_REQUESTED')) return 'changes'
  if (states.includes('APPROVED')) return 'approved'

  return reviewers.length > 0 ? 'required' : 'none'
}

/** The branch's open pull request, its reviews, and the checks on its head commit. */
export async function fetchStatus(
  $: EngineInterface,
  repo: LocalRepo,
  branch: string,
  token: string | undefined,
): Promise<GithubStatus> {
  const head = encodeURIComponent(`${repo.headOwner}:${branch}`)
  const pulls = await get($, repo, `/repos/${repo.base}/pulls?state=open&per_page=1&head=${head}`, token)
  if (pulls.status === 404) {
    throw new GithubError(
      token ? `${repo.base} was not found, or the token cannot read it.` : `${repo.base} was not found. If it is private, add a token.`,
    )
  }
  if (pulls.body === undefined) throw new GithubError(`GitHub answered ${pulls.status}.`)

  const pull = (pulls.body as ApiPull[])[0]
  // A pull request's checks live on its base repository; a bare branch's on the repository it was pushed to.
  const [where, ref] = pull ? [repo.base, pull.head.sha] : [repo.head, branch]
  const commit = `/repos/${where}/commits/${encodeURIComponent(ref)}`
  const [runs, statuses, reviews] = await Promise.all([
    get($, repo, `${commit}/check-runs?per_page=100`, token),
    get($, repo, `${commit}/status`, token),
    pull ? get($, repo, `/repos/${repo.base}/pulls/${pull.number}/reviews?per_page=100`, token) : undefined,
  ])

  const checks: GithubCheck[] = [
    ...((runs.body as { check_runs?: ApiCheckRun[] } | undefined)?.check_runs ?? []).map(run => ({
      name: run.name,
      state: runState(run),
      url: run.html_url ?? run.details_url ?? undefined,
    })),
    ...((statuses.body as { statuses?: ApiStatus[] } | undefined)?.statuses ?? []).map(status => ({
      name: status.context,
      state: (status.state === 'success' ? 'pass' : status.state === 'pending' ? 'pending' : 'fail') as GithubCheck['state'],
      url: status.target_url ?? undefined,
    })),
  ].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))

  if (!pull) return { checks, isPushed: runs.status !== 404 && runs.status !== 422 }

  const reviewers = [
    ...(pull.requested_reviewers ?? []).map(user => user.login),
    ...(pull.requested_teams ?? []).map(team => team.slug),
  ]

  return {
    isPushed: true,
    checks,
    pr: {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      isDraft: pull.draft ?? false,
      review: reviewState((reviews?.body as ApiReview[] | undefined) ?? [], reviewers),
      reviewers,
    },
  }
}
