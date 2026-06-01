## CutPro MCP

[![npm version](https://img.shields.io/npm/v/@cutpro/mcp?style=flat-square&color=7C3AED)](https://www.npmjs.com/package/@cutpro/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.getcutpro%2Fcutpro-7C3AED?style=flat-square)](https://registry.modelcontextprotocol.io)
[![smithery badge](https://smithery.ai/badge/contact-8lma/cutpro)](https://smithery.ai/servers/contact-8lma/cutpro)

A Model Context Protocol (MCP) server that turns long videos into viral clips with AI. It exposes the full [CutPro API](https://cut.pro/docs/api-reference) as tools, so an LLM can run the whole flow: analyze a video, clip the best moments, render the final MP4, and publish to TikTok, Instagram and YouTube.

### Key features

- **End to end**. All 34 v1 endpoints as tools: workspace, balance, videos, clipping, clips, templates, renders, posts and connections.
- **Token efficient**. Results are compact and projected to the fields that matter; `list_clips` is rating sorted, capped, and omits long signed URLs unless asked.
- **Runs everywhere**. stdio for local clients (Claude Code, Cursor, Claude Desktop, Windsurf, VS Code, Cline, Zed) and a hosted Streamable HTTP endpoint with OAuth for ChatGPT and Claude.ai.

## Getting started

### Requirements

- Node.js 18 or newer.
- A CutPro account on the **Pro** plan and an API key. Generate one at [cut.pro/studio/me/api-keys](https://cut.pro/studio/me/api-keys).
- An MCP-compatible client.

### Standard config

Most clients use the same JSON. Add your API key under `env`:

```json
{
  "mcpServers": {
    "cutpro": {
      "command": "npx",
      "args": ["-y", "@cutpro/mcp"],
      "env": { "CUTPRO_API_KEY": "<your-api-key>" }
    }
  }
}
```

### Install

[<img src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white" alt="Install in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522cutpro%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540cutpro%252Fmcp%2522%255D%257D)
[<img src="https://img.shields.io/badge/Cursor-Install_Server-000000?style=flat-square&logo=cursor&logoColor=white" alt="Install in Cursor">](https://cursor.com/en/install-mcp?name=cutpro&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjdXRwcm8vbWNwIl19)
[<img src="https://img.shields.io/badge/LM_Studio-Install_Server-4A26C9?style=flat-square" alt="Install in LM Studio">](https://lmstudio.ai/install-mcp?name=cutpro&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjdXRwcm8vbWNwIl19)
[<img src="https://img.shields.io/badge/Goose-Install_Server-1A1A1A?style=flat-square" alt="Install in Goose">](goose://extension?cmd=npx&arg=-y&arg=%40cutpro%2Fmcp&id=cutpro&name=CutPro&description=AI%20video%20clipping%20via%20the%20CutPro%20API)

After installing via a button, add your `CUTPRO_API_KEY` to the server's `env`.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add cutpro --env CUTPRO_API_KEY=<your-api-key> -- npx -y @cutpro/mcp
```
</details>

<details>
<summary>Claude Desktop</summary>

Add to `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "cutpro": {
      "command": "npx",
      "args": ["-y", "@cutpro/mcp"],
      "env": { "CUTPRO_API_KEY": "<your-api-key>" }
    }
  }
}
```
</details>

<details>
<summary>Cursor / Windsurf / VS Code (manual)</summary>

Add the standard config above to the client's MCP settings (`mcp.json` / `mcpServers`).
</details>

<details>
<summary>Cline</summary>

Open the MCP Servers panel, choose Configure, and add the standard config above.
</details>

<details>
<summary>Gemini CLI</summary>

```bash
gemini mcp add cutpro npx -y @cutpro/mcp -e CUTPRO_API_KEY=<your-api-key>
```
</details>

<details>
<summary>Codex</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.cutpro]
command = "npx"
args = ["-y", "@cutpro/mcp"]
env = { "CUTPRO_API_KEY" = "<your-api-key>" }
```
</details>

<details>
<summary>ChatGPT and Claude.ai (hosted, no install)</summary>

Use the hosted server. Add a custom connector pointing to:

```
https://mcp.cut.pro
```

You authorize with your CutPro API key on a consent page (OAuth), so no local setup is needed.
</details>

## Configuration

The server is configured with environment variables.

| Variable | Description | Required |
| --- | --- | --- |
| `CUTPRO_API_KEY` | Your CutPro API key (Pro plan). | Yes (stdio) |
| `CUTPRO_WORKSPACE_ID` | Selects the workspace for multi-workspace keys. | No |
| `CUTPRO_API_URL` | Override the API base URL. Defaults to `https://api.cut.pro/api/v1`. | No |

<details>
<summary>Self-hosting the remote (Streamable HTTP + OAuth)</summary>

| Variable | Description |
| --- | --- |
| `MCP_TRANSPORT=http` / `PORT` | Serve Streamable HTTP at the root instead of stdio. |
| `MCP_OAUTH=1` | Enable the full OAuth 2.1 layer (discovery, DCR, PKCE) for browser clients. |
| `MCP_PUBLIC_URL` | Public endpoint, e.g. `https://mcp.cut.pro`. Its origin becomes the OAuth issuer. |
| `MCP_REDIS_URL` | Back OAuth state with Redis so it survives restarts and scales across instances. |

```bash
MCP_TRANSPORT=http PORT=8787 MCP_OAUTH=1 \
MCP_PUBLIC_URL=https://mcp.cut.pro MCP_REDIS_URL=redis://127.0.0.1:6379 \
npx -y @cutpro/mcp
```

In OAuth mode the user authorizes with their own API key on a consent page; the access token maps server side to that key. Without `MCP_REDIS_URL`, an in-memory store is used (single instance, state lost on restart).
</details>

## Tools

<details>
<summary>Workspace and balance</summary>

- **get_workspace**: the workspace this key resolved to, with plan and role.
- **get_balance**: current credit balance.
- **get_balance_history**: ledger of credits added and consumed.
</details>

<details>
<summary>Videos and uploads</summary>

- **list_videos**: your source video library.
- **start_upload**: get a presigned URL to upload your own file (max 2 GB; .mp4/.mov/.webm/.mkv).
- **complete_upload**: register a finished upload and get its credit cost.
- **delete_video**: delete a source video and its submissions.
</details>

<details>
<summary>Clipping</summary>

- **analyze_video**: preview metadata and credit cost of a public URL (free).
- **submit_clipping**: start AI clipping (charges credits).
- **list_submissions**: clipping jobs for a video.
- **get_submission**: poll a submission until completed or failed.
- **delete_submission**: delete a submission and its clips.
</details>

<details>
<summary>Clips and templates</summary>

- **list_clips**: clips of a completed submission, rating sorted (URLs opt-in).
- **apply_template**: apply an editing template to clips in bulk.
- **delete_clip**: delete a single clip.
- **list_templates**: editing templates to apply to clips.
</details>

<details>
<summary>Renders</summary>

- **render_clip**: render a clip to a final MP4.
- **get_render**: poll a render until completed.
- **get_render_download**: signed download URL of a completed render.
- **cancel_render**: cancel or delete a render.
- **get_render_limits**: render quota for the workspace.
- **start_bulk_download** / **get_bulk_download**: bundle several renders into one download.
</details>

<details>
<summary>Posts and connections</summary>

- **create_post**: publish rendered clips to connected accounts (immediate or scheduled).
- **list_posts** / **get_post** / **update_post** / **delete_post**: manage posts.
- **publish_post**: trigger publishing now.
- **retry_post_item** / **delete_post_item**: handle individual targets.
- **list_connections** / **get_connection**: connected social accounts.
</details>

Each tool carries read-only / write / destructive annotations so clients can plan calls.

## Links

- Docs: [cut.pro/docs/api-reference/mcp](https://cut.pro/docs/api-reference/mcp)
- npm: [@cutpro/mcp](https://www.npmjs.com/package/@cutpro/mcp)
- MCP Registry: `io.github.getcutpro/cutpro`

## License

MIT
