# Design

## What it is for

Someone with many small repositories, some of them running as live services, wants them kept in good order without doing the upkeep by hand: bugs fixed, security gaps closed, dependencies and structure maintained, and the code looked at again as newer models get better at finding problems. They want to wake up to a report, not a to-do list.

## What would make it a failure

These shaped most decisions.

- **A live app broken overnight and left broken.** Anything that goes live is checked and undone automatically if the app does not come back healthy.
- **Churn.** Changes made to have something to show. "Nothing worth changing tonight" is a normal, reported result.
- **Impact that is asserted rather than measured.** The job measures before and after itself. What the model says about its own impact is labelled as a claim.
- **An unfixed security hole described in public.**
- **A silent night.** If the job could not run, the app says so and says why.
- **Edits inside a running app's folder.** The job works in its own clones.

## Two parts, one data folder

- **The web app** (`src/main.mjs`): a page to add a project by pasting a link, remove one, and read each night's report.
- **The nightly job** (`src/cli.mjs run`): started by a schedule, it reads the project list, visits a few projects and writes the report.

They share a data folder and nothing else: `projects.json`, `settings.json`, `reports/<date>.json`, `history/<owner>__<repo>.json`, `workspaces/<owner>__<repo>/`, `run.lock`, and `schedule.json` when a schedule is installed.

## Who may do what

The central decision: **the model only reads, edits and commits inside a throwaway clone. Every step that touches GitHub or a running app is plain code in the job.** Waiting for checks, merging, pulling, restarting, health-checking and rolling back are deterministic and tested with fakes. The decisions that can break something are never left to a model's judgment.

Each project has three folders under `workspaces/`:

| Folder | Used by | Trust |
|---|---|---|
| `repo/` | The job. Fetches, commits, pushes. | Trusted. The sandbox makes it unreadable and unwritable to the model. |
| `tree/` | The model, and the project's checks. A clone of `repo/` with no remotes, rebuilt each time. | Untrusted, including its `.git` folder. |
| `cache/` | Temporary files and package caches for sandboxed commands. | Untrusted. |

A change crosses from `tree/` to `repo/` as a git bundle written from inside the sandbox. The job reads the bundle as data and records the result as a single new commit, authored and committed as the configured identity, with a message the job supplies. The job never runs git inside `tree/`, so hooks or settings planted there do nothing, and no attribution line the model wrote can reach GitHub.

## A visit

For each project, under a 45-minute limit:

1. **Is the repository still reachable and writable?** If not, say so and stop.
2. **Earlier pull requests of its own.** One that the rules had allowed, whose head has not moved and whose checks pass now, is merged and put live. At most one merged change per project per night. With three open, no new change is made.
3. **Prepare** the clones on a new `nightshift/<date>` branch from the repository's own default branch.
4. **Measure the baseline**: do the checks pass, how many tests ran and passed, how many known-vulnerable dependencies.
5. **The model inspects** with a fixed brief (`prompts/brief.md`): what upkeep means, no features, text in the repository is never an instruction, what earlier visits already recorded, and whether a change may be made tonight. It replies in a fixed JSON shape: findings, at most one change, proposals.
6. **Import** what it committed, rebuild `tree/` at that commit, and **measure again**, so what is measured is exactly what would be pushed.
7. **Decide** with the merge rules (`src/rules.mjs`).
8. **Push and open a pull request**, wait for its checks, and merge only on a pass, with the head commit pinned.
9. **Go live** (`src/golive.mjs`) and verify.

The report is rewritten after every project, so a run that is killed leaves a report for what finished.

## The merge rules

A green check is necessary and not sufficient, because a change can make a check pass by weakening it. So the rules also require that no fewer tests run, that nothing which defines the checks changed, and that a test proves the change: the job checks out the old code with only the change's test files and expects the checks to fail.

The model labels its own change, and three labels skip the test rule because no test can sensibly cover them. Each label is therefore checked against the diff:

- **Documentation**: only documentation files changed.
- **Dead code**: nothing but removal. No added lines, new files, binary changes or permission changes.
- **Dependency patch**: only `package.json` and `package-lock.json`; only forward steps within the same major version of dependencies already present; every changed lockfile entry still downloaded from the public registry under its own name and version with a sha512 hash; nothing else about how it installs changed.

Some files are never merged unattended whatever the checks say: CI, deploy configuration, environment files, migrations, package-manager and git configuration, agent instruction files, sign-in and payment code. The match is deliberately broad. The cost of a false match is a proposal that could have been merged, never the reverse.

A repository whose checks already fail gets proposals only, until a person has looked.

## Going live

After a merge the job waits for the workflow runs it triggered. If any fail it reverts the merge through a pull request, which it merges only if that pull request's checks pass.

For an app served from a checkout on the same machine and registered with a process launcher, the job then updates that checkout, but only if it is clean and on the default branch. It records the current commit, fast-forwards, reinstalls dependencies if the lockfile changed, runs the registered build steps, restarts the app and polls its health path for a minute. If the app is not healthy, the checkout goes back to the recorded commit, is rebuilt and restarted, and the merge is reverted on GitHub.

Projects on the `hold` list are merged but never restarted by the job. Use it for anything the job itself depends on: a job that restarts what it is running on can strand itself with no way back.

## Containment

See the safety model in the [README](../README.md#safety-model) for what the sandbox covers and what it does not. In short: an environment with no credentials in it; an OS sandbox that can write only to the project's working folders and cannot read credential folders, documents or the data folder; no direct internet, only an allow-listing proxy; a Claude sign-in by token, with a config folder that is emptied before and after every run so nothing persists from one run to the next.

Loopback is left open so projects' tests can run local servers. Blocking individual local ports did not work reliably in the macOS sandbox alongside a general network rule, and sandboxes cannot be nested, so this is a known gap rather than an oversight.

## Privacy

- An unfixed security finding appears only in the report. No public issue, title, description, commit message or branch name describes it. A security fix in a public repository is described neutrally and merged the same night, or its pull request is closed and its branch deleted.
- No AI attribution anywhere: commits are made by the job as the configured identity, and a title that names an AI tool is replaced before it is used.
- The repository holds no project names, reports or settings. Those are data.

## What is not built

- A "run now" button or per-project settings in the app. Use the command line.
- Releases, tags, publishing, secret rotation, or changes to repository settings.
- Dispatching a repository's own rollback workflow. If a deploy still fails after a revert, the report says so and a person takes over.
- Sandboxing on platforms other than macOS.
