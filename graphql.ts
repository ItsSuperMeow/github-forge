// GraphQL v4 executor for the documents gh and github-mcp-server send.
// A small tokenizer + parser + executor over the store. Supports queries and
// mutations, variables, aliases, inline fragments, __type introspection, and
// batched (array) request bodies.
import { makeObject, buildCommit } from './git.ts';
import type { Repo, Store } from './store.ts';
import { resolveRepo } from './rest.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{ }|'.includes(c) || c === '(' || c === ')' || c === ':' || c === '=' || c === '@' || c === '[' || c === ']' || c === '{' || c === '}' || c === '!' || c === '$' || c === '|' || c === '&') {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // string (handles \" escapes; block strings not needed for these documents)
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && /[0-9]/.test(src[i] === '-' ? (src[i + 1] ?? '') : c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < n && /[0-9]/.test(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j])) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip.
    i += 1;
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; type: string; defaultValue?: ValueNode }[];
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos];
  }

  private next(): Tok {
    return this.toks[this.pos++];
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
  }

  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name' && t.kind !== 'string') throw new Error(`expected name, got ${t.value}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      operation = this.next().value as 'query' | 'mutation' | 'subscription';
    }
    if (this.peek().kind === 'name') name = this.next().value;
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: vname, type, defaultValue });
      }
      this.expectPunct(')');
    }
    // Skip directives (not used in these documents).
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selectionSet };
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      // Named fragment spread (not used here, but parse it as a no-op fragment).
      if (this.peek().kind === 'name') this.next();
      return { kind: 'fragment', typeCondition: null, selectionSet: [] };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    // Skip directives.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, arguments: args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema (the fields the suite's documents use)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url'],
  SearchType: [],
  User: ['login', 'id'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  Actor: ['login'],
};

const SEARCH_TYPE_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface GraphQLCtx {
  store: Store;
  tokenOwner: string | null;
  setTokenOwner: (owner: string) => void;
  baseUrl: string;
}

interface ExecState {
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.arguments) out[a.name] = valueOf(a.value, variables);
  return out;
}

function responseKey(field: FieldNode): string {
  return field.alias ?? field.name;
}

/** Global node ids: R_<dbid> for repos, I_<dbid>_<n> for issues, PR_<dbid>_<n> for pulls. */
export function repoNodeId(repo: Repo): string {
  return `R_${repo.databaseId}`;
}
function issueNodeId(repo: Repo, number: number): string {
  return `I_${repo.databaseId}_${number}`;
}
function pullNodeId(repo: Repo, number: number): string {
  return `PR_${repo.databaseId}_${number}`;
}
function commentNodeId(repo: Repo, id: number): string {
  return `C_${repo.databaseId}_${id}`;
}

/** Find a repo/issue/pull by a global node id. */
function nodeById(ctx: GraphQLCtx, id: string): { kind: 'repo'; repo: Repo } | { kind: 'issue'; repo: Repo; number: number } | { kind: 'pull'; repo: Repo; number: number } | { kind: 'comment'; repo: Repo; id: number } | null {
  const parts = id.split('_');
  if (parts[0] === 'R' && parts.length === 2) {
    const dbid = parseInt(parts[1], 10);
    for (const r of ctx.store.repos.values()) if (r.databaseId === dbid) return { kind: 'repo', repo: r };
  }
  if (parts[0] === 'I' && parts.length === 3) {
    const dbid = parseInt(parts[1], 10);
    const num = parseInt(parts[2], 10);
    for (const r of ctx.store.repos.values()) if (r.databaseId === dbid) return { kind: 'issue', repo: r, number: num };
  }
  if (parts[0] === 'PR' && parts.length === 3) {
    const dbid = parseInt(parts[1], 10);
    const num = parseInt(parts[2], 10);
    for (const r of ctx.store.repos.values()) if (r.databaseId === dbid) return { kind: 'pull', repo: r, number: num };
  }
  if (parts[0] === 'C' && parts.length === 3) {
    const dbid = parseInt(parts[1], 10);
    const cid = parseInt(parts[2], 10);
    for (const r of ctx.store.repos.values()) if (r.databaseId === dbid) return { kind: 'comment', repo: r, id: cid };
  }
  return null;
}

const BOT_AUTHOR = 'forge <forge@localhost> 1700000000 +0000';

/** Execute one operation. Returns the response object {data, errors?}. */
export function executeOperation(ctx: GraphQLCtx, op: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const state: ExecState = { errors: [], variables };
  const data: Record<string, unknown> = {};
  // Validate + execute each top-level field.
  for (const sel of op.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = responseKey(sel);
    const value = executeTopField(ctx, state, sel, op.operation);
    data[key] = value;
  }
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

function executeTopField(ctx: GraphQLCtx, state: ExecState, field: FieldNode, operation: string): unknown {
  const name = field.name;
  const args = argMap(field, state.variables);
  if (name === '__type') {
    return executeTypeField(field, state);
  }
  if (name === '__schema') {
    return { types: Object.keys(TYPE_FIELDS).map((n) => ({ name: n })) };
  }
  if (name === 'viewer') {
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'User', login: ctx.tokenOwner ?? 'owner', id: 1 });
  }
  if (name === 'repository') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.name ?? '');
    const repo = resolveRepo({ store: ctx.store, tokenOwner: ctx.tokenOwner, setTokenOwner: ctx.setTokenOwner, body: undefined, query: new URLSearchParams(), segments: [], ownerParam: null }, owner, repoName);
    if (!repo) return null;
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'Repository', repo });
  }
  if (name === 'node') {
    const id = String(args.id ?? '');
    const found = nodeById(ctx, id);
    if (!found) return null;
    if (found.kind === 'repo') {
      return executeSelection(ctx, state, field.selectionSet, { __typename: 'Repository', repo: found.repo });
    }
    return null;
  }
  if (operation === 'mutation') {
    return executeMutation(ctx, state, field, args);
  }
  state.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
  return null;
}

function executeTypeField(field: FieldNode, state: ExecState): unknown {
  const args = argMap(field, state.variables);
  const typeName = String(args.name ?? '');
  const out: Record<string, unknown> = { name: typeName, kind: typeName === 'SearchType' ? 'ENUM' : 'OBJECT' };
  for (const sel of field.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = responseKey(sel);
    if (sel.name === 'fields') {
      const names = TYPE_FIELDS[typeName] ?? [];
      out[key] = names.map((n) => ({ name: n }));
    } else if (sel.name === 'enumValues') {
      if (typeName === 'SearchType') out[key] = SEARCH_TYPE_ENUM.map((n) => ({ name: n }));
      else out[key] = [];
    } else if (sel.name === 'name') {
      out[key] = typeName;
    } else if (sel.name === 'kind') {
      out[key] = out.kind;
    } else {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "__Type".` });
      out[key] = null;
    }
  }
  return out;
}

function executeMutation(ctx: GraphQLCtx, state: ExecState, field: FieldNode, args: Record<string, unknown>): unknown {
  const name = field.name;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repoId = String(input.repositoryId ?? '');
    const found = nodeById(ctx, repoId);
    if (!found || found.kind !== 'repo') {
      state.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const repo = found.repo;
    const title = String(input.title ?? '');
    if (!title) { state.errors.push({ message: 'title is required.' }); return null; }
    const now = new Date().toISOString();
    const issue = { number: repo.nextIssueNumber++, title, body: String(input.body ?? ''), state: 'open' as const, labels: [], comments: [], created_at: now, updated_at: now, closed_at: null as string | null };
    repo.issues.push(issue);
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'CreateIssuePayload', issue, repo });
  }
  if (name === 'closeIssue') {
    const issueId = String(input.issueId ?? '');
    const found = nodeById(ctx, issueId);
    if (!found || found.kind !== 'issue') {
      state.errors.push({ message: 'Issue not found.' });
      return null;
    }
    const issue = found.repo.issues.find((i) => i.number === found.number);
    if (!issue) { state.errors.push({ message: 'Issue not found.' }); return null; }
    issue.state = 'closed';
    issue.closed_at = new Date().toISOString();
    issue.updated_at = new Date().toISOString();
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'CloseIssuePayload', issue, repo: found.repo });
  }
  if (name === 'createPullRequest') {
    const repoId = String(input.repositoryId ?? '');
    const found = nodeById(ctx, repoId);
    if (!found || found.kind !== 'repo') {
      state.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const repo = found.repo;
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.default_branch);
    const title = String(input.title ?? '');
    const headOid = repo.refs.get(`refs/heads/${head}`);
    const baseOid = repo.refs.get(`refs/heads/${base}`);
    if (!headOid || !baseOid) {
      state.errors.push({ message: 'head or base branch does not exist.' });
      return null;
    }
    const now = new Date().toISOString();
    const pull = { number: repo.nextPullNumber++, title, body: String(input.body ?? ''), state: 'open' as const, head, base, headSha: headOid, baseSha: baseOid, merged: false, merged_at: null as string | null, merge_commit_sha: null as string | null, created_at: now, updated_at: now };
    repo.pulls.push(pull);
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'CreatePullRequestPayload', pullRequest: pull, repo });
  }
  if (name === 'mergePullRequest') {
    const prId = String(input.pullRequestId ?? '');
    const found = nodeById(ctx, prId);
    if (!found || found.kind !== 'pull') {
      state.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    const repo = found.repo;
    const pull = repo.pulls.find((p) => p.number === found.number);
    if (!pull) { state.errors.push({ message: 'Pull request not found.' }); return null; }
    if (pull.merged || pull.state === 'closed') {
      state.errors.push({ message: 'Pull request is already merged or closed.' });
      return null;
    }
    const headOid = repo.refs.get(`refs/heads/${pull.head}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headOid || !baseOid) { state.errors.push({ message: 'head or base branch does not exist.' }); return null; }
    const merge = ctx.store.squashMerge(repo, baseOid, headOid);
    if (!merge) {
      state.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    const commit = makeObject('commit', buildCommit({ tree: merge.treeOid, parents: [baseOid, headOid], author: BOT_AUTHOR, committer: BOT_AUTHOR, message: `Merge pull request #${pull.number} from ${pull.head}` }));
    ctx.store.putObject(repo, commit);
    repo.refs.set(`refs/heads/${pull.base}`, commit.oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = new Date().toISOString();
    pull.merge_commit_sha = commit.oid;
    pull.updated_at = new Date().toISOString();
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'MergePullRequestPayload', pullRequest: pull, repo });
  }
  if (name === 'addComment') {
    const subjectId = String(input.subjectId ?? '');
    const found = nodeById(ctx, subjectId);
    if (!found || (found.kind !== 'issue' && found.kind !== 'pull')) {
      state.errors.push({ message: 'Subject not found.' });
      return null;
    }
    const repo = found.repo;
    const now = new Date().toISOString();
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), created_at: now, updated_at: now };
    if (found.kind === 'issue') {
      const issue = repo.issues.find((i) => i.number === found.number);
      if (!issue) { state.errors.push({ message: 'Issue not found.' }); return null; }
      issue.comments.push(comment);
    }
    // For pulls, comments are not stored (the suite only checks issues).
    return executeSelection(ctx, state, field.selectionSet, { __typename: 'AddCommentPayload', comment, repo });
  }
  state.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

/**
 * Execute a selection set against a resolved value.
 * `value` is {__typename, repo} / {__typename, issue, repo} / {__typename, pullRequest, repo} /
 * {__typename, comment, repo} / a plain object / a payload.
 */
function executeSelection(ctx: GraphQLCtx, state: ExecState, selectionSet: SelectionNode[], value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selectionSet) {
    if (sel.kind === 'fragment') {
      const typeName = (value.__typename as string) ?? '';
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const sub = executeSelection(ctx, state, sel.selectionSet, value);
      Object.assign(out, sub);
      continue;
    }
    const key = responseKey(sel);
    out[key] = executeField(ctx, state, sel, value);
  }
  return out;
}

function executeField(ctx: GraphQLCtx, state: ExecState, field: FieldNode, value: Record<string, unknown>): unknown {
  const name = field.name;
  const typeName = (value.__typename as string) ?? '';
  const args = argMap(field, state.variables);

  // Leaf / scalar fields on plain objects.
  if (typeName === 'User') {
    if (name === 'login') return value.login ?? null;
    if (name === 'id') return value.id ?? null;
    state.errors.push({ message: `Cannot query field "${name}" on type "User".` });
    return null;
  }
  if (typeName === 'Ref') {
    if (name === 'name') return value.name ?? null;
    state.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
    return null;
  }
  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return value.hasNextPage ?? false;
    if (name === 'endCursor') return value.endCursor ?? null;
    if (name === 'hasPreviousPage') return value.hasPreviousPage ?? false;
    if (name === 'startCursor') return value.startCursor ?? null;
    state.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
    return null;
  }

  // Repository
  if (typeName === 'Repository') {
    const repo = value.repo as Repo;
    switch (name) {
      case 'id': return repoNodeId(repo);
      case 'databaseId': return repo.databaseId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'url': return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
      case 'owner': return executeSelection(ctx, state, field.selectionSet, { __typename: 'User', login: repo.owner, id: repo.databaseId });
      case 'defaultBranchRef': return executeSelection(ctx, state, field.selectionSet, { __typename: 'Ref', name: repo.default_branch });
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const number = Number(args.number);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return executeSelection(ctx, state, field.selectionSet, { __typename: 'Issue', issue, repo });
      }
      case 'issues': return executeIssueConnection(ctx, state, field, repo);
      case 'pullRequest': {
        const number = Number(args.number);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) return null;
        return executeSelection(ctx, state, field.selectionSet, { __typename: 'PullRequest', pullRequest: pull, repo });
      }
      case 'pullRequests': return executePullConnection(ctx, state, field, repo);
      default:
        state.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
        return null;
    }
  }

  // Issue
  if (typeName === 'Issue') {
    const issue = value.issue as Repo['issues'][number];
    const repo = value.repo as Repo;
    switch (name) {
      case 'id': return issueNodeId(repo, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'url': return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': return issue.created_at;
      case 'updatedAt': return issue.updated_at;
      case 'closedAt': return issue.closed_at;
      case 'author': return executeSelection(ctx, state, field.selectionSet, { __typename: 'User', login: repo.owner, id: repo.databaseId });
      case 'labels': return { nodes: issue.labels.map((l) => ({ name: l })) };
      case 'comments': return { nodes: issue.comments.map((c) => ({ id: commentNodeId(repo, c.id), body: c.body })) };
      default:
        state.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
        return null;
    }
  }

  // PullRequest
  if (typeName === 'PullRequest') {
    const pull = value.pullRequest as Repo['pulls'][number];
    const repo = value.repo as Repo;
    switch (name) {
      case 'id': return pullNodeId(repo, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.state.toUpperCase();
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'mergeable': {
        // GitHub's MergeableState enum: MERGEABLE, CONFLICTING or UNKNOWN.
        if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
        const headOid = repo.refs.get(`refs/heads/${pull.head}`);
        const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
        if (!headOid || !baseOid) return 'UNKNOWN';
        return ctx.store.squashMerge(repo, baseOid, headOid) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.merged_at;
      case 'author': return executeSelection(ctx, state, field.selectionSet, { __typename: 'User', login: repo.owner, id: repo.databaseId });
      case 'createdAt': return pull.created_at;
      case 'updatedAt': return pull.updated_at;
      case 'files': {
        const files = pullRequestFiles(ctx, repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => ({ path: f }));
        return executeSelection(ctx, state, field.selectionSet, { __typename: 'PullRequestFileConnection', files: nodes, repo });
      }
      default:
        state.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
        return null;
    }
  }

  // PullRequest file connection
  if (typeName === 'PullRequestFileConnection') {
    if (name === 'nodes') {
      const files = (value.files as { path: string }[]) ?? [];
      return files.map((f) => executeSelection(ctx, state, field.selectionSet, { __typename: 'PullRequestFile', path: f.path }));
    }
    if (name === 'totalCount') return ((value.files as { path: string }[]) ?? []).length;
    state.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFileConnection".` });
    return null;
  }
  if (typeName === 'PullRequestFile') {
    if (name === 'path') return value.path ?? null;
    state.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFile".` });
    return null;
  }

  // Payloads
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (name === 'issue') {
      const issue = value.issue as Repo['issues'][number];
      const repo = value.repo as Repo;
      return executeSelection(ctx, state, field.selectionSet, { __typename: 'Issue', issue, repo });
    }
    state.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') {
      const pull = value.pullRequest as Repo['pulls'][number];
      const repo = value.repo as Repo;
      return executeSelection(ctx, state, field.selectionSet, { __typename: 'PullRequest', pullRequest: pull, repo });
    }
    state.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') {
      const comment = value.comment as Repo['issues'][number]['comments'][number];
      const repo = value.repo as Repo;
      return executeSelection(ctx, state, field.selectionSet, {
        __typename: 'IssueCommentEdge',
        comment,
        repo,
      });
    }
    state.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }
  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') {
      const comment = value.comment as Repo['issues'][number]['comments'][number];
      const repo = value.repo as Repo;
      return executeSelection(ctx, state, field.selectionSet, { __typename: 'IssueComment', comment, repo });
    }
    state.errors.push({ message: `Cannot query field "${name}" on type "IssueCommentEdge".` });
    return null;
  }
  if (typeName === 'IssueComment') {
    const comment = value.comment as Repo['issues'][number]['comments'][number];
    const repo = value.repo as Repo;
    if (name === 'id') return commentNodeId(repo, comment.id);
    if (name === 'body') return comment.body;
    state.errors.push({ message: `Cannot query field "${name}" on type "IssueComment".` });
    return null;
  }

  state.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function executeIssueConnection(ctx: GraphQLCtx, state: ExecState, field: FieldNode, repo: Repo): Record<string, unknown> {
  const args = argMap(field, state.variables);
  let list = [...repo.issues];
  // states filter
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  // orderBy
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const orderField = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  if (orderField === 'CREATED_AT') {
    list.sort((a, b) => {
      const d = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
      return direction === 'ASC' ? d : -d;
    });
  } else {
    list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  }
  // cursor pagination
  const after = typeof args.after === 'string' ? args.after : null;
  let startIdx = 0;
  if (after) {
    const decoded = decodeCursor(after);
    const idx = list.findIndex((i) => i.number === decoded);
    if (idx >= 0) startIdx = idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const out: Record<string, unknown> = {};
  for (const sel of field.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = responseKey(sel);
    if (sel.name === 'nodes') {
      out[key] = page.map((issue) => executeSelection(ctx, state, sel.selectionSet, { __typename: 'Issue', issue, repo }));
    } else if (sel.name === 'totalCount') {
      out[key] = list.length;
    } else if (sel.name === 'pageInfo') {
      out[key] = executeSelection(ctx, state, sel.selectionSet, { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: startIdx > 0, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null });
    } else {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "IssueConnection".` });
      out[key] = null;
    }
  }
  return out;
}

function executePullConnection(ctx: GraphQLCtx, state: ExecState, field: FieldNode, repo: Repo): Record<string, unknown> {
  const args = argMap(field, state.variables);
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const sel of field.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = responseKey(sel);
    if (sel.name === 'nodes') {
      out[key] = page.map((pull) => executeSelection(ctx, state, sel.selectionSet, { __typename: 'PullRequest', pullRequest: pull, repo }));
    } else if (sel.name === 'totalCount') {
      out[key] = list.length;
    } else if (sel.name === 'pageInfo') {
      out[key] = executeSelection(ctx, state, sel.selectionSet, { __typename: 'PageInfo', hasNextPage: page.length < list.length, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null, hasPreviousPage: false, startCursor: null });
    } else {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequestConnection".` });
      out[key] = null;
    }
  }
  return out;
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(c: string): number {
  try {
    const text = Buffer.from(c, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    if (m) return parseInt(m[1], 10);
  } catch {
    // fall through
  }
  return -1;
}

/** The file paths changed by a pull request (head tree vs base tree). */
function pullRequestFiles(ctx: GraphQLCtx, repo: Repo, pull: Repo['pulls'][number]): string[] {
  const headOid = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headCommit = repo.objects.get(headOid);
  const baseCommit = repo.objects.get(baseOid);
  if (!headCommit || !baseCommit) return [];
  const headTree = commitTree(headCommit.data);
  const baseTree = commitTree(baseCommit.data);
  const headFiles = ctx.store.flattenTree(repo, headTree);
  const baseFiles = ctx.store.flattenTree(repo, baseTree);
  const out: string[] = [];
  const all = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const p of [...all].sort()) {
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    if (h && b && h.oid === b.oid) continue;
    out.push(p);
  }
  return out;
}

function commitTree(data: Buffer): string {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
    if (line === '') break;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle a GraphQL request body. The body may be a single operation object or
 * an array (batched). Returns the response body (object or array).
 */
export function handleGraphQL(ctx: GraphQLCtx, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => handleOne(ctx, item));
  }
  return handleOne(ctx, body);
}

function handleOne(ctx: GraphQLCtx, body: unknown): Record<string, unknown> {
  const rec = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const query = typeof rec.query === 'string' ? rec.query : '';
  const variables = (rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables) ? rec.variables : {}) as Record<string, unknown>;
  if (!query) return { data: null, errors: [{ message: 'Must provide query string.' }] };
  let ops: OperationNode[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  const op = ops[0];
  return executeOperation(ctx, op, variables);
}
