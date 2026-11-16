# Nightshift

Nightly upkeep for a list of GitHub repositories, with a report of what changed.

You keep a list of repositories. Each night Nightshift visits a few of them, has headless [Claude Code](https://claude.com/claude-code) look for bugs, security problems, stale dependencies and disorganization, makes at most one small change per repository, merges it only if a fixed set of rules allows, and writes a report of what it found, what it proposed, what it did, and the measured impact.

## Status

**Under construction.** The pieces are landing one pull request at a time.

- Working today: the web app. You can add and remove projects and read reports.
- Not in `main` yet: the nightly job and its schedule. Until they land, nothing visits your repositories and the only report you can view is the sample one below.

This section is updated as each piece lands.

![The Nightshift page showing a project list and one night's report](docs/screenshots/nightshift.png)

The screenshot uses made-up repositories.

## Prerequisites

- Node.js 25 or newer
- The [GitHub CLI](https://cli.github.com/) (`gh`), signed in, to add projects. A link is accepted only for a repository your account can push to.

The nightly job will additionally need Claude Code signed in, and macOS for the built-in schedule.

## Install

```sh
git clone https://github.com/ichen27/nightshift.git
cd nightshift
npm ci
```

## Quickstart

Run the app against a throwaway data folder with the sample report:

```sh
export NIGHTSHIFT_DATA_DIR="$(mktemp -d)"
mkdir -p "$NIGHTSHIFT_DATA_DIR/reports"
cp tests/fixtures/report.json "$NIGHTSHIFT_DATA_DIR/reports/2026-01-05.json"
npm start
```

Open <http://127.0.0.1:8950>. Paste a repository link and choose "Add project" to add one; use the trash button to remove it.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `NIGHTSHIFT_DATA_DIR` | Folder for the project list, settings and reports. `APP_DATA_DIR` is used if this is not set. | required |
| `HOST`, `PORT` | Where the web app listens. | `127.0.0.1`, `8950` |
| `NIGHTSHIFT_ALLOWED_HOSTS` | Extra host names the app answers to, comma-separated, for when it sits behind a proxy. Loopback on the chosen port is always allowed. | none |
| `NIGHTSHIFT_GH`, `NIGHTSHIFT_GIT`, `NIGHTSHIFT_CLAUDE`, `NIGHTSHIFT_NODE` | Paths to the tools, if they are not on `PATH`. | command names |

The app has no sign-in of its own. Adding a repository gives the nightly job the right to change and merge code in it, so keep the app on loopback or behind a proxy that authenticates you. Requests for any other host name are refused, and changes are accepted only as JSON from the app's own page.

`launcher.example.json` is a manifest template for running the app under a process launcher; copy it to `launcher.json`, which is git-ignored.

## Validation

```sh
bash ci/run.sh
```

This installs from the lockfile, syntax-checks every source file and runs the tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents and contributors should read [AGENTS.md](AGENTS.md) first.

## License

[MIT](LICENSE)
