# opencode-session-autofile

An OpenCode plugin that files sessions into OpenChamber folders from controlled title prefixes. It injects a title prompt, listens to `session.updated`, and moves the exact session ID into the mapped folder. Missing mapped folders are created automatically.

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
| `mappings` | Built-in domain list | Exact title label to destination folder mapping. |
| `titlePrompt` | Built-in prefix prompt | Full replacement prompt for OpenCode's native `title` agent. |

Unknown labels and `[Unfiled]` do nothing. A mapped destination folder is created if it does not exist. Duplicate matching folder names are skipped safely. A filing failure never blocks the chat.

## Development

```bash
bun install
bun run typecheck
bun run build
```

OpenCode must be restarted after adding, removing, or changing a plugin.

## Compatibility

- OpenCode with plugin hooks and `session.updated` events.
- OpenChamber with the local `/api/session-folders` endpoint.
