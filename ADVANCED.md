# Advanced configuration

These options exist for edge cases and non-default setups. Most users only need `apiBaseUrl` and `mappings`, documented in the [README](README.md).

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Kill switch for filing. When `false`, the title-tagging prompt still loads (titles keep getting tagged), but the plugin never moves sessions between folders. |
| `titlePrompt` | Built-in tagging prompt (see `src/index.ts`) | Full replacement for the prompt injected into OpenCode's native `title` agent. Use this if you want a different tagging scheme than the plugin's default domain list, or want to fold the tagging instructions into a larger custom prompt. If you replace it, make sure your prompt still ends titles with a bracketed tag your `mappings` recognizes. |
| `fallbackMaxAttempts` | `3` | Max bounded re-checks of a session's title on `session.idle`, used only when the primary `session.updated` filing was missed. Integer, `1`-`10`. |
| `fallbackDelayMs` | `500` | Delay between fallback re-checks, in milliseconds. `0`-`5000`. |

```json
{
  "enabled": true,
  "titlePrompt": "Your custom prompt text, ending titles with a bracketed tag...",
  "fallbackMaxAttempts": 5,
  "fallbackDelayMs": 750
}
```
