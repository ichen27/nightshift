# Contributing

## Reporting a problem

Open an issue with what you did, what you expected, what happened, and your Node version and operating system.

Do not describe an unfixed security weakness in a public issue. Use GitHub's private vulnerability reporting on this repository instead.

## Proposing a change

1. Branch from `main`.
2. Write or update a test first, then make the change.
3. Run `bash ci/run.sh` and make sure it passes.
4. Open a pull request that says what problem it solves, how the behaviour changes, and how you checked it.

Pull requests are merged after the `test` check passes. Read [AGENTS.md](AGENTS.md) for the project's conventions, including what must never be committed to this public repository.
