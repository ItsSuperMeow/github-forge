// GitHub REST v3 handlers. All routes are under /api/v3.
// The store holds repos keyed by owner/name; the token's owner is bound lazily
// (see app.ts) because the bearer <redacted> names a login the entry cannot
// derive from the token value alone.
import { makeObject, buildCommit, ZERO_OID, isOid } from './git.ts';
import type { Repo, Store } from './store.ts';

export interface Ctx {
  store: Store;
  /** The login the bearer <redacted> names, once bound (null until the first owner-scoped access). */
  tokenOwner: string | null;
  setTokenOwner: (owner: string) => void;
  /** The request's parsed JSON body (undefined when absent/invalid). */
  body: unknown;
  /** Query parameters. */
  query: URLSearchParams;
  /** URL path segments after /api/v3. */
  segments: string[];
  /** The request's owner parameter (from the path), when present. */
  ownerParam: string | null;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const BOT_AUTHOR = 'forge <forge@localhost> 1700000000 +0000';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function notFound(message = 'Not Found'): Reply {
  return json(404, { message });
}

function badRequest(message: string): Reply {
  return json(400, { message });
}

function unprocessable(message: string): Reply {
  return json(422, { message });
}

/** Resolve a repo by owner/name, applying the lazy owner binding. Returns the repo or null. */
export function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const store = ctx.store;
  // Exact match first.
  const exact = store.getRepo(owner, name);
  if (exact) return exact;
  // The token's owner is not yet bound: a repo created via POST /user/repos
  // sits under the placeholder owner ''. The first owner-scoped access binds it.
  if (ctx.tokenOwner === null) {
    const placeholder = store.getRepo('', name);
    if (placeholder) {
      ctx.setTokenOwner(owner);
      // Move the repo to the bound owner.
      store.deleteRepo('', name);
      placeholder.owner = owner;
      store.repos.set(store.key(owner, name), placeholder);
      return placeholder;
    }
    // No repo at all under any owner with this name.
    return null;
  }
  // Token owner is bound: only that owner's repos are visible.
  return null;
}

/** The repo for a request, or null when the owner does not match / the repo is absent. */
function repoOrNull(ctx: Ctx, owner: string, name: string): Repo | null {
  return resolveRepo(ctx, owner, name);
}

/** GitHub repository JSON shape. */
export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: `R_${repo.databaseId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.databaseId, type: 'User' },
    private: repo.private,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    default_branch: repo.default_branch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number], baseUrl: string): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: `I_${repo.databaseId}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => ({ name: l })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    user: { login: repo.owner, id: repo.databaseId, type: 'User' },
    assignee: null,
    assignees: [],
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number], baseUrl: string): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: `PR_${repo.databaseId}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: !pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.merged ? pull.merged_at : pull.state === 'closed' ? pull.updated_at : null,
    user: { login: repo.owner, id: repo.databaseId, type: 'User' },
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  let author = '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const m = author.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  const name = m ? m[1] : author;
  const email = m ? m[2] : '';
  const date = m ? new Date(parseInt(m[3], 10) * 1000).toISOString() : repo.created_at;
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: { name, email, date },
      committer: { name, email, date },
      message: message.replace(/\n$/, ''),
      tree: { sha: tree },
    },
    author: { login: repo.owner, id: repo.databaseId, type: 'User' },
    committer: { login: repo.owner, id: repo.databaseId, type: 'User' },
    parents: parents.map((p) => ({ sha: p })),
    html_url: '',
    url: '',
  };
}

/** Parse a JSON body; returns {ok:false} when the body is present but malformed. */
export function parseBody(raw: Buffer): { ok: boolean; value: unknown } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Build a Link header for pagination. */
function linkHeader(baseUrl: string, path: string, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const next = `${baseUrl}${path}?page=${page + 1}&per_page=${perPage}`;
  const last = `${baseUrl}${path}?page=${lastPage}&per_page=${perPage}`;
  return `<${next}>; rel="next", <${last}>; rel="last"`;
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/**
 * Dispatch a REST request. `segments` are the path parts after /api/v3.
 * Returns a Reply, or null when the route is not a REST route.
 */
export function handleRest(ctx: Ctx, method: string, baseUrl: string): Reply | null {
  const s = ctx.segments;
  const q = ctx.query;
  const body = asRecord(ctx.body);

  // GET /api/v3/ (root) and /api/v3/meta
  if (s.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: `${baseUrl}/api/v3/user`, rate_limit_url: `${baseUrl}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return null;
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method === 'GET') return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return null;
  }
  if (s.length === 1 && s[0] === 'rate_limit') {
    if (method === 'GET') return json(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1700000000 } }, rate: { limit: 5000, remaining: 4999, reset: 1700000000 } });
    return null;
  }

  // /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) return unprocessable('name is required');
      const owner = ctx.tokenOwner ?? '';
      if (ctx.store.getRepo(owner, name)) return unprocessable('Repository already exists');
      const repo = ctx.store.createRepo(owner, name, {
        description: str(body.description),
        private: bool(body.private),
        default_branch: str(body.default_branch, 'main') || 'main',
      });
      return json(201, repoJson(repo, baseUrl));
    }
    if (method === 'GET') {
      const owner = ctx.tokenOwner ?? '';
      const repos = ctx.store.listRepos(owner);
      const { page, perPage } = pageOf(q);
      const headers: Record<string, string> = {};
      const link = linkHeader(baseUrl, '/api/v3/user/repos', page, perPage, repos.length);
      if (link) headers.link = link;
      return json(200, paginate(repos, page, perPage).map((r) => repoJson(r, baseUrl)), headers);
    }
    return null;
  }

  // /user (GET current user)
  if (s.length === 1 && s[0] === 'user') {
    if (method === 'GET') {
      const login = ctx.tokenOwner ?? 'owner';
      return json(200, { login, id: 1, type: 'User', html_url: `${baseUrl}/${login}` });
    }
    return null;
  }

  // /repos/{owner}/{repo}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const repoName = s[2];
    const rest = s.slice(3);

    // POST /repos/{o}/{r}/git/refs (create a branch ref)
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref || !sha || !isOid(sha)) return unprocessable('ref and sha are required');
      if (!repo.objects.has(sha)) return unprocessable('object does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit', url: '' } });
    }

    // GET /repos/{o}/{r}/git/refs/{ref...} (read a ref)
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const refName = rest.slice(2).join('/');
      const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
      const oid = repo.refs.get(full);
      if (!oid) return notFound();
      return json(200, { ref: full, object: { sha: oid, type: 'commit', url: '' } });
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const branches: Record<string, unknown>[] = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      const { page, perPage } = pageOf(q);
      return json(200, paginate(branches, page, perPage));
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const shaParam = q.get('sha');
      let startOid: string | undefined;
      if (shaParam) {
        if (repo.refs.has(`refs/heads/${shaParam}`)) startOid = repo.refs.get(`refs/heads/${shaParam}`);
        else if (repo.refs.has(shaParam)) startOid = repo.refs.get(shaParam);
        else if (isOid(shaParam)) startOid = shaParam;
        else return json(200, []);
      } else {
        startOid = repo.refs.get(`refs/heads/${repo.default_branch}`);
      }
      const out: Record<string, unknown>[] = [];
      if (startOid) {
        const seen = new Set<string>();
        const stack = [startOid];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const c = commitJson(repo, oid);
          if (!c) continue;
          out.push(c);
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'commit') {
            const text = obj.data.toString('utf8');
            const sep = text.indexOf('\n\n');
            const header = sep >= 0 ? text.slice(0, sep) : text;
            for (const line of header.split('\n')) {
              if (line.startsWith('parent ')) stack.push(line.slice(7).trim());
            }
          }
        }
      }
      const { page, perPage } = pageOf(q);
      return json(200, paginate(out, page, perPage));
    }

    // GET /repos/{o}/{r}/commits/{sha}
    if (rest.length === 2 && rest[0] === 'commits' && method === 'GET') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const c = commitJson(repo, rest[1]);
      if (!c) return notFound();
      return json(200, c);
    }

    // contents: GET/PUT/DELETE /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      const path = rest.slice(1).join('/');
      // The branch may arrive as a `branch` field in the JSON body (the
      // suite's putContent sends it there) or as a `?ref=` query parameter.
      const bodyBranch = typeof body.branch === 'string' ? body.branch : '';
      const ref = bodyBranch || q.get('ref') || repo.default_branch;
      const refName = `refs/heads/${ref}`;
      if (method === 'GET') {
        const dir = ctx.store.listDirAtRef(repo, refName, path);
        if (dir) {
          return json(200, dir.map((e) => ({
            type: e.type === 'tree' ? 'dir' : 'file',
            name: e.name,
            path: path ? `${path}/${e.name}` : e.name,
            sha: e.oid,
            size: 0,
            url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${path ? `${path}/` : ''}${e.name}`,
            html_url: '',
            git_url: '',
            download_url: null,
          })));
        }
        const file = ctx.store.readFileAtRef(repo, refName, path);
        if (!file) return notFound();
        return json(200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: file.data.length,
          encoding: 'base64',
          content: file.data.toString('base64'),
          url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: '',
          git_url: '',
          download_url: null,
        });
      }
      if (method === 'PUT') {
        const contentB64 = str(body.content);
        const message = str(body.message, 'Update file');
        const sha = str(body.sha);
        if (!contentB64) return unprocessable('content is required');
        const content = Buffer.from(contentB64, 'base64');
        const existing = ctx.store.readFileAtRef(repo, refName, path);
        if (existing) {
          if (!sha) return unprocessable('sha is required to update a file');
          if (sha !== existing.oid) return json(409, { message: 'sha does not match' });
          const result = ctx.store.commitFile(repo, ref, path, content, message);
          if (!result) return notFound();
          return json(200, {
            content: { name: path.split('/').pop(), path, sha: result.blobOid, size: content.length, encoding: 'base64' },
            commit: { sha: result.commitOid, message },
          });
        }
        const result = ctx.store.commitFile(repo, ref, path, content, message);
        if (!result) return notFound();
        return json(201, {
          content: { name: path.split('/').pop(), path, sha: result.blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: result.commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const message = str(body.message, 'Delete file');
        const sha = str(body.sha);
        const existing = ctx.store.readFileAtRef(repo, refName, path);
        if (!existing) return notFound();
        if (sha && sha !== existing.oid) return json(409, { message: 'sha does not match' });
        const result = ctx.store.commitFile(repo, ref, path, null, message);
        if (!result) return notFound();
        return json(200, { commit: { sha: result.commitOid, message } });
      }
      return null;
    }

    // labels: POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      if (method === 'POST') {
        const name = str(body.name);
        if (!name) return unprocessable('name is required');
        const label = { name, color: str(body.color, 'ededed'), description: str(body.description) };
        repo.labels.set(name, label);
        return json(201, label);
      }
      if (method === 'GET') {
        return json(200, [...repo.labels.values()]);
      }
      return null;
    }

    // issues
    if (rest.length >= 1 && rest[0] === 'issues') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      // POST /repos/{o}/{r}/issues
      if (rest.length === 1 && method === 'POST') {
        const title = str(body.title);
        if (!title) return unprocessable('title is required');
        const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return unprocessable(`label does not exist: ${l}`);
        }
        const now = new Date().toISOString();
        const issue = {
          number: repo.nextIssueNumber++,
          title,
          body: str(body.body),
          state: 'open' as const,
          labels,
          comments: [],
          created_at: now,
          updated_at: now,
          closed_at: null as string | null,
        };
        repo.issues.push(issue);
        return json(201, issueJson(repo, issue, baseUrl));
      }
      // GET /repos/{o}/{r}/issues
      if (rest.length === 1 && method === 'GET') {
        let list = [...repo.issues];
        const state = q.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        if (sort === 'created') {
          list.sort((a, b) => {
            const d = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
            return direction === 'asc' ? d : -d;
          });
        }
        const { page, perPage } = pageOf(q);
        return json(200, paginate(list, page, perPage).map((i) => issueJson(repo, i, baseUrl)));
      }
      // /issues/{n}
      const num = parseInt(rest[1] ?? '', 10);
      if (rest.length >= 2 && Number.isFinite(num)) {
        const issue = repo.issues.find((i) => i.number === num);
        if (!issue) return notFound();
        // GET /issues/{n}
        if (rest.length === 2 && method === 'GET') return json(200, issueJson(repo, issue, baseUrl));
        // PATCH /issues/{n}
        if (rest.length === 2 && method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.closed_at = body.state === 'closed' ? new Date().toISOString() : null;
          }
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((l): l is string => typeof l === 'string');
            for (const l of labels) if (!repo.labels.has(l)) return unprocessable(`label does not exist: ${l}`);
            issue.labels = labels;
          }
          issue.updated_at = new Date().toISOString();
          return json(200, issueJson(repo, issue, baseUrl));
        }
        // /issues/{n}/comments
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'POST') {
            const cbody = str(body.body);
            if (!cbody) return unprocessable('body is required');
            const now = new Date().toISOString();
            const comment = { id: repo.nextCommentId++, body: cbody, created_at: now, updated_at: now };
            issue.comments.push(comment);
            return json(201, { id: comment.id, body: comment.body, created_at: comment.created_at, updated_at: comment.updated_at, user: { login: repo.owner, id: repo.databaseId, type: 'User' }, html_url: '', url: '' });
          }
          if (method === 'GET') {
            return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, updated_at: c.updated_at, user: { login: repo.owner, id: repo.databaseId, type: 'User' }, html_url: '', url: '' })));
          }
        }
        return null;
      }
      return null;
    }

    // pulls
    if (rest.length >= 1 && rest[0] === 'pulls') {
      const repo = repoOrNull(ctx, owner, repoName);
      if (!repo) return notFound();
      // POST /repos/{o}/{r}/pulls
      if (rest.length === 1 && method === 'POST') {
        const title = str(body.title);
        const head = str(body.head);
        const base = str(body.base, repo.default_branch);
        if (!title || !head) return unprocessable('title and head are required');
        const headOid = repo.refs.get(`refs/heads/${head}`);
        const baseOid = repo.refs.get(`refs/heads/${base}`);
        if (!headOid || !baseOid) return unprocessable('head or base branch does not exist');
        const now = new Date().toISOString();
        const pull = {
          number: repo.nextPullNumber++,
          title,
          body: str(body.body),
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
        return json(201, pullJson(repo, pull, baseUrl));
      }
      // GET /repos/{o}/{r}/pulls
      if (rest.length === 1 && method === 'GET') {
        let list = [...repo.pulls];
        const state = q.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const { page, perPage } = pageOf(q);
        return json(200, paginate(list, page, perPage).map((p) => pullJson(repo, p, baseUrl)));
      }
      const num = parseInt(rest[1] ?? '', 10);
      if (rest.length >= 2 && Number.isFinite(num)) {
        const pull = repo.pulls.find((p) => p.number === num);
        if (!pull) return notFound();
        // GET /pulls/{n}
        if (rest.length === 2 && method === 'GET') return json(200, pullJson(repo, pull, baseUrl));
        // GET /pulls/{n}/files
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const files = pullFiles(ctx.store, repo, pull);
          return json(200, files);
        }
        // PUT /pulls/{n}/merge
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull.merged || pull.state === 'closed') return json(405, { message: 'Pull request is already merged or closed' });
          const headOid = repo.refs.get(`refs/heads/${pull.head}`);
          const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
          if (!headOid || !baseOid) return notFound();
          const merge = ctx.store.squashMerge(repo, baseOid, headOid);
          if (!merge) return json(405, { message: 'Merge conflict' });
          const message = str(body.commit_message, `Merge pull request #${pull.number} from ${pull.head}`);
          const commit = makeObject('commit', buildCommit({
            tree: merge.treeOid,
            parents: [baseOid, headOid],
            author: BOT_AUTHOR,
            committer: BOT_AUTHOR,
            message,
          }));
          ctx.store.putObject(repo, commit);
          repo.refs.set(`refs/heads/${pull.base}`, commit.oid);
          pull.merged = true;
          pull.state = 'closed';
          pull.merged_at = new Date().toISOString();
          pull.merge_commit_sha = commit.oid;
          pull.updated_at = new Date().toISOString();
          return json(200, { sha: commit.oid, merged: true, message: 'Pull Request successfully merged' });
        }
        return null;
      }
      return null;
    }

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      const repo = repoOrNull(ctx, owner, repoName);
      if (method === 'GET') {
        if (!repo) return notFound();
        return json(200, repoJson(repo, baseUrl));
      }
      if (method === 'PATCH') {
        if (!repo) return notFound();
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string') repo.default_branch = body.default_branch;
        repo.updated_at = new Date().toISOString();
        return json(200, repoJson(repo, baseUrl));
      }
      if (method === 'DELETE') {
        if (!repo) return notFound();
        ctx.store.deleteRepo(repo.owner, repo.name);
        return { status: 204, body: null };
      }
      return null;
    }
    return null;
  }

  return null;
}

/** The files changed by a pull request (head vs base), with GitHub's file shape. */
function pullFiles(store: Store, repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown>[] {
  const headOid = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headCommit = repo.objects.get(headOid);
  const baseCommit = repo.objects.get(baseOid);
  if (!headCommit || !baseCommit) return [];
  const headTree = parseCommitTree(headCommit.data);
  const baseTree = parseCommitTree(baseCommit.data);
  const headFiles = store.flattenTree(repo, headTree);
  const baseFiles = store.flattenTree(repo, baseTree);
  const out: Record<string, unknown>[] = [];
  const allPaths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const p of [...allPaths].sort()) {
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    if (h && b && h.oid === b.oid) continue;
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    const additions = status === 'removed' ? 0 : 1;
    const deletions = status === 'added' ? 0 : 1;
    out.push({
      sha: (h ?? b)!.oid,
      filename: p,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}

function parseCommitTree(data: Buffer): string {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
    if (line === '') break;
  }
  return '';
}
