# NotMyToken

A public registry of reusable **artifacts** — components, snippets, prompts,
templates — with a static gallery for humans and a remote **MCP server** so LLMs
(Claude & friends) can search, fetch, and submit artifacts mid-conversation.

This is **Option 1 — fully serverless**: nothing runs on your own hardware.

```
┌──────────────┐     reads      ┌──────────────────────┐
│ Static gallery│ ─────────────▶ │  GitHub repo          │
│ (Pages/Vercel)│   index.json   │  artifacts/<id>/...   │  ◀── source of truth
└──────────────┘                 │  + meta.json          │
                                  └──────────┬───────────┘
┌──────────────┐  MCP over HTTP    reads ▲   │ uploads = PR
│ Claude / LLM │ ───────────────▶ ┌───────┴───┴──────────┐
└──────────────┘   /mcp           │ MCP server (CF Worker)│
                                  └──────────────────────┘
```

- **Storage** = a GitHub repo. One folder per artifact: content files + a
  normalized `meta.json`.
- **Search index** = `index.json`, generated from `artifacts/` by CI on every push.
- **Gallery** = static HTML/JS reading `index.json` (deploy to Cloudflare Pages
  or GitHub Pages).
- **MCP server** = a Cloudflare Worker exposing 3 tools. Reads go to
  `raw.githubusercontent.com` (no token). Uploads open a **pull request** —
  nothing is merged without review.

## Layout

```
artifacts/<id>/meta.json    # normalized metadata (see schema/meta.schema.json)
artifacts/<id>/<files>      # the actual content
schema/meta.schema.json     # JSON Schema for meta.json
scripts/build-index.mjs     # artifacts/ -> index.json (validates as it goes)
scripts/dev-server.mjs      # local static server for the gallery
web/                        # the static gallery
mcp-server/                 # Cloudflare Worker (remote MCP, Streamable HTTP)
index.json                  # generated; committed by CI
```

## Add an artifact

1. Create `artifacts/<id>/` with your files and a `meta.json` (validate against
   `schema/meta.schema.json`). `id` must equal the folder name.
2. `npm run build:index` to regenerate and validate `index.json`.
3. Open a PR. CI fails the PR if `index.json` is stale.

LLMs can do this for you via the `upload_artifact` tool (it opens the PR).

## Run the gallery locally

```bash
npm run serve:web      # builds the index, serves http://localhost:5173
```

To host the gallery separately from the repo, set `window.NMT_INDEX_URL` in
`web/index.html` to the raw URL of `index.json`.

## Deploy the MCP server

```bash
cd mcp-server
npm install
# edit wrangler.toml: GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH
npm run deploy
# optional, to enable uploads (fine-grained PAT: Contents + Pull requests RW):
wrangler secret put GITHUB_TOKEN
```

Your endpoint is then `https://notmytoken-mcp.<subdomain>.workers.dev/mcp`.

### Connect from Claude

Add it as a remote MCP server (Streamable HTTP), e.g. with Claude Code:

```bash
claude mcp add --transport http notmytoken https://notmytoken-mcp.<subdomain>.workers.dev/mcp
```

### Tools

| Tool | Purpose |
|------|---------|
| `search_artifacts` | Search by query / type / tags. Returns summaries. |
| `get_artifact` | Fetch one artifact by id, with full file contents. |
| `upload_artifact` | Submit a new artifact — opens a PR (needs `GITHUB_TOKEN`). |

## Test the MCP server

```bash
cd mcp-server && npm test   # mocks GitHub, drives the JSON-RPC handler
```

## Roadmap

- Phase 2: richer search (embeddings), previews, dependency resolution.
- The repo-as-backend keeps everything versioned, transparent, and free to host.
