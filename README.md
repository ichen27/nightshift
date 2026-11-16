# Nightshift

Nightly upkeep for a list of GitHub repositories, with a report of what changed.

You keep a list of repositories. Each night Nightshift visits a few of them, has headless [Claude Code](https://claude.com/claude-code) look for bugs, security problems, stale dependencies and disorganization, makes at most one small change per repository, merges it only if a fixed set of rules allows, and writes a report of what it found, what it proposed, what it did, and the measured impact.

## Status

**Under construction.** The pieces are landing one pull request at a time. Today the repository contains the configuration module, CI and project documentation. The web app, the nightly job and the schedule are not in `main` yet, so there is nothing to run. This section is updated as each piece lands.

## Prerequisites

- Node.js 25 or newer

The nightly job will additionally need the GitHub CLI (`gh`) signed in, Claude Code signed in, and macOS for the built-in schedule.

## Install

```sh
git clone https://github.com/ichen27/nightshift.git
cd nightshift
npm ci
```

## Validation

```sh
bash ci/run.sh
```

This installs from the lockfile, syntax-checks every source file and runs the tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents and contributors should read [AGENTS.md](AGENTS.md) first.

## License

[MIT](LICENSE)
