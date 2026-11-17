// MCP (Model Context Protocol) over Streamable HTTP, JSON-RPC 2.0.
// Speaks the modern 2026-07-28 revision (server/discover, no handshake) and
// the legacy initialize handshake. Tools act on the same store as REST.
import { makeObject, buildCommit } from './git.ts';
import type { Repo, Store } from './store.ts';
import { resolveRepo } from './rest.ts';

export interface McpCtx {
  store: Store;
  tokenOwner: string | null;
  setTokenOwner: (owner: string) => void;
  baseUrl: string;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name owner/repo.' },
        state: { type: 'string', description: 'The state to filter by: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const BOT_AUTHOR = 'forge <forge@localhost> 1700000000 +0000';

/** Resolve owner/repo from tool arguments (supports full_name "owner/repo"). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (!owner) owner = parts[0];
      if (!repo) repo = parts[1];
    }
  }
  // Also accept `repository` as an alias for repo.
  if (!repo && typeof args.repository === 'string') repo = args.repository;
  return { owner, repo };
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.databaseId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pull.head,
    base: pull.base,
    head_sha: pull.headSha,
    base_sha: pull.baseSha,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function okResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Execute a tool call. Returns the tool result. */
function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): ToolResult {
  const lower = name.toLowerCase();
  const canonical = lower.includes('create_repo') ? 'create_repo'
    : lower.includes('get_repo') ? 'get_repo'
    : lower.includes('create_issue') ? 'create_issue'
    : lower.includes('list_issues') ? 'list_issues'
    : lower.includes('create_pull_request') ? 'create_pull_request'
    : lower.includes('merge_pull_request') ? 'merge_pull_request'
    : null;
  if (canonical === null) return errResult(`Unknown tool: ${name}`);

  if (canonical === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : (typeof args.repo === 'string' ? args.repo : '');
    if (!repoName) return errResult('Missing required argument: name');
    const owner = ctx.tokenOwner ?? '';
    if (ctx.store.getRepo(owner, repoName)) return errResult(`Repository ${repoName} already exists`);
    const repo = ctx.store.createRepo(owner, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: typeof args.private === 'boolean' ? args.private : false,
    });
    return okResult({ repository: repoJson(repo, ctx.baseUrl), ...repoJson(repo, ctx.baseUrl) });
  }

  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  const repo = resolveRepo(
    { store: ctx.store, tokenOwner: ctx.tokenOwner, setTokenOwner: ctx.setTokenOwner, body: undefined, query: new URLSearchParams(), segments: [], ownerParam: null },
    owner,
    repoName,
  );
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);

  if (canonical === 'get_repo') {
    return okResult({ repository: repoJson(repo, ctx.baseUrl), ...repoJson(repo, ctx.baseUrl) });
  }

  if (canonical === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    if (!title) return errResult('Missing required argument: title');
    const now = new Date().toISOString();
    const issue = {
      number: repo.nextIssueNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      comments: [],
      created_at: now,
      updated_at: now,
      closed_at: null as string | null,
    };
    repo.issues.push(issue);
    return okResult({ issue: issueJson(repo, issue), ...issueJson(repo, issue) });
  }

  if (canonical === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return okResult({ issues: list.map((i) => issueJson(repo, i)) });
  }

  if (canonical === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.default_branch;
    if (!title || !head) return errResult('Missing required argument: title and head');
    const headOid = repo.refs.get(`refs/heads/${head}`);
    const baseOid = repo.refs.get(`refs/heads/${base}`);
    if (!headOid || !baseOid) return errResult('head or base branch does not exist');
    const now = new Date().toISOString();
    const pull = {
      number: repo.nextPullNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      head,
      base,
      headSha: headOid,
      baseSha: baseOid,
      merged: false,
      merged_at: null as string | null,
      merge_commit_sha: null as string | null,
      created_at: now,
      updated_at: now,
    };
    repo.pulls.push(pull);
    return okResult({ pull_request: pullJson(repo, pull), ...pullJson(repo, pull) });
  }

  if (canonical === 'merge_pull_request') {
    const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
    if (!Number.isFinite(num)) return errResult('Missing required argument: pull_number');
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return errResult(`Pull request #${num} not found`);
    if (pull.merged || pull.state === 'closed') return errResult('Pull request is already merged or closed');
    const headOid = repo.refs.get(`refs/heads/${pull.head}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headOid || !baseOid) return errResult('head or base branch does not exist');
    const merge = ctx.store.squashMerge(repo, baseOid, headOid);
    if (!merge) return errResult('Merge conflict');
    const commit = makeObject('commit', buildCommit({
      tree: merge.treeOid,
      parents: [baseOid, headOid],
      author: BOT_AUTHOR,
      committer: BOT_AUTHOR,
      message: `Merge pull request #${pull.number} from ${pull.head}`,
    }));
    ctx.store.putObject(repo, commit);
    repo.refs.set(`refs/heads/${pull.base}`, commit.oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = new Date().toISOString();
    pull.merge_commit_sha = commit.oid;
    pull.updated_at = new Date().toISOString();
    return okResult({ pull_request: pullJson(repo, pull), merged: true, sha: commit.oid, ...pullJson(repo, pull) });
  }

  return errResult(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Handle one MCP request body (already parsed JSON, or null when unparsable).
 * Returns {status, body, headers}. The body is a JSON-RPC response object.
 */
export function handleMcp(ctx: McpCtx, rawBody: Buffer, isJson: boolean): { status: number; body: unknown } {
  if (!isJson) {
    // A body that is not JSON: HTTP 400 with -32700 (parse error).
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(rawBody.toString('utf8')) as JsonRpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  // server/discover (modern era)
  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': SUPPORTED_VERSIONS[0],
      },
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  // initialize (legacy handshake)
  if (method === 'initialize') {
    const paramsMeta = (params._meta ?? {}) as Record<string, unknown>;
    const requested = typeof paramsMeta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (paramsMeta['io.modelcontextprotocol/protocolVersion'] as string)
      : typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : SUPPORTED_VERSIONS[0];
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    return { status: 200, body: rpcResult(id, result) };
  }

  // notifications/initialized (legacy): no response body needed; answer 202 with empty result.
  if (method === 'notifications/initialized') {
    return { status: 202, body: {} };
  }

  // tools/list
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  // tools/call
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
    if (!name) {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: name is required') };
    }
    const known = TOOLS.some((t) => name.toLowerCase().includes(t.name) || t.name.includes(name.toLowerCase()));
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${name}`) };
    }
    const result = callTool(ctx, name, args);
    return { status: 200, body: rpcResult(id, result) };
  }

  // Unknown method.
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
