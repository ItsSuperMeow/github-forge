// In-memory store for the forge: repositories (with git objects + refs),
// issues, pull requests, labels. All state lives here; the trial is one process.
import { makeObject, parseTree, buildTree, buildCommit, ZERO_OID, isOid, type GitObject, type ObjType } from './git.ts';

export interface Label {
  name: string;
  color?: string;
  description?: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  // git state
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid (e.g. refs/heads/main)
  // issue tracker state
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  // database id (stable per repo, for GraphQL)
  databaseId: number;
}

let nextDatabaseId = 1;

/** Deterministic-ish timestamps: use a fixed base so exports are stable. */
export function nowIso(): string {
  return new Date().toISOString();
}

const BOT_AUTHOR = 'forge <forge@localhost> 1700000000 +0000';

export class Store {
  repos = new Map<string, Repo>(); // key: owner + '/' + name

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; default_branch?: string } = {}): Repo {
    const now = nowIso();
    const repo: Repo = {
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: now,
      updated_at: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      databaseId: nextDatabaseId++,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, obj: GitObject): void {
    repo.objects.set(obj.oid, obj);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** All objects reachable from a set of roots (for pack generation). */
  reachableObjects(repo: Repo, roots: string[]): GitObject[] {
    const out = new Map<string, GitObject>();
    const stack: string[] = [...roots];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const { tree, parents } = parseCommitLocal(obj.data);
        stack.push(tree);
        for (const p of parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
    return [...out.values()];
  }

  /** Read a file's content at a ref (branch) + path, from the git tree. */
  readFileAtRef(repo: Repo, ref: string, path: string): { oid: string; data: Buffer; mode: string } | undefined {
    const tip = repo.refs.get(ref);
    if (!tip) return undefined;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return undefined;
    const { tree } = parseCommitLocal(commit.data);
    return this.readFileAtTree(repo, tree, path.split('/').filter((s) => s.length > 0));
  }

  private readFileAtTree(repo: Repo, treeOid: string, parts: string[]): { oid: string; data: Buffer; mode: string } | undefined {
    if (parts.length === 0) return undefined;
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return undefined;
    const entries = parseTree(treeObj.data);
    const [head, ...rest] = parts;
    const entry = entries.find((e) => e.name === head);
    if (!entry) return undefined;
    if (rest.length === 0) {
      if (entry.mode === '40000') return undefined;
      const blob = repo.objects.get(entry.oid);
      if (!blob) return undefined;
      return { oid: entry.oid, data: blob.data, mode: entry.mode };
    }
    if (entry.mode !== '40000') return undefined;
    return this.readFileAtTree(repo, entry.oid, rest);
  }

  /** List a directory at a ref + path. Returns entries or undefined. */
  listDirAtRef(repo: Repo, ref: string, path: string): { mode: string; name: string; oid: string; type: 'blob' | 'tree' }[] | undefined {
    const tip = repo.refs.get(ref);
    if (!tip) return undefined;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return undefined;
    const { tree } = parseCommitLocal(commit.data);
    let treeOid = tree;
    const parts = path.split('/').filter((s) => s.length > 0);
    for (const part of parts) {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return undefined;
      const entry = parseTree(treeObj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return undefined;
    return parseTree(treeObj.data).map((e) => ({
      mode: e.mode,
      name: e.name,
      oid: e.oid,
      type: (e.mode === '40000' ? 'tree' : 'blob') as 'blob' | 'tree',
    }));
  }

  /**
   * Write (or delete) a file on a branch, creating a commit.
   * Returns the new commit oid, or undefined if the branch does not exist.
   * A first commit on an unborn repository is allowed; creating a commit on a
   * branch that does not exist in a repository that already has refs is not.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } | undefined {
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName);
    if (!parentOid && repo.refs.size > 0) return undefined;
    let baseTreeOid: string | undefined;
    const parents: string[] = [];
    if (parentOid) {
      const parent = repo.objects.get(parentOid);
      if (!parent || parent.type !== 'commit') return undefined;
      baseTreeOid = parseCommitLocal(parent.data).tree;
      parents.push(parentOid);
    }
    const parts = path.split('/').filter((s) => s.length > 0);
    let newTreeOid: string;
    if (content === null) {
      // delete
      if (!baseTreeOid) return undefined;
      const result = this.removeFromTree(repo, baseTreeOid, parts);
      if (!result) return undefined;
      newTreeOid = result;
    } else {
      const blob = makeObject('blob', content);
      this.putObject(repo, blob);
      newTreeOid = this.putIntoTree(repo, baseTreeOid, parts, blob.oid, '100644');
    }
    const commit = makeObject(
      'commit',
      buildCommit({ tree: newTreeOid, parents, author: BOT_AUTHOR, committer: BOT_AUTHOR, message }),
    );
    this.putObject(repo, commit);
    repo.refs.set(refName, commit.oid);
    return { commitOid: commit.oid, blobOid: content === null ? null : this.lastBlobOid! };
  }

  private lastBlobOid: string | null = null;

  /** Insert/replace a blob at path in a tree (creating subtrees as needed). Returns new tree oid. */
  private putIntoTree(repo: Repo, baseTreeOid: string | undefined, parts: string[], blobOid: string, mode: string): string {
    this.lastBlobOid = blobOid;
    if (parts.length === 0) throw new Error('empty path');
    const [head, ...rest] = parts;
    let entries: { mode: string; name: string; oid: string }[] = [];
    if (baseTreeOid) {
      const base = repo.objects.get(baseTreeOid);
      if (base && base.type === 'tree') entries = parseTree(base.data);
    }
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      // leaf
      const entry = { mode, name: head, oid: blobOid };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    } else {
      // directory
      let childTreeOid: string | undefined;
      if (idx >= 0 && entries[idx].mode === '40000') childTreeOid = entries[idx].oid;
      const newChild = this.putIntoTree(repo, childTreeOid, rest, blobOid, mode);
      const entry = { mode: '40000', name: head, oid: newChild };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
    const tree = makeObject('tree', buildTree(entries));
    this.putObject(repo, tree);
    return tree.oid;
  }

  /** Remove a path from a tree. Returns new tree oid, or undefined if the path is absent. */
  private removeFromTree(repo: Repo, baseTreeOid: string, parts: string[]): string | undefined {
    const base = repo.objects.get(baseTreeOid);
    if (!base || base.type !== 'tree') return undefined;
    const entries = parseTree(base.data);
    const [head, ...rest] = parts;
    const idx = entries.findIndex((e) => e.name === head);
    if (idx < 0) return undefined;
    if (rest.length === 0) {
      entries.splice(idx, 1);
    } else {
      if (entries[idx].mode !== '40000') return undefined;
      const newChild = this.removeFromTree(repo, entries[idx].oid, rest);
      if (newChild === undefined) return undefined;
      // If the child tree is now empty, drop the directory entry.
      const child = repo.objects.get(newChild);
      if (child && child.type === 'tree' && parseTree(child.data).length === 0) {
        entries.splice(idx, 1);
      } else {
        entries[idx] = { mode: '40000', name: head, oid: newChild };
      }
    }
    const tree = makeObject('tree', buildTree(entries));
    this.putObject(repo, tree);
    return tree.oid;
  }

  /** Is `ancestor` an ancestor of `descendant` (or equal)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommitLocal(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** Compute a merge (squash) of head into base: returns the new tree oid or null on conflict. */
  squashMerge(repo: Repo, baseOid: string, headOid: string): { treeOid: string; files: { path: string; status: string }[] } | null {
    // Find the merge base (nearest common ancestor) — simple BFS from both sides.
    const baseCommit = repo.objects.get(baseOid);
    const headCommit = repo.objects.get(headOid);
    if (!baseCommit || !headCommit) return null;
    const mergeBase = this.findMergeBase(repo, baseOid, headOid);
    if (!mergeBase) return null;
    // Three-way merge at the file level: take base tree, apply head's changes
    // relative to mergeBase. If head changed a file that base also changed
    // differently, it's a conflict.
    const baseTree = parseCommitLocal(baseCommit.data).tree;
    const headTree = parseCommitLocal(headCommit.data).tree;
    const mbTree = parseCommitLocal(repo.objects.get(mergeBase)!.data).tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const mbFiles = this.flattenTree(repo, mbTree);
    const result = new Map<string, { oid: string; mode: string }>();
    for (const [p, v] of baseFiles) result.set(p, v);
    const changedFiles: { path: string; status: string }[] = [];
    const allPaths = new Set([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    for (const p of allPaths) {
      const mb = mbFiles.get(p);
      const hd = headFiles.get(p);
      const bs = baseFiles.get(p);
      const mbOid = mb?.oid ?? null;
      const hdOid = hd?.oid ?? null;
      const bsOid = bs?.oid ?? null;
      if (hdOid === mbOid) {
        // head did not change it; keep base's version
        continue;
      }
      if (bsOid === mbOid) {
        // base did not change it; take head's version
        if (hd) { result.set(p, hd); changedFiles.push({ path: p, status: bs ? 'modified' : 'added' }); }
        else { result.delete(p); changedFiles.push({ path: p, status: 'removed' }); }
        continue;
      }
      // Both changed it.
      if (hdOid === bsOid) continue; // changed to the same thing
      return null; // conflict
    }
    // Build the merged tree.
    const treeOid = this.buildTreeFromFiles(repo, result);
    return { treeOid, files: changedFiles };
  }

  /** Find the nearest common ancestor of two commits (BFS by generation). */
  findMergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') for (const p of parseCommitLocal(obj.data).parents) stackA.push(p);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') for (const p of parseCommitLocal(obj.data).parents) stackB.push(p);
    }
    return null;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [k, v] of this.flattenTree(repo, e.oid, p)) out.set(k, v);
      } else {
        out.set(p, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }

  /** Build a tree object from a flat path map. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // Build nested structure.
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, v] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        let child = node.dirs.get(part);
        if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(part, child); }
        node = child;
      }
      node.files.set(parts[parts.length - 1], v);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const tree = makeObject('tree', buildTree(entries));
      this.putObject(repo, tree);
      return tree.oid;
    };
    return build(root);
  }
}

// Local commit parse (avoids a circular import with git.ts's parseCommit name).
function parseCommitLocal(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return null;
}

export { ZERO_OID, isOid };
export type { GitObject, ObjType };
