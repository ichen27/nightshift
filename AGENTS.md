# Nightshift: instructions for agents and contributors

Read this before changing anything.

## What this is

Nightshift keeps a list of GitHub repositories in good order. It has two entry points that share one data folder:

- `src/main.mjs`: a small web app. You paste a repository link to add a project, remove projects, and read each night's report.
- `src/cli.mjs run`: the nightly job. For a few projects a night it has headless Claude Code inspect a private clone and make at most one small change, then the job's own code decides whether to merge it, puts it live, verifies it, rolls it back if needed, and writes the report.

The split matters: the model only reads, edits and commits inside a private clone. Every step that touches GitHub or a running app (push, pull request, checks, merge, pull, restart, rollback) is plain code in this repository, tested with fakes.

## Layout

| Path | Responsibility |
|---|---|
| `src/config.mjs` | Data folder, host, port, tool paths, settings |
| `src/exec.mjs` | Run a command as an argv array with a timeout; never a shell |
| `src/store.mjs` | Atomic JSON files in the data folder |
| `src/repo-link.mjs` | Parse a pasted repository link |
| `src/github.mjs` | Every `gh` call |
| `src/projects.mjs` | Add, remove and list projects |
| `src/server.mjs`, `src/main.mjs` | HTTP API and static files |
| `public/` | The one page |
| `src/rotation.mjs`, `src/lock.mjs` | Which projects tonight; one run at a time |
| `src/report.mjs` | Report shape, counts, markdown |
| `src/workspace.mjs` | The job's trusted clone, the model's throwaway clone, and moving a change between them |
| `src/sandbox.mjs`, `src/proxy.mjs` | Restricted environment, macOS sandbox, and the allow-listing proxy for sandboxed commands |
| `src/measure.mjs` | Detect and run a repository's checks; read counts |
| `src/agent.mjs`, `prompts/brief.md` | Build and run the headless Claude call |
| `src/rules.mjs` | Merge or propose |
| `src/golive.mjs` | Put a merge live, verify, roll back |
| `src/nightly.mjs`, `src/cli.mjs` | Orchestrate a night; command line |
| `launchd/`, `scripts/install-schedule.mjs` | The schedule |
| `tests/` | `node:test` suites, one per module |

## Conventions

- Node 25, ES modules, `node:http` and `node:test`. No runtime dependencies. Do not add one without a strong reason.
- Subprocesses are argv arrays passed to `exec.mjs`. Never build a shell command string.
- The job's own git and `gh` commands run only in `workspaces/<project>/repo`, never in the model's `tree/`. Anything run on code the model touched goes through the restricted runner in `sandbox.mjs`.
- Anything that talks to GitHub, git remotes, Claude Code, launchd, the network or the clock is injected, so tests can replace it. Tests must pass on a clean GitHub-hosted Ubuntu runner with none of those available.
- Runtime data lives in the data folder (`NIGHTSHIFT_DATA_DIR`, else `APP_DATA_DIR`), never in the repository.
- UI copy is sentence case with no exclamation marks.

## This repository is public

- No private repository names, personal machine paths, report content or security findings in code, tests, docs, commit messages, issues or pull requests. Tests and examples use fictional repositories such as `octo/app`.
- The project list, settings and reports are data. They are never committed.
- `launcher.json` is machine-specific and git-ignored; `launcher.example.json` is the template.

## Validation

```sh
bash ci/run.sh        # what CI runs: npm ci, syntax check, tests
npm test              # tests only
npm run check         # syntax check only
```

## Change workflow

- Branch from `main`, keep the change focused, add or update tests first, and open a pull request. Do not push to `main`.
- Merge only after the `test` check passes on the pull request's current revision.
- If the app is deployed from a checkout of this repository, develop in a separate git worktree, not in that checkout.
- No tool or assistant attribution in commits, pull requests, comments or files.

## Shipping decisions (2026-11-16)

- Deployed to the owner's private app launcher: yes.
- GitHub repository: public.
- Name: brand name, Nightshift (repository `nightshift`, launcher id `nightshift`).
- License: MIT.
- Announcement on X or LinkedIn: neither.
