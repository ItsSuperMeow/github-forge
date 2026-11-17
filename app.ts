// The forge's HTTP server: routes git smart HTTP, REST v3, GraphQL v4 and MCP.
// main.ts owns the lifecycle; this file owns the surface.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { handleRest, parseBody, type Ctx as RestCtx } from './rest.ts';
import { handleGraphQL, type GraphQLCtx } from './graphql.ts';
import { handleMcp, type McpCtx } from './mcp.ts';
import {
  advertiseV2,
  advertiseV0,
  handleUploadPackV2,
  handleUploadPackV0,
  handleReceivePack,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The single store for the process. */
const store = new Store();
/** The login the bearer <redacted> names, learned from the first owner-scoped access. */
let tokenOwner: string | null = null;

function setTokenOwner(owner: string): void {
  if (tokenOwner === null) tokenOwner = owner;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (cap 64 MiB). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Is this request authenticated? The health probe needs none; everything else does. */
function isAuthenticated(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local dev)
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${TOKEN}`;
}

function requestId(): string {
  return randomUUID();
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId() });
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const rid = requestId();

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const action = gitMatch[3];
    // Resolve the repo (applies the lazy owner binding).
    const repo = resolveGitRepo(owner, repoName);
    if (action === 'info/refs') {
      if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const proto = (req.headers['git-protocol'] ?? '') as string;
        if (proto.includes('version=2')) {
          sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBytes(res, 200, advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'service is required' });
      return;
    }
    if (action === 'git-upload-pack') {
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req);
      const proto = (req.headers['git-protocol'] ?? '') as string;
      const out = proto.includes('version=2') ? handleUploadPackV2(store, repo, body) : handleUploadPackV0(store, repo, body);
      sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    if (action === 'git-receive-pack') {
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req);
      const { response } = handleReceivePack(store, repo, body);
      sendBytes(res, 200, response, 'application/x-git-receive-pack-result');
      return;
    }
  }

  // --- GraphQL: POST /api/graphql
  if (path === '/api/graphql') {
    if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': rid }); return; }
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    let body: unknown = undefined;
    let ok = true;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      ok = false;
    }
    if (!ok) {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, { 'x-github-request-id': rid });
      return;
    }
    const gqlCtx: GraphQLCtx = { store, tokenOwner, setTokenOwner, baseUrl: baseUrlOf(req) };
    const result = handleGraphQL(gqlCtx, body);
    sendJson(res, 200, result, { 'x-github-request-id': rid });
    return;
  }

  // --- MCP: POST /mcp
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // Session teardown (legacy close): no session state is held.
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': rid }); return; }
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    const contentType = (req.headers['content-type'] ?? '') as string;
    const isJson = contentType.includes('application/json') || raw.length === 0 || looksLikeJson(raw);
    const mcpCtx: McpCtx = { store, tokenOwner, setTokenOwner, baseUrl: baseUrlOf(req) };
    const { status, body } = handleMcp(mcpCtx, raw, isJson);
    sendJson(res, status, body, { 'x-github-request-id': rid });
    return;
  }

  // --- REST v3: /api/v3/...
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': rid });
      return;
    }
    const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s.length > 0);
    // The root path '/api/v3/' has segments [] too.
    const ctx: RestCtx = {
      store,
      tokenOwner,
      setTokenOwner,
      body: parsed.value,
      query,
      segments,
      ownerParam: segments.length >= 3 && segments[0] === 'repos' ? segments[1] : null,
    };
    const reply = handleRest(ctx, method, baseUrlOf(req));
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
      return;
    }
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': rid, ...(reply.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, { 'x-github-request-id': rid, ...(reply.headers ?? {}) });
    return;
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
}

/** Resolve a git repo for smart HTTP, applying the lazy owner binding. */
function resolveGitRepo(owner: string, name: string): import('./store.ts').Repo | null {
  const exact = store.getRepo(owner, name);
  if (exact) return exact;
  if (tokenOwner === null) {
    const placeholder = store.getRepo('', name);
    if (placeholder) {
      setTokenOwner(owner);
      store.deleteRepo('', name);
      placeholder.owner = owner;
      store.repos.set(store.key(owner, name), placeholder);
      return placeholder;
    }
    return null;
  }
  return null;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  return `${proto}://${host}`;
}

function looksLikeJson(raw: Buffer): boolean {
  const text = raw.toString('utf8').trim();
  return text.startsWith('{') || text.startsWith('[');
}
