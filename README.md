# opencode-session-log

`opencode-session-log` is an OpenCode plugin that writes session artifacts to `./.agents-log` with a structure aligned to the Claude-side session logger.

It generates:

```text
.agents-log/
├── summary/<yyyy-mm-dd_hh-mm-ss>/
│   ├── summary.md
│   ├── usage.json
│   └── agents/
│       ├── main/
│       │   ├── summary.md
│       │   └── usage.json
│       └── <agentKey>/
│           ├── summary.md
│           └── usage.json
└── meta/
    ├── index.md
    ├── state/<session_id>.json
    └── sessions/YYYY/MM/<session_id>/
        ├── index.md
        ├── merged/session.md
        ├── agents/<agentKey>/session.md
        └── artifacts/
```

## Install

Add the npm package name to your OpenCode config:

```json
{
  "plugin": ["opencode-session-log"]
}
```

OpenCode installs npm plugins automatically on startup.

Project-level config:

- `.opencode/opencode.json`

Global config:

- `~/.config/opencode/opencode.json`

## Automated npm Publishing

This repo is configured to publish from GitHub Actions. You do not need your own server.

The publish workflow runs when you push a tag like:

```bash
git tag v0.1.7
git push origin v0.1.7
```

Before the publish step, GitHub Actions will:

- install dependencies
- run `npm test`
- verify that the tag version matches `package.json`

### One-time GitHub setup

Add this repository secret:

- `NPM_TOKEN`

The token should be an npm publish token with permission to publish this package. If your npm account enforces 2FA for publishing, use a token that supports publish without interactive OTP.

### Release flow

1. Update `package.json` version
2. Commit and push `main`
3. Create and push a matching tag:

```bash
git tag v0.1.7
git push origin main --tags
```

GitHub Actions will publish that exact version to npm.

## What It Captures

- Session-level summary and usage
- Per-agent summaries for `main` and child sessions
- Merged detailed timeline
- Per-agent detailed logs
- Tool calls, tool results, reasoning, assistant output
- Session state and rendered sidecar artifacts

## Output Root

The plugin always writes into:

```text
./.agents-log
```

This keeps OpenCode logs separate from Claude-side `.claude-log` output.

## Notes

- Child sessions are emitted as separate agent directories.
- When the live SDK snapshot is incomplete, the plugin falls back to the local OpenCode SQLite database to keep output stable.
- The session root `summary.md` is an overview page; full detail lives under `agents/*` and `meta/.../merged/session.md`.

## Development

```bash
npm test
```
