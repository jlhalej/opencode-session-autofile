# Advanced options

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Kill switch for filing and the sweep. The title-tagging prompt still loads. |
| `apiBaseUrl` | `http://localhost:3000` | OpenChamber web server. Used for the folder API and for listing sessions. |
| `dryRun` | `false` | Log and record what would move; never write. The sweep's plan lands in `/tmp/opencode-session-autofile/sweep-<pid>.json` under `wouldMove`.|
| `includeSubagents` | `true` | Subagent sessions are filed with their root session. `false` leaves them alone. |
| `titlePrompt` | generated from the rules | Full replacement for the title prompt. If you set it, it must still end titles with a tag your rules know. |
| `fallbackMaxAttempts` | `3` | Re-checks of a session's title after a turn ends. `1`-`10`. |
| `fallbackDelayMs` | `500` | Delay between those re-checks. `0`-`5000`. |
| `reconcileIntervalMs` | `600000` | Sweep interval, `60000`-`86400000`. |

## The `current_session` tool (0.7.0+)

Takes no input and returns `ok: true` with the calling session's own id (confirmed through `ctx.session.get`), title, directory, `isChild` and `archived`, plus `workspaceID`/`parentID` when present. It is registered before `enabled` is read, so it stays available with `enabled: false` (that option only stops filing and the sweep) and when the rules file is broken. It never searches by title, never reads env/logs, and returns `{ ok: false, reason, guidance }` instead of throwing.

## Sweep details

- Sessions come from `GET /api/session`, walked page by page (200 per page). The last page still carries a `cursor.next`, so the walk also stops on an empty page or a repeated cursor. At most 5,000 sessions are scanned per pass; if that cap is hit it is logged and recorded as `truncated`.
- Sessions are filed under their own `location.directory`, the key OpenChamber uses for folders.
- At most 100 sessions are moved per pass, in one batched write; the rest wait for the next pass. Each candidate is re-read right before writing, so a title changed in the meantime is not overwritten with a stale decision.
- One sweep runs per OpenCode process, however many directories load the plugin. Two OpenCode processes against the same OpenChamber each run their own; moves are idempotent, so this is wasteful at worst.
- Status for operators: `/tmp/opencode-session-autofile/<pid>-<hash>.json` per directory (loaded rules, problems) and `sweep-<pid>.json` (last pass counts); set `AUTOFILE_DIAGNOSTIC_DIR` to move them.
