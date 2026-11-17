// Git object store: SHA-1 objects, packfile read/write, refs.
// Pure Node stdlib (node:crypto, node:zlib). No git binary.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** SHA-1 hex of a git object header + content. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

/** Build a git object (computes its oid). */
export function makeObject(type: ObjType, data: Buffer): GitObject {
  return { type, data, oid: hashObject(type, data) };
}

/** The raw bytes of an object as stored (header + content), for loose/pack storage. */
export function objectBytes(obj: GitObject): Buffer {
  return Buffer.concat([Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8'), obj.data]);
}

/** Parse raw object bytes back into type + data. */
export function parseObjectBytes(raw: Buffer): { type: ObjType; data: Buffer } {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('utf8');
  const [type, sizeStr] = header.split(' ');
  const size = parseInt(sizeStr, 10);
  const data = raw.subarray(nul + 1);
  if (data.length !== size) throw new Error(`object size mismatch: header ${size}, got ${data.length}`);
  return { type: type as ObjType, data: Buffer.from(data) };
}

/** A tree entry. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Serialize a tree object from entries. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
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

/** Build a commit object body. */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  lines.push('');
  lines.push(opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a commit object's header fields (tree, parents, author, committer) and message. */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
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

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_SIGNATURE = 0x5041434b; // "PACK"

/** Read a varint (git's offset/size encoding) from buf at off. Returns [value, nextOff]. */
function readVarint(buf: Buffer, off: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i];
    value |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
    if (!(b & 0x80)) break;
  }
  return [value, i];
}

/** Apply a git delta to a base buffer, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const [baseSize, o1] = readVarint(delta, off);
  off = o1;
  const [resultSize, o2] = readVarint(delta, off);
  off = o2;
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      // copy from base
      let cpOff = 0;
      let cpSize = 0;
      for (let b = 0; b < 4; b += 1) {
        if (op & (1 << b)) { cpOff |= delta[off] << (8 * b); off += 1; }
      }
      for (let b = 0; b < 3; b += 1) {
        if (op & (0x10 << b)) { cpSize |= delta[off] << (8 * b); off += 1; }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      // insert literal
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error(`delta result size ${result.length} != ${resultSize}`);
  return result;
}

/** One parsed pack object (before delta resolution). */
interface RawPackObject {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  data: Buffer; // inflated data (for deltas: the delta instructions)
  baseOffset?: number; // ofs-delta
  baseOid?: string; // ref-delta
  offset: number; // offset of this object in the pack
}

const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

const TYPE_NUM_TO_NAME: Record<number, ObjType> = {
  [TYPE_COMMIT]: 'commit',
  [TYPE_TREE]: 'tree',
  [TYPE_BLOB]: 'blob',
  [TYPE_TAG]: 'tag',
};

/**
 * Parse a packfile using a streaming inflate to know exactly how many bytes
 * each object's compressed data occupies. Returns resolved git objects.
 */
export function parsePackStream(pack: Buffer): GitObject[] {
  if (pack.length < 12) throw new Error('pack too short');
  if (pack.readUInt32BE(0) !== PACK_SIGNATURE) throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const raws: RawPackObject[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const objOffset = off;
    const first = pack[off];
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    let cont = (first & 0x80) !== 0;
    while (cont) {
      const b = pack[off];
      size |= (b & 0x7f) << shift;
      shift += 7;
      off += 1;
      cont = (b & 0x80) !== 0;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === TYPE_OFS_DELTA) {
      let b = pack[off];
      let n = b & 0x7f;
      off += 1;
      while ((b & 0x80) !== 0) {
        b = pack[off];
        n = ((n + 1) << 7) | (b & 0x7f);
        off += 1;
      }
      baseOffset = objOffset - n;
    } else if (type === TYPE_REF_DELTA) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    // Inflate exactly one zlib stream starting at off, tracking consumed bytes.
    const { data, consumed } = inflateOne(pack, off, size);
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, got ${data.length}`);
    off += consumed;
    raws.push({ type, data, baseOffset, baseOid, offset: objOffset });
  }
  // Resolve deltas (may reference earlier objects by offset, or by oid for ref-delta).
  const byOffset = new Map<number, RawPackObject>();
  for (const r of raws) byOffset.set(r.offset, r);
  const resolved = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();

  function resolve(raw: RawPackObject, depth: number): GitObject {
    if (depth > 100) throw new Error('delta chain too deep');
    const cached = resolved.get(raw.offset);
    if (cached) return cached;
    let obj: GitObject;
    if (raw.type === TYPE_OFS_DELTA) {
      const baseRaw = byOffset.get(raw.baseOffset!);
      if (!baseRaw) throw new Error(`ofs-delta base offset ${raw.baseOffset} not in pack`);
      const base = resolve(baseRaw, depth + 1);
      const data = applyDelta(base.data, raw.data);
      obj = makeObject(base.type, data);
    } else if (raw.type === TYPE_REF_DELTA) {
      // Base may be in this pack (find by oid after resolving) or already known.
      // First try to find a raw whose resolved oid matches.
      let base: GitObject | undefined = byOid.get(raw.baseOid!);
      if (!base) {
        for (const r of raws) {
          if (r.type === TYPE_REF_DELTA || r.type === TYPE_OFS_DELTA) continue;
          const cand = makeObject(TYPE_NUM_TO_NAME[r.type], r.data);
          if (cand.oid === raw.baseOid) { base = cand; break; }
        }
      }
      if (!base) throw new Error(`ref-delta base ${raw.baseOid} not in pack`);
      const data = applyDelta(base.data, raw.data);
      obj = makeObject(base.type, data);
    } else {
      obj = makeObject(TYPE_NUM_TO_NAME[raw.type], raw.data);
    }
    resolved.set(raw.offset, obj);
    byOid.set(obj.oid, obj);
    return obj;
  }

  const out: GitObject[] = [];
  for (const r of raws) out.push(resolve(r, 0));
  return out;
}

/**
 * Inflate exactly one zlib stream starting at `off` in buf.
 * Returns the inflated data and how many input bytes were consumed.
 * Node's inflateSync ignores trailing bytes, so we find the stream's end by
 * probing: start near the expected size (compressed is usually <= the
 * uncompressed size for text), then binary-search the smallest length that
 * inflates cleanly.
 */
function inflateOne(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - off;
  // Start the probe at a plausible compressed length.
  let probe = Math.min(remaining, Math.max(32, expectedSize + 16));
  let found: number | undefined;
  // Grow until a length inflates (or we run out of input).
  while (probe <= remaining) {
    try {
      inflateSync(buf.subarray(off, off + probe));
      found = probe;
      break;
    } catch {
      if (probe === remaining) break;
      probe = Math.min(remaining, probe * 2);
    }
  }
  if (found === undefined) {
    const data = inflateSync(buf.subarray(off));
    return { data, consumed: remaining };
  }
  // Binary-search the smallest length that inflates.
  let lo = 1;
  let hi = found;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(off, off + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(off, off + lo));
  return { data, consumed: lo };
}

/** Write a packfile containing the given objects as full (undeltified) entries. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt32BE(PACK_SIGNATURE, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const compressed = deflateSync(obj.data);
    const type = typeNum[obj.type];
    const size = obj.data.length;
    // pack object header: type (3 bits) + size varint
    const headerBytes: number[] = [];
    let first = (type << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The zero OID. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Is this a valid 40-hex SHA-1? */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}
