/**
 * NotMyToken — remote MCP server (Cloudflare Worker).
 *
 * Exposes the artifact registry to LLMs over the MCP Streamable HTTP transport
 * (stateless mode: each request is a self-contained JSON-RPC call to POST /mcp).
 *
 * Source of truth is a GitHub repo:
 *   - reads go to raw.githubusercontent.com (no token needed for public repos)
 *   - uploads open a pull request via the GitHub REST API (needs GITHUB_TOKEN)
 *
 * Tools: search_artifacts, get_artifact, upload_artifact.
 */

export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string; // default branch, e.g. "main"
  GITHUB_TOKEN?: string; // secret; only required for upload_artifact
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "notmytoken", version: "0.1.0" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        name: SERVER_INFO.name,
        description: "Remote MCP server for the NotMyToken artifact registry.",
        mcpEndpoint: "/mcp",
        repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
      });
    }

    if (url.pathname === "/mcp") {
      if (request.method === "GET") {
        // No server-initiated streams in stateless mode.
        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }
      return handleMcp(request, env);
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC / MCP dispatch
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

async function handleMcp(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  // Notifications (no id) get acknowledged with 202 and no body.
  const isNotification = body.id === undefined || body.id === null;

  try {
    switch (body.method) {
      case "initialize":
        return rpcResult(body.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
        return new Response(null, { status: 202, headers: CORS });

      case "ping":
        return rpcResult(body.id, {});

      case "tools/list":
        return rpcResult(body.id, { tools: TOOLS });

      case "tools/call": {
        const name = body.params?.name as string;
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        // Tool execution failures are reported as isError results (visible to
        // the model), not JSON-RPC protocol errors.
        try {
          return rpcResult(body.id, await callTool(name, args, env));
        } catch (err) {
          return rpcResult(body.id, toolError(err instanceof Error ? err.message : String(err)));
        }
      }

      default:
        if (isNotification) return new Response(null, { status: 202, headers: CORS });
        return rpcError(body.id, -32601, `Method not found: ${body.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rpcError(body.id ?? null, -32603, message);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_artifacts",
    description:
      "Search the NotMyToken registry for reusable artifacts (components, snippets, prompts, etc.). Returns matching summaries; use get_artifact to fetch full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over name, description and tags." },
        type: {
          type: "string",
          enum: ["component", "snippet", "prompt", "template", "dataset", "skill"],
          description: "Optional category filter.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags; an artifact must contain all of them." },
        limit: { type: "integer", description: "Max results (default 20).", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_artifact",
    description: "Fetch one artifact by id, including its metadata and the full text of every content file.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "The artifact id (slug)." } },
    },
  },
  {
    name: "upload_artifact",
    description:
      "Submit a new artifact to the registry. Opens a pull request for human review — it is NOT merged automatically. Requires the server to be configured with a GitHub token.",
    inputSchema: {
      type: "object",
      required: ["id", "name", "type", "version", "description", "tags", "entry", "files"],
      properties: {
        id: { type: "string", description: "Unique slug, lowercase kebab-case. Becomes the folder name." },
        name: { type: "string" },
        type: { type: "string", enum: ["component", "snippet", "prompt", "template", "dataset", "skill"] },
        version: { type: "string", description: "Semver, e.g. 1.0.0." },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        language: { type: "string" },
        license: { type: "string", description: "SPDX id, default MIT." },
        author: {
          type: "object",
          properties: { name: { type: "string" }, url: { type: "string" } },
        },
        entry: { type: "string", description: "Path of the main file (must appear in files[].path)." },
        files: {
          type: "array",
          minItems: 1,
          description: "Content files for the artifact.",
          items: {
            type: "object",
            required: ["path", "content"],
            properties: {
              path: { type: "string", description: "Relative path inside the artifact folder, e.g. Button.tsx." },
              content: { type: "string" },
            },
          },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>, env: Env) {
  switch (name) {
    case "search_artifacts":
      return toolText(await searchArtifacts(args, env));
    case "get_artifact":
      return toolText(await getArtifact(args, env));
    case "upload_artifact":
      return toolText(await uploadArtifact(args, env));
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

type IndexEntry = {
  id: string;
  name: string;
  type: string;
  version: string;
  description: string;
  tags: string[];
  language?: string;
  license?: string;
  entry: string;
  files: string[];
  path: string;
};

async function loadIndex(env: Env): Promise<IndexEntry[]> {
  const res = await fetch(rawUrl(env, "index.json"), { cf: { cacheTtl: 60 } } as RequestInit);
  if (!res.ok) throw new Error(`Could not load index.json (HTTP ${res.status}). Has CI generated it?`);
  const index = (await res.json()) as { artifacts?: IndexEntry[] };
  return index.artifacts ?? [];
}

async function searchArtifacts(args: Record<string, unknown>, env: Env) {
  const query = String(args.query ?? "").toLowerCase().trim();
  const type = args.type ? String(args.type) : undefined;
  const tags = Array.isArray(args.tags) ? (args.tags as string[]).map((t) => t.toLowerCase()) : [];
  const limit = Math.min(Number(args.limit ?? 20) || 20, 100);

  const terms = query.split(/\s+/).filter(Boolean);
  const results = (await loadIndex(env))
    .filter((a) => {
      if (type && a.type !== type) return false;
      if (tags.length && !tags.every((t) => (a.tags || []).map((x) => x.toLowerCase()).includes(t))) return false;
      if (terms.length) {
        const hay = [a.name, a.description, a.type, ...(a.tags || [])].join(" ").toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    })
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      version: a.version,
      description: a.description,
      tags: a.tags,
      language: a.language,
    }));

  return { count: results.length, results };
}

async function getArtifact(args: Record<string, unknown>, env: Env) {
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("id is required");

  const entry = (await loadIndex(env)).find((a) => a.id === id);
  if (!entry) throw new Error(`Artifact not found: ${id}`);

  const files: Record<string, string> = {};
  for (const file of entry.files) {
    const res = await fetch(rawUrl(env, `${entry.path}/${file}`));
    files[file] = res.ok ? await res.text() : `<<could not load: HTTP ${res.status}>>`;
  }

  return { ...entry, contents: files };
}

async function uploadArtifact(args: Record<string, unknown>, env: Env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("Uploads are disabled: this server has no GITHUB_TOKEN configured.");
  }

  const id = String(args.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
    throw new Error("id must be lowercase kebab-case (e.g. my-artifact).");
  }
  const incoming = (args.files ?? []) as Array<{ path: string; content: string }>;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new Error("files[] is required and must be non-empty.");
  }
  const entry = String(args.entry ?? "");
  if (!incoming.some((f) => f.path === entry)) {
    throw new Error(`entry "${entry}" must match one of files[].path.`);
  }

  // Refuse if the artifact already exists (consumers should bump or rename).
  const exists = (await loadIndex(env)).some((a) => a.id === id);
  if (exists) throw new Error(`An artifact with id "${id}" already exists. Pick a new id.`);

  const meta = {
    id,
    name: String(args.name),
    type: String(args.type),
    version: String(args.version),
    description: String(args.description),
    tags: (args.tags as string[]) ?? [],
    language: args.language ? String(args.language) : undefined,
    license: args.license ? String(args.license) : "MIT",
    author: args.author,
    entry,
    files: incoming.map((f) => f.path),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const folder = `artifacts/${id}`;
  const filesToCommit: Array<{ path: string; content: string }> = [
    { path: `${folder}/meta.json`, content: JSON.stringify(meta, null, 2) + "\n" },
    ...incoming.map((f) => ({ path: `${folder}/${f.path}`, content: f.content })),
  ];

  const branch = `submit/${id}-${Date.now()}`;
  const prUrl = await openPullRequest(env, {
    branch,
    files: filesToCommit,
    title: `Add artifact: ${meta.name} (${id})`,
    body: `Automated submission via the NotMyToken MCP server.\n\n- **type:** ${meta.type}\n- **tags:** ${meta.tags.join(", ")}\n\n${meta.description}`,
  });

  return { status: "pull_request_opened", id, branch, pullRequest: prUrl };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function rawUrl(env: Env, path: string): string {
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;
}

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "notmytoken-mcp",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed (${res.status}): ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Creates a branch, commits the files via the Git Data API, and opens a PR. */
async function openPullRequest(
  env: Env,
  opts: { branch: string; files: Array<{ path: string; content: string }>; title: string; body: string }
): Promise<string> {
  const base = env.GITHUB_BRANCH;

  // 1. Resolve the tip of the base branch.
  const baseRef = await gh(env, `/git/ref/heads/${base}`);
  const baseSha: string = baseRef.object.sha;
  const baseCommit = await gh(env, `/git/commits/${baseSha}`);
  const baseTreeSha: string = baseCommit.tree.sha;

  // 2. Create blobs + a new tree.
  const tree = [] as Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>;
  for (const file of opts.files) {
    const blob = await gh(env, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });

  // 3. Commit and point a new branch ref at it.
  const commit = await gh(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: opts.title, tree: newTree.sha, parents: [baseSha] }),
  });
  await gh(env, "/git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: commit.sha }),
  });

  // 4. Open the PR.
  const pr = await gh(env, "/pulls", {
    method: "POST",
    body: JSON.stringify({ title: opts.title, head: opts.branch, base, body: opts.body }),
  });
  return pr.html_url;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function toolText(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}
