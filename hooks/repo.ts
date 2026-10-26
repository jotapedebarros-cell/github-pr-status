import type { EngineInterface } from 'claude-code'

/**
 * The current branch and where it lives on GitHub, read from the `.git`
 * folder alone, so no git binary is needed.
 */
export type LocalRepo = {
  /** `https://api.github.com`, or a GitHub Enterprise host's `/api/v3`. */
  api: string
  /** `owner/name` pull requests are opened against: `upstream` if set, else the branch's remote. */
  base: string
  /** `owner/name` the branch is pushed to. */
  head: string
  headOwner: string
  /** The branch's name on GitHub; undefined on a detached HEAD. */
  branch: string | undefined
}

type Remote = { host: string; owner: string; slug: string }

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`
const parent = (dir: string) => dir.replace(/[\\/]+[^\\/]*[\\/]*$/, '')
const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path)

/** `.git` above `start`, following a worktree's `gitdir:` pointer and `commondir`. */
async function findGitDirs($: EngineInterface, start: string) {
  let dir = start
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(dir, '.git')
    const stat = await $.fs.stat(dotGit).catch(() => undefined)
    if (stat?.kind === 'dir') return withCommonDir($, dotGit)
    if (stat?.kind === 'file') {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await $.fs.read(dotGit))?.[1]
      if (pointer) return withCommonDir($, isAbsolute(pointer) ? pointer : join(dir, pointer))
    }
    const up = parent(dir)
    if (up === dir || up === '') return undefined
    dir = up
  }

  return undefined
}

async function withCommonDir($: EngineInterface, gitDir: string) {
  const common = (await $.fs.read(join(gitDir, 'commondir')).catch(() => '')).trim()
  const commonDir = common === '' ? gitDir : isAbsolute(common) ? common : join(gitDir, common)

  return { gitDir, commonDir }
}

/** A git config file's keys, by `section` or `section.subsection` (`remote.origin`). */
export function parseConfig(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[\s*([^\s\]"]+)(?:\s+"(.*)")?\s*\]$/.exec(line)
    if (header) {
      const name = (header[1] ?? '').toLowerCase()
      const key = header[2] === undefined ? name : `${name}.${header[2]}`
      current = sections.get(key) ?? new Map<string, string>()
      sections.set(key, current)
      continue
    }
    const pair = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line)
    if (pair && current) current.set((pair[1] ?? '').toLowerCase(), (pair[2] ?? '').replace(/^"(.*)"$/, '$1'))
  }

  return sections
}

/** A GitHub remote from an https, ssh or scp-style URL; undefined for another forge. */
export function parseRemote(url: string | undefined): Remote | undefined {
  const match =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url?.trim() ?? '',
    )
  const [, host, owner, name] = match ?? []
  if (!host || !owner || !name || !/github/i.test(host)) return undefined

  return { host: host.toLowerCase(), owner, slug: `${owner}/${name}` }
}

/** The repository the session's folder is in, or why there is none to show. */
export async function readLocalRepo($: EngineInterface, cwd: string): Promise<LocalRepo | string> {
  const dirs = await findGitDirs($, cwd)
  if (!dirs) return 'This folder is not in a git repository.'

  const head = (await $.fs.read(join(dirs.gitDir, 'HEAD')).catch(() => '')).trim()
  const local = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]
  const config = parseConfig(await $.fs.read(join(dirs.commonDir, 'config')).catch(() => ''))
  const tracking = local === undefined ? undefined : config.get(`branch.${local}`)
  const remoteName = tracking?.get('remote')
  const pushedTo =
    (remoteName && remoteName !== '.' ? parseRemote(config.get(`remote.${remoteName}`)?.get('url')) : undefined) ??
    parseRemote(config.get('remote.origin')?.get('url'))
  if (!pushedTo) return 'This repository has no GitHub remote.'

  const base = parseRemote(config.get('remote.upstream')?.get('url')) ?? pushedTo
  const merged = /^refs\/heads\/(.+)$/.exec(tracking?.get('merge') ?? '')?.[1]

  return {
    api: base.host === 'github.com' ? 'https://api.github.com' : `https://${base.host}/api/v3`,
    base: base.slug,
    head: pushedTo.slug,
    headOwner: pushedTo.owner,
    branch: merged ?? local,
  }
}
