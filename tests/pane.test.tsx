import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'github-pr-status',
  component: 'Pane',
  requestId: 'github-pr-status',
  props: {
    title: 'GitHub',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPO_FILES: Record<string, string> = {
  '/work/app/.git/HEAD': 'ref: refs/heads/feature/login\n',
  '/work/app/.git/config': [
    '[core]',
    '\tbare = false',
    '[remote "origin"]',
    '\turl = git@github.com:acme/app.git',
    '[branch "feature/login"]',
    '\tremote = origin',
    '\tmerge = refs/heads/feature/login',
  ].join('\n'),
}

const API: Record<string, unknown> = {
  '/repos/acme/app/pulls?state=open&per_page=1&head=acme%3Afeature%2Flogin': [
    {
      number: 42,
      title: 'Add login',
      html_url: 'https://github.com/acme/app/pull/42',
      draft: false,
      head: { sha: 'abc123' },
      requested_reviewers: [],
      requested_teams: [],
    },
  ],
  '/repos/acme/app/commits/abc123/check-runs?per_page=100': {
    check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/app/runs/1', details_url: null },
      { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/app/runs/2', details_url: null },
      { name: 'lint', status: 'in_progress', conclusion: null, html_url: null, details_url: null },
    ],
  },
  '/repos/acme/app/commits/abc123/status': {
    statuses: [{ context: 'deploy/preview', state: 'success', target_url: 'https://preview.example.com' }],
  },
  '/repos/acme/app/pulls/42/reviews?per_page=100': [{ user: { login: 'maria' }, state: 'APPROVED' }],
}

/** The engine beneath the plugin: a repo at /work/app (or none), GitHub's API, and a surface. */
function world(on: On, { hasRepo = true } = {}) {
  const seen = { fetches: [] as string[], opened: 0 }
  // The engine hands paths over in the platform's form (`C:\work\app\.git` on Windows).
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('session.cwd', () => ({ value: hasRepo ? '/work/app/src' : '/tmp/elsewhere' }))
  on('fs.stat', (_, e) =>
    hasRepo && posix(e.path) === '/work/app/.git'
      ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', (_, e) => {
    const file = REPO_FILES[posix(e.path)]

    return hasRepo && file !== undefined ? { value: file } : { deny: 'ENOENT' }
  })
  on('http.fetch', (_, e) => {
    const path = e.url.replace('https://api.github.com', '')
    seen.fetches.push(path)
    const body = API[path]

    return {
      value:
        body === undefined
          ? { status: 404, ok: false, headers: {}, text: '{}' }
          : { status: 200, ok: true, headers: {}, text: JSON.stringify(body) },
    }
  })
  on('command.register', () => ({ value: { command: 'pr-status' } }))
  on('ui.open', () => {
    seen.opened += 1

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  return seen
}

test('the pane shows the pull request, its review and its checks', { options: { token: 'test-token' } }, async ($, on) => {
  const seen = world(on)
  const clock = mock.clock(on, { now: 1_000_000 })

  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(seen.opened).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ text: /acme\/app/ }))?.text).toContain('feature/login')
    expect(await ui.find({ type: 'Link', text: /#42 Add login/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Approved/ }))?.text).toBe('✓ Approved')
    expect((await ui.find({ type: 'Text', text: /passed/ }))?.text).toBe('1 failing · 1 running · 2/4 passed')
    // Failing checks are listed first.
    const firstCheck = await ui.find({ type: 'Link', text: /^(build|test|deploy\/preview)$/ })
    expect(firstCheck?.text).toBe('test')
    await ui.unmount()
  }
})

test('outside a git repository the pane says so and does not open by itself', async ($, on) => {
  const seen = world(on, { hasRepo: false })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/tmp/elsewhere', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(seen.opened).toBe(0)
  expect(seen.fetches).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'This folder is not in a git repository.' })).toBeDefined()
  await ui.unmount()
})

test('a git push from Claude refreshes the pane soon after', { options: { token: 'test-token' } }, async ($, on) => {
  const seen = world(on)
  const clock = mock.clock(on, { now: 1_000_000 })

  await $.session.start({ cwd: '/work/app/src', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const before = seen.fetches.length

  await $.tool.call({ tool: 'Bash', command: 'git push origin feature/login' })
  await clock.advance(2_000)
  expect(seen.fetches.length).toBeGreaterThan(before)

  const quiet = seen.fetches.length
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(2_000)
  expect(seen.fetches.length).toBe(quiet)
})
