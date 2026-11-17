# Operations

Everything here assumes `NIGHTSHIFT_DATA_DIR` points at your data folder.

## settings.json

Lives in the data folder. Every key is optional except `identity`, which a run needs.

| Key | Meaning | Default |
|---|---|---|
| `identity` | `{ "name": "...", "email": "..." }`. Authors every commit the job makes. | none; required |
| `projectsPerNight` | How many projects one run visits. | `3` |
| `hold` | Projects (`owner/repo`) that are merged but never pulled or restarted by the job. Put anything the job itself depends on here. | `[]` |
| `adminMerge` | Projects where the merge uses your admin rights to pass a review rule. Checks must still pass. | `[]` |
| `vaultDir` | A notes vault. Each night's report is also written to `<vaultDir>/my-knowledge-base/raw/nightshift/<date>.md`. | none |
| `launcherDir` | Checkout of the process launcher whose `src/cli.mjs restart <id>` restarts an app. | none |
| `launcherRegistry` | Path to that launcher's registry file, used to find which app runs from which checkout. | none |
| `toolPaths` | Per project, folders to put first on `PATH` for its checks and for the model, for a project that needs its own toolchain: `{ "owner/repo": ["/path/to/node22/bin"] }`. | `{}` |
| `sandbox.allowWrite` | Extra folders sandboxed commands may write to. | `[]` |
| `sandbox.allowRead` | Folders to re-allow inside a denied area. | `[]` |
| `sandbox.denyRead` | Extra folders sandboxed commands may not read. Add anywhere secrets or other projects live. | `[]` |
| `sandbox.allowHosts` | Extra internet hosts sandboxed commands may reach. `*.example.com` matches subdomains. | `[]` |
| `sandbox.allowPorts` | Local ports below 49152 that sandboxed commands may connect to, for tests that need a service on a fixed port (a database, say). Anything listed is reachable by the model too. | `[]` |
| `allowUnsandboxed` | Run without the OS sandbox on a platform that has none. The model is then limited only by its environment. | `false` |

Without `launcherDir` and `launcherRegistry`, merged changes are reported as merged and nothing is restarted.

## The Claude token

```sh
claude setup-token
```

Save the token it prints as `claude-token` in the data folder and make it readable only by you:

```sh
chmod 600 "$NIGHTSHIFT_DATA_DIR/claude-token"
```

The job passes it to the model's own process and nowhere else. It does not use your everyday Claude Code sign-in or settings.

Because the run starts from empty settings, the model is whatever Claude Code picks by default for that account, not the one you chose in your everyday settings. Each report records which model was used. Usage counts against the account that created the token.

The token is long-lived but does expire. When it stops working, the report says "Claude is not signed in": create a new one the same way.

## How a project's checks are found

In order: `ci/run.sh` if the repository has one (it is expected to install what it needs); otherwise the `ci` script in `package.json`, then the `test` script; otherwise `swift test` for a Swift package. For an npm script, the job first runs `npm ci` in every folder that has a `package-lock.json`, the root first, so a repository with more than one package is installed fully. A repository with none of these has no checks as far as the job can tell, and nothing is ever merged there.

## Run by hand

```sh
node src/cli.mjs run --only owner/repo --dry-run   # inspect and report only
node src/cli.mjs run --only owner/repo             # one project, for real
node src/cli.mjs run                               # tonight's rotation
```

A second run on the same date adds to that date's report. Only one run can be in progress; a second exits with code 3.

If a run refuses to start, the report says why. The usual reasons: no `identity`, no token, `gh` not signed in, or a platform with no sandbox.

## The schedule (macOS)

```sh
node scripts/install-schedule.mjs install   # every night at 2:00 AM local time
node scripts/install-schedule.mjs remove
```

Check it:

```sh
launchctl print gui/$(id -u)/com.ichen27.nightshift-run
```

The machine has to be awake, online and signed in at 2:00 AM. If a night is missed, the app says so the next morning.

Logs are in `~/Library/Logs/nightshift/run.log`. The log names each project as it is visited, the outcome, and any internet host the sandbox refused.

## When a project only ever gets proposals

Look at the report's reason. Common causes:

- **"The repository's checks do not pass with the change"** on every visit, with a note that the checks are failing: the checks fail inside the sandbox before any change. Run them the same way to see why. If they need to write somewhere else, add it to `sandbox.allowWrite`. If an install needs another host, the log names it; add it to `sandbox.allowHosts`. Browser tests that start their own sandbox cannot run inside this one.
- The same note, and the project pins a tool version you do not have first on `PATH` (a `package.json` `engines` range, for example): point `toolPaths` at the right one.
- Tests that connect to a local service on a fixed port (`ECONNREFUSED` or a timeout on `127.0.0.1:5432`, for example) need that port in `sandbox.allowPorts`. Ports the system picks for a test's own server already work.
- Tests that drive a browser need to read the browser's files. If they live somewhere on your `sandbox.denyRead` list, re-allow that one folder with `sandbox.allowRead`.
- **"No test proves the change"**: the model's test passes on the old code too, or the change has no test.
- **"Checks did not run"**: the pull request got no checks on GitHub. The job never merges without them.

## Stop everything

```sh
node scripts/install-schedule.mjs remove   # no more nightly runs
```

A run in progress can be stopped by ending its process. The next run clears its lock. Pull requests it opened stay open; removing a project in the app lists them.

To take away its ability to change a repository, remove the project in the app.
