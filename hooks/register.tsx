import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GithubCheck, GithubPr, GithubView } from '../types'
import { fetchStatus, GithubError } from './github'
import { readLocalRepo } from './repo'

const PANE = 'github-pr-status'
const TITLE = 'GitHub'
const TICK_MS = 15_000
const NO_TOKEN_MIN_MS = 300_000

const view = atom({ plugin: 'github-pr-status', key: 'view' } as const, {
  phase: 'starting',
  checks: [],
  hasToken: false,
} as GithubView)
const isLoading = atom({ plugin: 'github-pr-status', key: 'isLoading' } as const, false)

const ICON: Record<GithubCheck['state'], string> = { pass: '✓', fail: '✗', pending: '●', skip: '○' }
const COLOR: Record<GithubCheck['state'], string> = { pass: 'success', fail: 'error', pending: 'warning', skip: 'subtle' }
const REVIEW: Record<GithubPr['review'], { text: string; color: string }> = {
  approved: { text: '✓ Approved', color: 'success' },
  changes: { text: '✗ Changes requested', color: 'error' },
  required: { text: '● Review requested', color: 'warning' },
  none: { text: 'No reviews yet', color: 'subtle' },
}

// Module variables start over on a hot reload, which is fine for a cache.
let inFlight: Promise<void> | undefined
let lastFetchAt = 0
let pausedUntil = 0
let cachedToken: { value: string | undefined } | undefined
// Set from the plugin's options each time `register` runs.
let configuredToken = ''
let refreshMs = 60_000

async function resolveToken($: EngineInterface): Promise<string | undefined> {
  if (configuredToken) return configuredToken
  if (cachedToken) return cachedToken.value

  let value = (await $.env.get('GITHUB_TOKEN')) || (await $.env.get('GH_TOKEN')) || undefined
  if (!value) {
    const gh = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 5_000 }).catch(() => undefined)
    value = gh?.exitCode === 0 ? gh.stdout.trim() || undefined : undefined
  }
  cachedToken = { value }

  return value
}

async function describe($: EngineInterface): Promise<GithubView> {
  const local = await readLocalRepo($, await $.session.cwd())
  if (typeof local === 'string') return { phase: 'no-repo', message: local, checks: [], hasToken: false }

  const token = await resolveToken($)
  const known = { repo: local.base, branch: local.branch, checks: [], hasToken: token !== undefined }
  if (local.branch === undefined) {
    return { ...known, phase: 'no-repo', message: 'HEAD is detached. Check out a branch to see its pull request.' }
  }

  try {
    return { ...known, phase: 'ready', ...(await fetchStatus($, local, local.branch, token)) }
  } catch (error) {
    if (error instanceof GithubError && error.retryAt !== undefined) pausedUntil = error.retryAt
    if (error instanceof GithubError && error.isAuth) cachedToken = undefined

    return { ...known, phase: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

function refresh($: EngineInterface): Promise<void> {
  inFlight ??= (async () => {
    await update($, isLoading, () => true)
    lastFetchAt = await $.clock.now()
    const next = await describe($)
    await update($, view, () => next)
    await update($, isLoading, () => false)
  })().finally(() => {
    inFlight = undefined
  })

  return inFlight
}

/** Refreshes the open pane once its interval has passed; quiet while it is closed. */
async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const hasToken = configuredToken !== '' || cachedToken?.value !== undefined
  const every = hasToken ? refreshMs : Math.max(refreshMs, NO_TOKEN_MIN_MS)
  if (now < pausedUntil || now - lastFetchAt < every) return

  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) await refresh($)
}

/** Background work's failures go to the debug log. */
function logFailure($: EngineInterface, error: unknown) {
  $.ui.log(`github-pr-status: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
}

export const register: Register = (on, options) => {
  configuredToken = typeof options.token === 'string' ? options.token.trim() : ''
  refreshMs = Math.max(15, typeof options.refreshSeconds === 'number' ? options.refreshSeconds : 60) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-status',
      description: "Show this branch's GitHub pull request and CI checks in a pane",
    })
    $.clock.every(TICK_MS, () => {
      tick($).catch(error => logFailure($, error))
    })

    // Open the pane unasked only inside a GitHub repository.
    const local = await readLocalRepo($, e.cwd).catch(() => 'unreadable')
    if (e.isInteractive && typeof local !== 'string') void $.ui.open({ id: PANE, title: TITLE })
    refresh($).catch(error => logFailure($, error))

    return next(e)
  })

  on('command.run', { command: 'pr-status' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: opened.isPlaced ? 'GitHub pane opened.' : `GitHub pane is waiting: ${opened.reason}` }
  })

  // After Claude pushes, switches branch or touches a PR, refresh soon rather than at the next interval.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+(push|checkout|switch|pull|merge|rebase|commit)\b|\bgh\s+(pr|run)\b/.test(String(e.command))) {
      $.clock.after(2_000, () => {
        refresh($).catch(error => logFailure($, error))
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const shown = await read($, view)
    const loading = await read($, isLoading)
    const pr = shown.pr
    const failing = shown.checks.filter(check => check.state === 'fail').length
    const running = shown.checks.filter(check => check.state === 'pending').length
    const passed = shown.checks.filter(check => check.state === 'pass').length
    const cadence = shown.hasToken
      ? `Updates every ${refreshMs / 1000}s`
      : 'Updates every 5 min. Add a token for faster updates'

    return (
      <Box flexDirection="column" gap={1}>
        {shown.phase === 'starting' && <Text dimColor>Looking for this branch on GitHub…</Text>}
        {shown.phase === 'no-repo' && <Text dimColor>{shown.message}</Text>}

        {shown.repo && (
          <Text wrap="truncate-end">
            <Text weight="semibold">{shown.repo}</Text>
            <Text dimColor>{shown.branch ? ` · ${shown.branch}` : ''}</Text>
          </Text>
        )}

        {shown.phase === 'error' && <Text color="error">{shown.message}</Text>}

        {shown.phase === 'ready' && pr && (
          <Box flexDirection="column">
            <Link href={pr.url} label={`#${pr.number} ${pr.title}`} />
            <Text>
              {pr.isDraft && <Text dimColor>Draft · </Text>}
              <Text color={REVIEW[pr.review].color}>{REVIEW[pr.review].text}</Text>
              {pr.reviewers.length > 0 && <Text dimColor>{` (${pr.reviewers.join(', ')})`}</Text>}
            </Text>
          </Box>
        )}
        {shown.phase === 'ready' && !pr && (
          <Text dimColor>
            {shown.isPushed === false
              ? 'This branch is not on GitHub yet.'
              : 'No open pull request for this branch.'}
          </Text>
        )}

        {shown.phase === 'ready' && (
          <Box flexDirection="column">
            <Text weight="semibold">
              {shown.checks.length === 0
                ? 'No checks reported'
                : [
                    failing > 0 ? `${failing} failing` : '',
                    running > 0 ? `${running} running` : '',
                    `${passed}/${shown.checks.length} passed`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </Text>
            {shown.checks.map(check => (
              <Box flexDirection="row" gap={1}>
                <Text color={COLOR[check.state]}>{ICON[check.state]}</Text>
                {check.url ? (
                  <Link href={check.url} label={check.name} />
                ) : (
                  <Text wrap="truncate-end">{check.name}</Text>
                )}
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="refresh" hotkey="r" onPress={() => refresh($)}>
            Refresh
          </Button>
          <Text dimColor wrap="truncate-end">
            {loading ? 'Refreshing…' : shown.phase === 'no-repo' ? '' : cadence}
          </Text>
        </Box>
      </Box>
    )
  })
}
