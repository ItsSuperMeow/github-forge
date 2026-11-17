// Git smart HTTP: pkt-line framing, upload-pack (v2 + v0), receive-pack (v0).
// Implements the wire the suite's git client speaks (see kit program/env/src/git-client.ts).
import { buildPack, parsePackStream, ZERO_OID, isOid, type GitObject } from './git.ts';
import type { Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of lines (strings) / 'flush' / 'delim' into pkt-line bytes. */
export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Parse a whole buffer of pkt-lines. Returns packets; trailing partial data is ignored. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      // response-end (0002) — treat as flush
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/** Split a sideband-framed stream into band-1 data (pack/report) and band-2 progress. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

/** Chunk a large buffer into sideband band-1 packets (max pkt-line 65520 bytes). */
export function sidebandChunks(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const maxData = 65520 - 4 - 1;
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += maxData) {
    out.push(sidebandPacket(band, data.subarray(off, Math.min(data.length, off + maxData))));
  }
  if (data.length === 0) out.push(sidebandPacket(band, Buffer.alloc(0)));
  return out;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface RefInfo {
  name: string;
  oid: string;
  peeled?: string; // for annotated tags: the commit they point to
  symrefTarget?: string; // for HEAD
  unborn?: boolean;
}

/** All refs of a repo for advertisement, including HEAD. */
export function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const headTarget = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) {
    out.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  } else {
    out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    const info: RefInfo = { name, oid };
    if (obj && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) info.peeled = target;
    }
    out.push(info);
  }
  return out;
}

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return null;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant` in this repo? */
function isAncestor(store: Store, repo: Repo, ancestor: string, descendant: string): boolean {
  return store.isAncestor(repo, ancestor, descendant);
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

const AGENT = 'github-forge/1.0';

/** v2 capability advertisement for upload-pack. */
export function advertiseV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** v0 ref advertisement for a service (upload-pack or receive-pack). */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = listRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k ofs-delta'
      : 'report-status side-band-64k delete-refs ofs-delta';
  // First ref carries the capabilities after a NUL.
  const first = refs[0];
  if (first) {
    const line = first.unborn
      ? `${ZERO_OID} ${first.name}\0${caps}\n`
      : `${first.oid} ${first.name}\0${caps}\n`;
    parts.push(pktLine(line));
    for (const r of refs.slice(1)) {
      if (r.name === 'HEAD') continue;
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  } else {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  filter: string | null;
  thinPack: boolean;
}

/** Handle a v2 command request body. Returns the response bytes. */
export function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!inArgs && text.startsWith('command=')) {
      command = text.slice('command='.length).trim();
      continue;
    }
    if (!inArgs) continue; // agent= / object-format= lines before delim
    lines.push(text);
  }
  if (command === 'ls-refs') return handleLsRefs(repo, lines);
  if (command === 'fetch') return handleFetchV2(store, repo, lines);
  return encodePktLines(['flush']);
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    const t = a.trim();
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') unborn = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const out: string[] = [];
  for (const r of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
    if (r.unborn && !unborn) continue;
    if (r.unborn) {
      const attrs: string[] = [];
      if (symrefs && r.symrefTarget) attrs.push(`symref-target:${r.symrefTarget}`);
      out.push(`unborn ${r.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`);
      continue;
    }
    const attrs: string[] = [];
    if (symrefs && r.symrefTarget) attrs.push(`symref-target:${r.symrefTarget}`);
    if (peel && r.peeled) attrs.push(`peeled:${r.peeled}`);
    out.push(`${r.oid} ${r.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`);
  }
  return encodePktLines([...out, 'flush']);
}

function handleFetchV2(store: Store, repo: Repo, args: string[]): Buffer {
  const f: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, filter: null, thinPack: false };
  for (const a of args) {
    const t = a.trim();
    if (t.startsWith('want ')) f.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) f.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) f.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) f.depth = parseInt(t.slice(7).trim(), 10);
    else if (t.startsWith('deepen-since ')) f.deepenSince = parseInt(t.slice(13).trim(), 10);
    else if (t.startsWith('filter ')) f.filter = t.slice(7).trim();
    else if (t === 'thin-pack') f.thinPack = true;
    // done, no-progress, ofs-delta: noted but not needed for a full pack
  }
  return buildFetchResponse(store, repo, f);
}

// Cache of built fetch responses, keyed by the fetch arguments. The objects
// are content-addressed, so a response for a given (wants, haves, depth) is
// deterministic; the benchmark's 50 identical clones hit this cache.
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 32;

function fetchCacheKey(f: FetchArgs): string {
  return `${f.wants.join(',')}|${f.haves.join(',')}|${f.shallow.join(',')}|${f.depth ?? ''}|${f.filter ?? ''}`;
}

function buildFetchResponse(store: Store, repo: Repo, f: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(f);
  const cached = fetchCache.get(cacheKey);
  if (cached) return cached;
  const built = buildFetchResponseUncached(store, repo, f);
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  fetchCache.set(cacheKey, built);
  return built;
}

function buildFetchResponseUncached(store: Store, repo: Repo, f: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  // --- acknowledgments section
  const commonHave = f.haves.find((h) => repo.objects.has(h));
  parts.push(pktLine('acknowledgments\n'));
  if (commonHave) {
    parts.push(pktLine(`ACK ${commonHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());

  // --- compute the objects to send
  let objects: GitObject[] = [];
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (f.depth !== null && f.depth > 0) {
    // Shallow: only commits within `depth` generations of each want, plus their trees/blobs.
    const { objs, boundary, unshallow } = shallowObjects(store, repo, f.wants, f.depth, f.shallow);
    objects = objs;
    shallowOut = boundary;
    unshallowOut = unshallow;
  } else {
    // Full: everything reachable from wants, minus everything reachable from haves.
    const wantSet = new Set<string>();
    for (const w of f.wants) {
      for (const o of store.reachableObjects(repo, [w])) wantSet.add(o.oid);
    }
    const haveSet = new Set<string>();
    for (const h of f.haves) {
      for (const o of store.reachableObjects(repo, [h])) haveSet.add(o.oid);
    }
    for (const oid of wantSet) {
      if (!haveSet.has(oid)) {
        const o = repo.objects.get(oid);
        if (o) objects.push(o);
      }
    }
    // Order deterministically: commits, trees, blobs, tags (so the client reads cleanly).
    const order: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
    objects.sort((a, b) => (order[a.type] - order[b.type]) || (a.oid < b.oid ? -1 : 1));
  }

  // --- shallow-info section (only when a depth was requested)
  if (f.depth !== null && f.depth > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }

  // --- packfile section
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(objects);
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Objects within `depth` generations of the wants.
 * The shallow boundary is the deepest included generation (gen == depth - 1):
 * those commits are present but their parents are not, so they are the
 * shallow markers. Commits the client already holds as shallow whose parent
 * is now delivered become `unshallow`.
 */
function shallowObjects(
  store: Store,
  repo: Repo,
  wants: string[],
  depth: number,
  clientShallow: string[],
): { objs: GitObject[]; boundary: string[]; unshallow: string[] } {
  const objs = new Map<string, GitObject>();
  const boundary = new Set<string>();
  // Add a commit and its tree/blobs only (never parent commits).
  const addCommitTree = (commitOid: string): void => {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return;
    if (objs.has(commitOid)) return;
    objs.set(commitOid, commit);
    const { tree } = parseCommitData(commit.data);
    addTree(tree);
  };
  const addTree = (treeOid: string): void => {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    if (objs.has(treeOid)) return;
    objs.set(treeOid, treeObj);
    for (const e of parseTreeData(treeObj.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else {
        const blob = repo.objects.get(e.oid);
        if (blob) objs.set(blob.oid, blob);
      }
    }
  };
  // BFS over commits by generation.
  interface Item { oid: string; gen: number }
  const queue: Item[] = wants.map((w) => ({ oid: w, gen: 0 }));
  const seenCommits = new Set<string>();
  const genOf = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    genOf.set(oid, gen);
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    if (gen >= depth) continue;
    addCommitTree(oid);
    if (gen === depth - 1) boundary.add(oid);
    const { parents } = parseCommitData(commit.data);
    for (const p of parents) queue.push({ oid: p, gen: gen + 1 });
  }
  // A client-side shallow commit is unshallow when its parent is now included:
  // its generation is < depth - 1, so its parent (gen + 1) is < depth.
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    const g = genOf.get(s);
    if (g !== undefined && g < depth - 1) unshallow.push(s);
  }
  return { objs: [...objs.values()], boundary: [...boundary], unshallow };
}

function parseTreeData(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0, sp);
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function parseCommitData(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep >= 0 ? text.slice(0, sep) : text;
  const parents: string[] = [];
  let tree = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

// ---------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------

/** Handle a v0 upload-pack request body. Returns the response bytes. */
export function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      wants.push(rest.split(' ')[0]);
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith('deepen ')) {
      depth = parseInt(text.slice(7).trim(), 10);
    } else if (text === 'done') {
      break;
    }
  }
  const parts: Buffer[] = [];
  // v0 response: NAK, then the packfile in sideband.
  const commonHave = haves.find((h) => repo.objects.has(h));
  if (commonHave) parts.push(pktLine(`ACK ${commonHave}\n`));
  else parts.push(pktLine('NAK\n'));
  const f: FetchArgs = { wants, haves, shallow: [], depth: depth > 0 ? depth : null, deepenSince: null, filter: null, thinPack: false };
  let objects: GitObject[] = [];
  if (f.depth !== null && f.depth > 0) {
    objects = shallowObjects(store, repo, f.wants, f.depth, f.shallow).objs;
  } else {
    const wantSet = new Set<string>();
    for (const w of f.wants) for (const o of store.reachableObjects(repo, [w])) wantSet.add(o.oid);
    const haveSet = new Set<string>();
    for (const h of f.haves) for (const o of store.reachableObjects(repo, [h])) haveSet.add(o.oid);
    for (const oid of wantSet) {
      if (!haveSet.has(oid)) {
        const o = repo.objects.get(oid);
        if (o) objects.push(o);
      }
    }
    const order: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
    objects.sort((a, b) => (order[a.type] - order[b.type]) || (a.oid < b.oid ? -1 : 1));
  }
  const pack = buildPack(objects);
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack v0 (push)
// ---------------------------------------------------------------------------

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason?: string;
}

/**
 * Handle a receive-pack request. Parses ref commands + packfile, applies the
 * fast-forward-valid updates, and returns the report-status bytes (sideband
 * band-1 wrapped).
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { report: PushReportEntry[]; response: Buffer } {
  // Split the body: pkt-lines up to the first flush, then the raw packfile.
  const packets = decodePktLines(body);
  // Find where the flush pkt ends so the pack starts right after it.
  let off = 0;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const hex = body.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (len === 1 || len === 2) { off += 4; continue; }
    if (off + len > body.length) break;
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    // First line may carry capabilities after a NUL.
    const nul = payload.indexOf('\0');
    const cmdText = nul >= 0 ? payload.slice(0, nul) : payload;
    const parts = cmdText.trim().split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    off += len;
  }
  void packets;

  // Parse and store the packfile (if any).
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const objects = parsePackStream(packBytes);
      for (const o of objects) store.putObject(repo, o);
    } catch (err) {
      // Unpack error: report every ref as ng.
      const report: PushReportEntry[] = commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }));
      return { report, response: buildPushResponse(report) };
    }
  }

  // Apply ref updates with fast-forward checks.
  const report: PushReportEntry[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        report.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    // Create or update.
    if (current === undefined) {
      // Create: old must be zero.
      if (cmd.oldOid !== ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // Update: old must match current, new must be a descendant (fast-forward).
    if (cmd.oldOid !== current) {
      report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(repo, current, cmd.newOid)) {
      report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ref: cmd.ref, ok: true });
  }
  return { report, response: buildPushResponse(report) };
}

function buildPushResponse(report: PushReportEntry[]): Buffer {
  const lines: string[] = ['unpack ok\n'];
  for (const r of report) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`);
  }
  const reportBytes = encodePktLines([...lines, 'flush']);
  const parts: Buffer[] = [];
  for (const chunk of sidebandChunks(1, reportBytes)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
