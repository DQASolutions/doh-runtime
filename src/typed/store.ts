// STORE — what the runtime asks of a store, in the ontology's terms (type, property, link), never in the store's own
// (table, node, collection). A store only holds and queries data; everything else — argument checks, parsing, cards
// built from the interfaces, verdicts, output schemas — is the runtime's.
//
//   search      objects of a type whose text fields match phrasings, best first (the store's own text / vector index)
//   scan        objects of a type matching filters, in the store's order
//   get         objects by ref, as in force on a date: properties, validity, versions
//   neighbours  one link from each ref, forward or backward
//   heads       a change marker, for caches
//
// An adapter is written once per KIND of store (memory, a document service over HTTP, a document database, SQL …), never per type:
// where a type lives in the store is the spec's business. Each adapter states what it can do (`capabilities`); the
// runtime re-applies every filter on what comes back, so a filter the store cannot push down still holds.

import { ObjectIndex, analysed, coverage, words as wordsOf, type Flag, type RawLink, type RawObject, type RawVersion, type Validity } from "./index.ts";
import type { LinkDecl, ObjectType, TypedSpec } from "./spec.ts";

export type FilterKind = "any" | "range" | "words" | "bool";
export interface Filter { prop: string; kind: FilterKind; value: unknown }
export interface Who { clearance?: string | undefined }
export interface StoredObject {
  ref: string;
  type: string;
  /** the properties as in force on the date asked */
  props: Record<string, unknown>;
  /** versioned types: in force, not yet, ended */
  validity?: Validity;
  versions?: Array<{ from: string; to?: string; by?: string }>;
  /** the store's own citation of the object, when it has one */
  cite?: string;
}
export interface Capabilities {
  /** text search over a type's text fields */
  search: boolean;
  /** reads at a date by itself (otherwise the spec maps versions onto objects of a version type) */
  at: boolean;
  /** applies the caller's clearance itself */
  clearance: boolean;
  /** filter kinds it applies in the query (the runtime re-checks all of them) */
  filters: FilterKind[];
  /** the most candidates one search gives (a large base's search engine caps it); unset: as many as asked */
  searchLimit?: number;
}
export interface Store {
  capabilities(): Capabilities;
  /** Whether a query of this store applies this filter. A store that leaves some filters of a kind it lists in
   *  `capabilities().filters` to the runtime (a ref, a versioned property) must say so here: the runtime then asks for
   *  far more candidates and applies the filter itself. Absent: every filter of a listed kind is applied. */
  applies?(type: ObjectType, f: Filter): boolean;
  /** called once with the spec and the store's name in it, before any query; the adapter checks the spec's types of
   *  this store against the store's own schema here, and refuses to open on any difference */
  open(spec: TypedSpec, name: string): Promise<void>;
  search(q: { type: ObjectType; phrasings: string[]; fields: string[]; filters: Filter[]; at: string; limit: number }, who: Who): Promise<Array<{ ref: string; score: number }>>;
  scan(q: { type: ObjectType; filters: Filter[]; at: string; limit: number }, who: Who): Promise<string[]>;
  /** How many objects of a type match the filters (all of them applied by the store: the runtime asks only then).
   *  Optional: without it the runtime counts from a scan, up to a bound, and says when the bound was reached. */
  count?(q: { type: ObjectType; filters: Filter[]; at: string }, who: Who): Promise<number>;
  get(refs: readonly string[], at: string, who: Who): Promise<Array<StoredObject | undefined>>;
  neighbours(link: LinkDecl, direction: "forward" | "backward", refs: readonly string[], who: Who): Promise<Map<string, string[]>>;
  heads(): Promise<string>;
  /** data health: values that broke their declared type; property fill */
  health?(at: string): Promise<{ objects: number; flags: Flag[]; fill: Record<string, Record<string, string>> }>;
  close?(): Promise<void>;
}

/** Does an object's property value pass a filter? The runtime's check, applied whatever the store did. */
export function passes(props: Record<string, unknown>, f: Filter, words: (s: string) => string[]): boolean {
  const v = props[f.prop];
  switch (f.kind) {
    case "words": { const have = new Set(words(String(v ?? ""))); return (f.value as string[]).some((ph) => words(ph).every((w) => have.has(w))); }
    case "bool": return v === f.value;
    case "range": { const r = f.value as { min?: never; max?: never }; return v !== undefined && (r.min === undefined || (v as never) >= r.min) && (r.max === undefined || (v as never) <= r.max); }
    case "any": { const vs = Array.isArray(v) ? v : [v]; return vs.some((x) => (f.value as unknown[]).includes(x)); }
  }
}

// ------------------------------------------------------------------------------------------------ memory

/** A store held in memory, for tests, examples and small reference tables. Every value is checked against its type. */
export class MemoryStore implements Store {
  private objects: RawObject[] = [];
  private links: RawLink[] = [];
  private versions: RawVersion[] = [];
  private n = 0;
  private spec: TypedSpec | undefined;
  private ix: ObjectIndex | undefined;
  private ixAt = -1;

  /** A store holding these objects, links and versions. */
  static of(snap: { objects: RawObject[]; links: RawLink[]; versions?: RawVersion[] }): MemoryStore {
    const m = new MemoryStore();
    m.objects = [...snap.objects]; m.links = [...snap.links]; m.versions = [...(snap.versions ?? [])]; m.n = 1;
    return m;
  }
  /** What it holds, as raw objects, links and versions (to load the same data into another store). */
  snapshot() { return { objects: [...this.objects], links: [...this.links], versions: [...this.versions] }; }
  put(o: RawObject): this { this.objects.push(o); this.n++; return this; }
  link(link: string, from: string, to: string): this { this.links.push({ link, from, to }); this.n++; return this; }
  version(v: RawVersion): this { this.versions.push(v); this.n++; return this; }

  capabilities(): Capabilities { return { search: true, at: true, clearance: true, filters: ["any", "range", "words", "bool"] }; }
  async open(spec: TypedSpec, _name: string) { this.spec = spec; }
  async heads() { return `mem:${this.n}`; }

  private index(): ObjectIndex {
    if (!this.spec) throw new Error("MemoryStore: open(spec) first");
    if (!this.ix || this.ixAt !== this.n) { this.ix = new ObjectIndex(this.spec, [{ objects: this.objects, links: this.links, versions: this.versions }]); this.ixAt = this.n; }
    return this.ix;
  }
  private visible(o: RawObject, who: Who) { return !o.clearance || o.clearance === "public" || o.clearance === who.clearance; }
  private live(type: ObjectType, at: string, who: Who) {
    const ix = this.index();
    return (ix.byType.get(type.name) ?? []).filter((o) => this.visible(o, who)).map((o) => ({ o, ...ix.view(o, at) })).filter((x) => !x.validity || x.validity.status === "in_force");
  }

  async search(q: Parameters<Store["search"]>[0], who: Who) {
    const out: Array<{ ref: string; score: number }> = [];
    for (const x of this.live(q.type, q.at, who)) {
      if (!q.filters.every((f) => passes(x.props, f, wordsOf))) continue;
      const txt = analysed(q.fields.map((f) => String(x.props[f] ?? "")).join("\n"));
      // a candidate has any word of a phrasing (as a full-text index's "any word" query); best coverage first
      if (!q.phrasings.some((p) => wordsOf(p).some((w) => txt.words.has(w)))) continue;
      out.push({ ref: x.o.ref, score: Math.max(0, ...q.phrasings.map((p) => coverage(p, txt))) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, q.limit);
  }
  async count(q: Parameters<NonNullable<Store["count"]>>[0], who: Who) {
    return this.live(q.type, q.at, who).filter((x) => q.filters.every((f) => passes(x.props, f, wordsOf))).length;
  }
  async scan(q: Parameters<Store["scan"]>[0], who: Who) {
    return this.live(q.type, q.at, who).filter((x) => q.filters.every((f) => passes(x.props, f, wordsOf))).slice(0, q.limit).map((x) => x.o.ref);
  }
  async get(refs: readonly string[], at: string, who: Who) {
    const ix = this.index();
    return refs.map((r) => {
      const o = ix.byRef.get(r);
      if (!o || !this.visible(o, who)) return undefined;
      const { props, validity } = ix.view(o, at);
      const vs = ix.versionsOf(r);
      return { ref: r, type: o.type, props, ...(validity ? { validity } : {}), ...(vs.length ? { versions: vs.map((v) => ({ from: v.from, ...(v.to ? { to: v.to } : {}), ...(v.by ? { by: v.by } : {}) })) } : {}) };
    });
  }
  async neighbours(link: LinkDecl, direction: "forward" | "backward", refs: readonly string[], who: Who) {
    const ix = this.index();
    return new Map(refs.map((r) => [r, (direction === "forward" ? ix.forward(link.name, r) : ix.backward(link.name, r)).filter((x) => { const o = ix.byRef.get(x); return !!o && this.visible(o, who); })]));
  }
  async health(at: string) {
    const ix = this.index(), spec = this.spec!;
    const fill: Record<string, Record<string, string>> = {};
    for (const t of Object.values(spec.types)) {
      const os = ix.byType.get(t.name) ?? [];
      if (!os.length) continue;
      fill[t.name] = Object.fromEntries(Object.keys(t.properties).map((p) => [p, `${os.filter((o) => ix.view(o, at).props[p] !== undefined).length}/${os.length}`]));
    }
    return { objects: ix.byRef.size, flags: ix.flags, fill };
  }
}
