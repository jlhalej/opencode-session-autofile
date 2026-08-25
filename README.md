# opencode-session-autofile

An OpenCode plugin that files sessions into OpenChamber folders from controlled title tags. It injects a title prompt, listens to `session.updated`, and moves the exact session ID into the mapped folder. Titles use a suffix such as `French verb practice [Language]`. Missing mapped folders are created automatically.

If the `session.updated` delivery carrying the first real, tagged title is ever missed, a bounded `session.idle` fallback pulls the session's current title directly via the OpenCode client and retries filing a few times with a short delay before giving up.

## Install from the OpenChamber plugin screen

### From local path — available now

1. Build the repository: `bun install && bun run build`.
2. In **Add plugin**, choose **From local path**.
3. Set **Spec** to the absolute path to `dist/index.js`, for example:

   ```text
   /home/hugoj/github/opencode-session-autofile/dist/index.js
   ```

4. Select **User** to enable it for every local workspace, or **Project** for only the current workspace.
5. Optionally provide the JSON configuration below, then add the plugin and restart OpenCode.

### From npm — after publication

Once this package is published to npm, choose **From npm**, use `opencode-session-autofile@latest` as the **Spec**, provide options if desired, and restart OpenCode.

## Options JSON

```json
{
  "apiBaseUrl": "http://localhost:3000",
  "mappings": {
    "Language": { "folderName": "Language" },
    "Tech": { "folderName": "Tech" },
    "Sales": { "folderName": "Sales" }
  }
}
```

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Kill switch for filing; title prompt still loads. |
| `apiBaseUrl` | `http://localhost:3000` | OpenChamber API base URL. |
| `mappings` | Built-in domain list | Exact title-tag to destination-folder mapping. |
| `titlePrompt` | Built-in suffix prompt | Full replacement prompt for OpenCode's native `title` agent. |
| `fallbackMaxAttempts` | `3` | Max bounded re-checks of a session's title on `session.idle` if the primary `session.updated` filing was missed. |
| `fallbackDelayMs` | `500` | Delay between fallback re-checks, in milliseconds. |

Unknown labels and `[Unfiled]` do nothing. A mapped destination folder is created if it does not exist. Duplicate matching folder names are skipped safely. A filing failure never blocks the chat.

## Development

```bash
bun install
bun run typecheck
bun run build
```

OpenCode must be restarted after adding, removing, or changing a plugin.

## Compatibility

- OpenCode with plugin hooks and `session.updated`/`session.idle` events, plus a `PluginInput.client` exposing `session.get`.
- OpenChamber with the local `/api/session-folders` endpoint.
