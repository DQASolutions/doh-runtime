// OBJECT INDEX — objects held in memory: objects by ref
// and by type, every link in both directions (in source order), the versions of versioned objects, and the text
// analyser the search uses. Every value is checked against its declared type when the index is built; a value that
// breaks its type is kept out and reported (`flags`), never silently used.
//
// It is the inside of the memory store (store.ts): for tests, examples and small reference tables. Real stores answer
// the runtime's queries themselves and are never loaded whole.

import { valuePattern, type ObjectType, type TypeExpr, type TypedSpec } from "./spec.ts";

export interface RawObject { type: string; ref: string; props: Record<string, unknown>; clearance?: string }
export interface RawLink { link: string; from: string; to: string }
/** One version of a versioned object: its properties from `from` (inclusive) to `to` (exclusive), set by `by`. */
export interface RawVersion { ref: string; from: string; to?: string; by?: string; props: Record<string, unknown> }
export interface Snapshot { objects: RawObject[]; links: RawLink[]; versions?: RawVersion[] }

export interface Flag { ref: string; field: string; problem: string }
export interface Validity { status: "in_force" | "not_yet" | "ended"; since?: string; until?: string }

// ------------------------------------------------------------------------------------------------ text

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
export const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Adjacent word pairs: in Vietnamese a word is often two syllables, so pairs carry the meaning single syllables lose. */
export function pairs(ws: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + 1 < ws.length; i++) s.add(`${ws[i]} ${ws[i + 1]}`);
  return s;
}
/** Share of a phrasing's pairs (its words, for a one-word phrasing) that stand in the text. */
export function coverage(phrase: string, text: { words: Set<string>; pairs: Set<string> }): number {
  const w = words(phrase);
  if (!w.length) return 0;
  if (w.length === 1) return text.words.has(w[0]!) ? 1 : 0;
  const p = pairs(w);
  let hit = 0;
  for (const x of p) if (text.pairs.has(x)) hit++;
  return hit / p.size;
}
export const analysed = (t: string) => { const w = words(t); return { words: new Set(w), pairs: pairs(w) }; };
export const linesOf = (text: string) => text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

// ------------------------------------------------------------------------------------------------ type checks

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Why a value breaks its type, or undefined. */
export function typeProblem(spec: TypedSpec, t: TypeExpr, v: unknown, refs: Map<string, RawObject>): string | undefined {
  switch (t.kind) {
    case "list": return Array.isArray(v) ? v.map((x) => typeProblem(spec, t.of, x, refs)).find(Boolean) : "expected a list";
    case "enum": return typeof v === "string" && t.values.includes(v) ? undefined : `expected one of ${t.values.join(" | ")}, got ${JSON.stringify(v)}`;
    case "ref": {
      const o = typeof v === "string" ? refs.get(v) : undefined;
      return o && o.type === t.target ? undefined : `expected a ref to a ${t.target}, got ${JSON.stringify(v)}`;
    }
    case "value": {
      const vt = spec.values[t.name]!;
      const p = valuePattern(spec, t.name);
      if (typeof v !== "string" && vt.base !== "int" && vt.base !== "decimal") return `expected ${t.name}`;
      return p && !new RegExp(p, "u").test(String(v)) ? `expected ${t.name} (e.g. ${vt.examples[0]}), got ${JSON.stringify(v)}` : undefined;
    }
    case "struct": return v && typeof v === "object" ? undefined : `expected a ${t.name}`;
    case "scalar":
      switch (t.name) {
        case "int": return Number.isInteger(v) ? undefined : "expected an integer";
        case "decimal": return typeof v === "number" ? undefined : "expected a number";
        case "bool": return typeof v === "boolean" ? undefined : "expected true or false";
        case "date": return typeof v === "string" && DATE.test(v) ? undefined : "expected a date YYYY-MM-DD";
        default: return typeof v === "string" ? undefined : "expected a string";
      }
  }
}

// ------------------------------------------------------------------------------------------------ the index

export class ObjectIndex {
  readonly spec: TypedSpec;
  readonly byRef = new Map<string, RawObject>();
  readonly byType = new Map<string, RawObject[]>();
  private readonly fwd = new Map<string, Map<string, string[]>>();   // link → from → [to]
  private readonly bwd = new Map<string, Map<string, string[]>>();   // link → to → [from]
  private readonly versions = new Map<string, RawVersion[]>();
  private readonly order = new Map<string, number>();
  readonly flags: Flag[] = [];

  constructor(spec: TypedSpec, snaps: Snapshot[]) {
    this.spec = spec;
    const all = snaps.flatMap((s) => s.objects);
    const seen = new Map<string, RawObject>();
    for (const o of all) seen.set(o.ref, o);
    for (const o of all) {
      const t = spec.types[o.type];
      if (!t) { this.flags.push({ ref: o.ref, field: "type", problem: `unknown type ${o.type}` }); continue; }
      const idp = typeProblem(spec, { kind: "value", name: t.id }, o.ref, seen);
      if (idp) { this.flags.push({ ref: o.ref, field: "ref", problem: idp }); continue; }
      this.byRef.set(o.ref, { ...o, props: this.checked(t, o.ref, o.props, seen) });
      this.order.set(o.ref, this.order.size);
      (this.byType.get(o.type) ?? this.byType.set(o.type, []).get(o.type)!).push(this.byRef.get(o.ref)!);
    }
    for (const l of snaps.flatMap((s) => s.links)) {
      const d = this.spec.links[l.link];
      const a = this.byRef.get(l.from), b = this.byRef.get(l.to);
      if (!d) { this.flags.push({ ref: l.from, field: l.link, problem: "unknown link" }); continue; }
      if (!a || !b || a.type !== d.from || b.type !== d.to) { this.flags.push({ ref: l.from, field: l.link, problem: `link to ${l.to} does not join a ${d.from} to a ${d.to}` }); continue; }
      push(this.fwd, l.link, l.from, l.to);
      push(this.bwd, l.link, l.to, l.from);
    }
    for (const v of snaps.flatMap((s) => s.versions ?? [])) {
      const o = this.byRef.get(v.ref);
      if (!o || !spec.types[o.type]!.implements.Versioned) { this.flags.push({ ref: v.ref, field: "version", problem: "version of an object that is not versioned or not held" }); continue; }
      if (!DATE.test(v.from) || (v.to !== undefined && !DATE.test(v.to))) { this.flags.push({ ref: v.ref, field: "version", problem: "version dates must be YYYY-MM-DD" }); continue; }
      (this.versions.get(v.ref) ?? this.versions.set(v.ref, []).get(v.ref)!).push({ ...v, props: this.checked(spec.types[o.type]!, v.ref, v.props, seen) });
    }
    for (const vs of this.versions.values()) vs.sort((a, b) => a.from.localeCompare(b.from));
  }

  private checked(t: ObjectType, ref: string, props: Record<string, unknown>, refs: Map<string, RawObject>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      const p = t.properties[k];
      if (!p) { this.flags.push({ ref, field: k, problem: "not a property of the type" }); continue; }
      if (v === undefined || v === null || v === "") continue;
      const problem = typeProblem(this.spec, p.type, v, refs);
      if (problem) this.flags.push({ ref, field: k, problem }); else out[k] = v;
    }
    return out;
  }

  rank(ref: string) { return this.order.get(ref) ?? Number.MAX_SAFE_INTEGER; }
  forward(link: string, from: string): string[] { return this.fwd.get(link)?.get(from) ?? []; }
  backward(link: string, to: string): string[] { return this.bwd.get(link)?.get(to) ?? []; }
  versionsOf(ref: string): RawVersion[] { return this.versions.get(ref) ?? []; }

  /** The object's properties as in force on `at`, and its validity (versioned types only). */
  view(o: RawObject, at: string): { props: Record<string, unknown>; validity?: Validity } {
    return this.spec.types[o.type]!.implements.Versioned ? atDate(o.props, this.versionsOf(o.ref), at) : { props: o.props };
  }
}

/**
 * A versioned object as in force on `at`: its own properties overlaid by the version in force, and its validity. The
 * one rule every store applies (an adapter that reads versions itself calls this on what it read).
 */
export function atDate(props: Record<string, unknown>, versions0: readonly RawVersion[], at: string): { props: Record<string, unknown>; validity: Validity } {
  const vs = [...versions0].sort((a, b) => a.from.localeCompare(b.from));
  if (!vs.length) return { props, validity: { status: "in_force" } };
  const cur = vs.find((v) => v.from <= at && (v.to === undefined || at < v.to));
  if (cur) return { props: { ...props, ...cur.props }, validity: { status: "in_force", since: cur.from, ...(cur.to ? { until: cur.to } : {}) } };
  if (at < vs[0]!.from) return { props, validity: { status: "not_yet", since: vs[0]!.from } };
  const last = vs.at(-1)!;
  return { props: { ...props, ...last.props }, validity: { status: "ended", ...(last.to ? { until: last.to } : {}) } };
}

function push(m: Map<string, Map<string, string[]>>, link: string, a: string, b: string) {
  const inner = m.get(link) ?? m.set(link, new Map()).get(link)!;
  (inner.get(a) ?? inner.set(a, []).get(a)!).push(b);
}
