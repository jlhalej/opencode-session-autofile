# Advanced configuration

These options exist for edge cases and non-default setups. Most users only need `apiBaseUrl` and `mappings`, documented in the [README](README.md).

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Kill switch for filing. When `false`, the title-tagging prompt still loads (titles keep getting tagged), but the plugin never moves sessions between folders. |
| `titlePrompt` | Built-in tagging prompt (see `src/index.ts`) | Full replacement for the prompt injected into OpenCode's native `title` agent. Use this if you want a different tagging scheme than the plugin's default domain list, or want to fold the tagging instructions into a larger custom prompt. If you replace it, make sure your prompt still ends titles with a bracketed tag your `mappings` recognizes. |
| `fallbackMaxAttempts` | `3` | Max bounded re-checks of a session's title on `session.idle`, used only when the primary `session.updated` filing was missed. Integer, `1`-`10`. |
| `fallbackDelayMs` | `500` | Delay between fallback re-checks, in milliseconds. `0`-`5000`. |
| `reconcileIntervalMs` | `600000` (10 minutes) | How often the periodic reconciliation sweep runs, in milliseconds. `60000`-`86400000` (1 minute to 24 hours); an out-of-range or non-numeric value falls back to the default. The first sweep runs ~20 seconds after the plugin loads, not immediately. |

```json
{
  "enabled": true,
  "titlePrompt": "Your custom prompt text, ending titles with a bracketed tag...",
  "fallbackMaxAttempts": 5,
  "fallbackDelayMs": 750,
  "reconcileIntervalMs": 300000
}
```

## Periodic reconciliation details

**Not active in `0.5.0+` (OpenCode 2).** This whole section describes `0.4.1`'s (OpenCode 1.x) behavior, kept here because the same logic is still present internally in `0.5.0+`, gated behind a runtime check for `session.list` on the plugin context — which the installed `@opencode/plugin@2.0.25` does not provide. It will activate automatically, with everything below applying again unchanged, if a future release restores that method. See the README's Compatibility section.

Unlike the `session.updated`/`session.idle` paths, which only ever act on a session at the moment its title changes, the periodic sweep is tag-authoritative: on every tick it lists every session in the project — including child/subagent sessions, not just top-level ones — and for every one whose title carries a mapped tag, it checks whether the session is currently filed under the matching folder. If not — including a session someone dragged into a different folder by hand, or one whose primary filing event was missed entirely — it moves it. Sessions with no tag, or a tag with no configured mapping, are never touched by the sweep, consistent with the rest of the plugin: filing is one-directional, sessions are never removed from a folder except by being moved to another one.

Notes and limits:

- **Scope: every session, whole project.** The sweep calls `client.session.list` with `scope: "project"`, which (confirmed by reading opencode v1.18.32's actual session-list handler and service, since the installed SDK's generated type only documents a plain `directory` filter) tells the server to ignore the per-instance directory and return every session belonging to the project — including sessions in every git worktree of that project, not just this plugin instance's own `input.directory`, and including child/subagent sessions. Each matched session is filed under its own `directory` field, the same key the event-driven paths have always used as the OpenChamber folder scope. Not independently verified in this change: whether that key matches the scope key OpenChamber's sidebar UI groups worktree sessions under, and whether every worktree of a repo is always registered as sessions of one shared "project" server-side rather than as separate projects (if the latter, a worktree that's its own project is reconciled by its own plugin instance instead, same as before this change).
- **Requires server support for `scope`/`limit`.** These were confirmed against opencode v1.18.32's source. This plugin's declared peer range (`@opencode-ai/plugin >=1.18.0`) is wider than that one confirmed version, and the underlying request schema (Effect Schema) silently drops query keys it doesn't recognize rather than erroring. Against an older server that predates these fields, the sweep would silently fall back to whatever plain `directory`-filtered, ~100-session default that server's `/session` route uses — the plugin has no way to detect that downgrade from the response alone.
- **Archived sessions are skipped.** A session with a `time.archived` timestamp is left alone by the sweep (this field isn't in every published SDK type but is present on the session objects the server actually sends).
- **List size — genuinely bounded, not "all sessions".** `/session` defaults to returning at most 100 sessions server-side (most-recently-updated first) and has no page cursor for going past that — confirmed by reading the actual `Session.list`/`listByProject` implementation. The sweep asks for up to 200 first; if a project has at least that many sessions (root and child combined), it asks once more for up to 5,000. That ceiling is deliberately generous — a long-lived, actively-used project can accumulate a four-figure session count well before this plugin is ever uninstalled — but it is still a hard cap, not "every session that exists." If even 5,000 comes back exactly full, the plugin logs a loud warning, on every tick where it happens, that that tick's coverage is **not** guaranteed complete, rather than silently treating whatever it fetched as everything. There is no way for this plugin to page past that ceiling in a single `/session` request; a project that outgrows it needs a different enumeration strategy than this plugin currently implements.
- **Bounded writes per tick.** To avoid one sweep doing unbounded work, at most 25 sessions are actually moved per tick; any remaining misfiled sessions are left for the next tick rather than dropped. Scanning and classifying (no writes) isn't bounded, since it's cheap and purely local.
- **Freshness.** Immediately before writing, the sweep re-reads each candidate session's live title and re-classifies it, so a title changed by the primary event path during the sweep isn't overwritten with the stale tag from the sweep's own snapshot.
- **Kill switch.** Setting `enabled: false` disables the periodic sweep along with the rest of the plugin's filing behavior (the title-tagging prompt still loads).
