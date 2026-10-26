# GitHub PR Status

A Claude Code plugin that keeps a **GitHub** pane next to the chat. The pane shows the current branch's pull request, its review state and its CI checks, so you can see whether CI passed after a push without leaving the conversation.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install github-pr-status --marketplace jotapedebarros-cell/github-pr-status
```

Answer `y` to add the marketplace, then press Enter to install it for your user (the first scope listed).

From a shell:

```bash
claude plugin install github-pr-status --marketplace jotapedebarros-cell/github-pr-status
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `jotapedebarros-cell/github-pr-status`, then **Add plugin**.

## What the pane shows

- The repository and branch you're on
- The open pull request for that branch, linked, marked if it's a draft
- Review state: **Approved**, **Changes requested**, or **Review requested** with the people and teams asked
- A summary of the CI checks (`1 failing · 1 running · 6/8 passed`), then each check with a link to its run. Failing checks come first. It covers GitHub Actions check runs and commit statuses (Vercel, CircleCI and similar).
- A **Refresh** button (press `r` while the pane is focused)

If the branch has no pull request yet, the pane shows the checks on the pushed branch, or tells you the branch isn't on GitHub yet.

## How it works

- The plugin reads the branch and remote directly from the `.git` folder, so it needs neither `git` nor `gh` on your PATH. It handles worktrees, forks (it opens PRs against an `upstream` remote when one exists), branches that track a remote branch with a different name, and GitHub Enterprise hosts.
- It talks to the GitHub REST API.
- The pane opens by itself when a session starts inside a GitHub repository. Type `/pr-status` to open it at any other time.
- While the pane is open it refreshes every 60 seconds, or every 5 minutes without a token. It also refreshes about 2 seconds after Claude runs `git push`, `git checkout`, `git switch`, `git pull`, `git merge`, `git rebase`, `git commit`, `gh pr …` or `gh run …`.
- If GitHub rate-limits it, the plugin waits until the limit resets.

## Token (optional)

Public repositories work without a token. You need one for private repositories, and with one the pane can refresh faster. The plugin uses the first of these that it finds:

1. The plugin's **GitHub token** option (asked for when you install the plugin and kept in secure storage)
2. The `GITHUB_TOKEN` environment variable
3. The `GH_TOKEN` environment variable
4. `gh auth token`, if the GitHub CLI is installed and signed in

For a fine-grained token, grant read-only access to **Pull requests**, **Checks** and **Commit statuses** on the repositories you want to watch.

## Options

| Option           | Default | What it does                                                    |
| ---------------- | ------- | --------------------------------------------------------------- |
| `token`          | empty   | GitHub token (secret), see above                                |
| `refreshSeconds` | `60`    | How often the open pane checks GitHub. At least 300 without a token. |

## Run it from a local copy

```bash
claude --plugin-dir /path/to/github-pr-status
```

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests in `tests/` run the plugin against a fake repository and fake GitHub responses, and check what the pane draws on the terminal and desktop surfaces.

## License

MIT
