// TYPED ENGINE — the harness a typed spec generates. Nothing in it names a type of any domain: every tool, argument,
// filter, card field and output schema follows from the declared types and interfaces.
//
//   tools        find_<type>  for each type with properties marked find: true
//                read         objects in full, by ref (or as written, when the ref's value type has a parse function)
//                quote        the exact text behind refs: an object, "<ref> #n-m" (lines), "<ref>:<field>"
//                + the project's functions (those not used as parse / cite helpers)
//   filters      by the property's type: text → phrasings, ranked by coverage of word pairs (with the object's path
//                as context); string → phrasings whose words all stand; enum → any of; value / ref → any of (parsed);
//                date / int / decimal → { min, max }; bool → equal; Versioned → `at`
//   cards        by the interfaces: Citable → ref, cite, lines; Part → path (title, or first line, of each ancestor)
//                and children; Referring → refers (with the start of the target's text), citedBy; Versioned →
//                the text in force on `at`, validity, versions
//   outputs      every tool has an output schema; tests check outputs against it
//   stores       the engine holds no data: it asks each type's store (search, scan, get, neighbours), see store.ts

import { check, checkArgs, type JsonSchema } from "../args.ts";
import { HarnessError, type Caller } from "../engine.ts";
import { analysed, coverage, linesOf, pairs, words } from "./index.ts";
import { passes, type Filter, type Store, type StoredObject } from "./store.ts";
import { scalarBase, valuePattern, type FunctionDecl, type LinkDecl, type ObjectType, type PropDecl, type TypeExpr, type TypedSpec } from "./spec.ts";

export interface TypedFnContext { engine: TypedEngine; at: string; who: Caller }
export type TypedFunctionImpl = (args: Record<string, unknown>, ctx: TypedFnContext) => Promise<unknown>;
/** What `quote` returns for each ref: the text (an object, its lines) or the value (a field, with its source). */
export interface QuoteResult { ref: string; found: boolean; cite?: string; text?: string; value?: unknown; source?: string; note?: string }
export interface TypedToolDef { name: string; description: string; parameters: JsonSchema; output: JsonSchema }
type Card = Record<string, unknown>;
interface Req { at: string; who: Caller; objs: Map<string, StoredObject | null>; links: Map<string, string[]> }
const groupBy = <T>(xs: T[], k: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of xs) (m.get(k(x)) ?? m.set(k(x), []).get(k(x))!).push(x); return m; };

const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
const NATURAL = new Intl.Collator("en", { numeric: true });
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
/** Experiment switch (A/B on a small model): HARNESS_QUERY_CORE=off hides the query core's arguments (within, fields,
 *  by, first, last), its description line and `parts` on read from the tools; answers keep `total`. Default: on. */
const QUERY_CORE = process.env.HARNESS_QUERY_CORE !== "off";
/** The most objects one find shows (owner, 2026-11-18: 20, not more — a small model's context). */
const MAX_LIMIT = 20;
/** The most candidates an order or a count of each reads when the store says how many there are. */
const HARD_BOUND = 50_000;
const LIMIT_TEXT = 1500, LIMIT_SHORT = 160, LIMIT_REFER = 300, REFERS_IN_FIND = 6, WIDE_UNPUSHED = 2000, RRF_K = 60;

type FilterKind = "rank" | "words" | "any" | "range" | "bool";
function filterKind(t: TypeExpr): FilterKind {
  const inner = t.kind === "list" ? t.of : t;
  if (inner.kind === "scalar") {
    if (inner.name === "text") return "rank";
    if (inner.name === "string") return "words";
    if (inner.name === "bool") return "bool";
    return "range";
  }
  return "any";
}

/** What find answers: a page of objects, or (with `by`) counts by value. `total` is how many match in all. */
export interface FindPage {
  verdict: "found" | "weak" | "none"; note: string; total: number; exact: boolean;
  items: Card[]; more?: Card[]; covers?: Card[];
  by?: string; groups?: Array<{ value: string; count: number; sample: string[] }>; others?: { groups: number; count: number };
}

export class TypedEngine {
  readonly spec: TypedSpec;
  private readonly stores: Record<string, Store>;
  private readonly functions: Record<string, TypedFunctionImpl>;
  private opened: Promise<void> | undefined;
  private cacheHeads = "";
  private checkedAt = 0;
  private readonly cites = new Map<string, string>();
  private readonly texts = new Map<string, ReturnType<typeof analysed>>();
  /** functions the spec uses as helpers (parse, cite): run by the runtime, not offered as tools */
  private readonly helpers: Set<string>;

  constructor(spec: TypedSpec, stores: Record<string, Store>, functions: Record<string, TypedFunctionImpl> = {}) {
    const errs: string[] = [];
    for (const t of Object.values(spec.types)) if (!stores[t.store]) errs.push(`types.${t.name}.store: no adapter for store "${t.store}"`);
    for (const f of Object.keys(spec.functions)) if (!functions[f]) errs.push(`functions.${f}: the project does not implement it`);
    for (const f of Object.keys(functions)) if (!spec.functions[f]) errs.push(`function ${f} is implemented but not declared in the spec`);
    this.helpers = new Set([...Object.values(spec.values).flatMap((v) => (v.parse ? [v.parse] : [])), ...Object.values(spec.types).flatMap((t) => (t.implements.Citable?.cite ? [t.implements.Citable.cite] : []))]);
    const known = new Set(this.toolNames(spec));
    for (const s of Object.values(spec.surfaces)) for (const n of s.tools) if (!known.has(n)) errs.push(`surfaces.${s.name}: ${n} is not a tool (tools: ${[...known].join(", ")})`);
    if (errs.length) throw new HarnessError(500, errs);
    this.spec = spec;
    this.stores = stores;
    this.functions = functions;
  }

  // ------------------------------------------------------------------------------------------- schemas

  /** The JSON schema of a value of a type, as a model writes or reads it. */
  schemaOf(t: TypeExpr, description?: string, loose = false): JsonSchema {
    const d = description ? { description } : {};
    switch (t.kind) {
      case "list": return { type: "array", items: this.schemaOf(t.of, undefined, loose), ...d };
      case "enum": return { type: "string", enum: t.values, ...d };
      case "ref": return this.schemaOf({ kind: "value", name: this.spec.types[t.target]!.id }, description, loose);
      case "value": {
        const v = this.spec.values[t.name]!;
        const p = valuePattern(this.spec, t.name);
        const base = this.schemaOf({ kind: "scalar", name: v.base });
        // a value with a parse function takes free text too (the runtime parses it); the pattern then only guides
        return { ...base, ...(p && !(loose && v.parse) ? { pattern: p } : {}), examples: v.examples, description: [description, v.description].filter(Boolean).join(": ") };
      }
      case "struct": {
        const fs = this.spec.structs[t.name]!;
        return { type: "object", properties: Object.fromEntries(Object.entries(fs).map(([n, f]) => [n, this.schemaOf(f.type)])), required: Object.entries(fs).filter(([, f]) => !f.optional).map(([n]) => n), ...d };
      }
      case "scalar":
        switch (t.name) {
          case "int": return { type: "integer", ...d };
          case "decimal": return { type: "number", ...d };
          case "bool": return { type: "boolean", ...d };
          case "date": return { type: "string", pattern: DATE.source, ...d, description: `${description ? `${description}, ` : ""}YYYY-MM-DD` };
          default: return { type: "string", ...d };
        }
    }
  }

  private findProps(t: ObjectType): PropDecl[] { return Object.values(t.properties).filter((p) => p.find); }
  /** Whether objects of `t` sit inside others (the from side of a composition link). */
  private isPart(t: ObjectType): boolean { return Object.values(this.spec.links).some((l) => l.kind === "composition" && l.from === t.name); }
  /** Every object below these refs, along every composition link, one level at a time (one neighbours call a level). */
  private async below(r: Req, refs: string[], max: number): Promise<{ refs: Set<string>; cut: boolean }> {
    const links = Object.values(this.spec.links).filter((l) => l.kind === "composition");
    const out = new Set<string>();
    let frontier = [...new Set(refs)];
    for (let depth = 0; frontier.length && out.size < max && depth < 32; depth++) {
      const next: string[] = [];
      for (const l of links) for (const xs of (await this.nb(r, l, "backward", frontier)).values()) for (const x of xs) if (!out.has(x)) { out.add(x); next.push(x); }
      frontier = next;
    }
    return { refs: out, cut: out.size >= max };
  }
  private withNote(extra: string, p: FindPage): FindPage { return extra ? { ...p, note: `${p.note} Within: ${extra}.` } : p; }
  /** What lies inside an object, at every depth: how many parts, and how many of each value of the parts' grouped
   *  enum properties ("level": chapter 6, article 65 …) — so that a model reading a chapter is told "8 articles" and
   *  does not count a list itself. */
  private async parts(r: Req, o: StoredObject): Promise<Card> {
    const { refs, cut } = await this.below(r, [o.ref], WIDE_UNPUSHED);
    const objs = (await this.objs(r, [...refs])).filter((x) => !(x.validity && x.validity.status !== "in_force"));
    const out: Record<string, Record<string, number>> = {};
    for (const x of objs) {
      const xt = this.spec.types[x.type];
      if (!xt) continue;
      for (const p of Object.values(xt.properties)) {
        if (!p.group || p.type.kind !== "enum") continue;
        const v = x.props[p.name];
        if (typeof v !== "string") continue;
        (out[p.name] ??= {})[v] = (out[p.name]![v] ?? 0) + 1;
      }
    }
    return { total: objs.length, ...(cut ? { exact: false } : {}), ...out };
  }
  /** A card with only the properties asked for (and what names it). */
  private pick(c: Card, fields?: string[]): Card {
    if (!fields?.length) return c;
    const keep = new Set(["ref", "object", "cite", "match", "found", "note", ...fields]);
    return Object.fromEntries(Object.entries(c).filter(([k]) => keep.has(k)));
  }
  /** What `by` takes: each property declared group, a date one also by year and by month. */
  private groupKeys(t: ObjectType): string[] {
    return Object.values(t.properties).filter((p) => p.group).flatMap((p) => {
      const b = scalarBase(p.type, this.spec.values);
      return b === "date" || b === "datetime" ? [p.name, `${p.name}:year`, `${p.name}:month`] : [p.name];
    });
  }

  findSchema(t: ObjectType): JsonSchema {
    const props: Record<string, JsonSchema> = {};
    for (const p of this.findProps(t)) {
      const k = filterKind(p.type);
      const inner = p.type.kind === "list" ? p.type.of : p.type;
      if (k === "rank") props[p.name] = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: `${p.description ?? `words of the ${p.name}`}; 1–3 phrasings of the same need` };
      else if (k === "words") props[p.name] = { type: "array", items: { type: "string" }, minItems: 1, description: p.description ?? `words of the ${p.name}` };
      else if (k === "bool") props[p.name] = this.schemaOf(inner, p.description);
      else if (k === "range") props[p.name] = { type: "object", properties: { min: this.schemaOf(inner), max: this.schemaOf(inner) }, additionalProperties: false, description: `${p.description ?? p.name}: from min to max, inclusive` };
      else props[p.name] = { type: "array", items: this.schemaOf(inner, undefined, true), minItems: 1, description: `${p.description ?? p.name}: any of these` };
    }
    if (t.implements.Versioned) props.at = { type: "string", pattern: DATE.source, description: "read as in force on this date, YYYY-MM-DD (default today)" };
    if (QUERY_CORE && this.isPart(t)) props.within = { type: "array", items: { type: "string" }, maxItems: 12, description: "only objects anywhere inside these (their refs): the parts of a chapter, of a document" };
    if (QUERY_CORE) props.fields = { type: "array", items: { type: "string", enum: Object.keys(t.properties) }, description: "show only these properties (fewer words: a listing of numbers and dates); empty: all" };
    const groups = QUERY_CORE ? this.groupKeys(t) : [];
    if (groups.length) props.by = { type: "string", enum: groups, description: "how many of each: count the matches by this property instead of listing them (a date by year or month)" };
    const extremes = QUERY_CORE ? Object.values(t.properties).filter((p) => p.extreme).map((p) => p.name) : [];
    if (extremes.length) {
      props.first = { type: "string", enum: extremes, description: "list from the smallest / earliest value of this property (without words)" };
      props.last = { type: "string", enum: extremes, description: "list from the largest / latest value of this property: the newest, the highest (without words)" };
    }
    props.limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `how many results to show (default ${this.spec.search.limit}, at most ${MAX_LIMIT}); every answer says how many match in all (total)` };
    return { type: "object", properties: props, additionalProperties: false };
  }

  private idSchema(): JsonSchema {
    const ids = [...new Set(Object.values(this.spec.types).map((t) => t.id))];
    return { type: "string", examples: ids.flatMap((v) => this.spec.values[v]!.examples.slice(0, 1)) };
  }
  private readSchema(): JsonSchema {
    const parses = Object.values(this.spec.types).some((t) => this.spec.values[t.id]!.parse);
    return { type: "object", required: ["refs"], additionalProperties: false, properties: {
      refs: { type: "array", minItems: 1, items: this.idSchema(), description: parses ? "refs as tools returned them, or as written (a citation)" : "refs as tools returned them" },
      at: { type: "string", pattern: DATE.source, description: "read as in force on this date, YYYY-MM-DD (default today)" },
      ...(QUERY_CORE ? { fields: { type: "array", items: { type: "string", enum: [...new Set(Object.values(this.spec.types).flatMap((t) => Object.keys(t.properties)))] }, description: "show only these properties; empty: all" } } : {}) } };
  }
  private quoteSchema(): JsonSchema {
    return { type: "object", required: ["refs"], additionalProperties: false, properties: {
      refs: { type: "array", minItems: 1, items: { type: "string" }, description: 'an object "<ref>", its lines "<ref> #n-m", or one field "<ref>:<field>"' },
      at: { type: "string", pattern: DATE.source, description: "YYYY-MM-DD (default today)" } } };
  }
  fnSchema(f: FunctionDecl): JsonSchema {
    return { type: "object", additionalProperties: false,
      properties: Object.fromEntries(Object.entries(f.args).map(([n, a]) => [n, this.schemaOf(a.type, a.description, true)])),
      ...(Object.values(f.args).some((a) => a.required) ? { required: Object.entries(f.args).filter(([, a]) => a.required).map(([n]) => n) } : {}) };
  }

  /** The shape of the cards a type's objects are shown with. `mode`: find (in a result page), short (more), read. */
  cardSchema(t: ObjectType, mode: "find" | "short" | "read"): JsonSchema {
    const S = (x: JsonSchema) => x;
    const props: Record<string, JsonSchema> = { ref: this.schemaOf({ kind: "value", name: t.id }), object: { type: "string", enum: [t.name] }, cite: { type: "string" }, match: { type: "number" } };
    const title = t.implements.Citable?.title, text = t.implements.Citable?.text;
    if (mode === "short") {
      if (title) props.title = { type: "string" };
      if (text) props.text = { type: "string" };
    } else {
      for (const p of Object.values(t.properties)) if (!t.hide.includes(p.name)) props[p.name] = this.schemaOf(p.type);
      const ref = { type: "string" };
      if (t.implements.Part) props.path = S({ type: "array", items: { type: "object", required: ["ref", "cite"], properties: { ref, cite: { type: "string" }, title: { type: "string" }, lead: { type: "string" } } } });
      const childCards = this.childTypes(t).map((c) => this.cardSchema(this.spec.types[c]!, "short"));
      if (childCards.length) props.children = mode === "find" ? { type: "integer" } : { type: "array", items: childCards.length === 1 ? childCards[0]! : { anyOf: childCards } };
      if (childCards.length && mode === "read") props.parts = { type: "object", description: "how many parts lie inside it, at every depth: total, and by each grouped enum property of the parts", properties: { total: { type: "integer" }, exact: { type: "boolean" } }, additionalProperties: { type: "object", additionalProperties: { type: "integer" } } };
      const refer = { type: "array", items: { type: "object", required: ["ref", "cite"], properties: { ref, cite: { type: "string" }, text: { type: "string" } } } };
      if (t.implements.Referring) { props.refers = refer; if (mode === "read") props.citedBy = refer; }
      if (t.implements.Versioned) {
        props.validity = { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["in_force", "not_yet", "ended"] }, since: { type: "string" }, until: { type: "string" } } };
        if (mode === "read") props.versions = { type: "array", items: { type: "object", required: ["from"], properties: { from: { type: "string" }, to: { type: "string" }, by: { type: "string" } } } };
      }
      if (mode === "read" && text) props.lines = { type: "array", items: { type: "object", required: ["n", "text"], properties: { n: { type: "integer" }, text: { type: "string" } } } };
    }
    return { type: "object", required: ["ref", "object", "cite"], properties: props, additionalProperties: false };
  }
  pageSchema(t: ObjectType): JsonSchema {
    return { type: "object", required: ["verdict", "note", "items"], additionalProperties: false, properties: {
      verdict: { type: "string", enum: ["found", "weak", "none"] }, note: { type: "string" },
      total: { type: "integer", description: "how many match in all, whatever is shown" }, exact: { type: "boolean", description: "false: at least total" },
      by: { type: "string" },
      groups: { type: "array", items: { type: "object", required: ["value", "count", "sample"], properties: { value: { type: "string" }, count: { type: "integer" }, sample: { type: "array", items: { type: "string" } } } } },
      others: { type: "object", properties: { groups: { type: "integer" }, count: { type: "integer" } } },
      items: { type: "array", items: this.cardSchema(t, "find") }, more: { type: "array", items: this.cardSchema(t, "short") },
      covers: { type: "array", items: { type: "object", required: ["ref", "cite"], properties: { ref: { type: "string" }, cite: { type: "string" } } } } } };
  }
  private missingSchema(): JsonSchema {
    return { type: "object", required: ["ref", "found", "note"], properties: { ref: { type: "string" }, found: { type: "boolean", enum: [false] }, note: { type: "string" } } };
  }
  readOutput(): JsonSchema {
    return { type: "array", items: { anyOf: [...Object.values(this.spec.types).map((t) => this.cardSchema(t, "read")), this.missingSchema()] } };
  }
  quoteOutput(): JsonSchema {
    return { type: "array", items: { type: "object", required: ["ref", "found"], additionalProperties: false, properties: {
      ref: { type: "string" }, found: { type: "boolean" }, cite: { type: "string" }, text: { type: "string" }, value: {}, source: { type: "string" }, note: { type: "string" } } } };
  }

  // ------------------------------------------------------------------------------------------- stores

  /** Open every store with the spec once, and check that each can do what the spec asks of its types. */
  private ready(): Promise<void> {
    this.opened ??= (async () => {
      const errs: string[] = [];
      for (const [name, s] of Object.entries(this.stores)) {
        await s.open(this.spec, name);
        const c = s.capabilities();
        for (const t of Object.values(this.spec.types).filter((x) => x.store === name)) {
          if (!c.search && this.findProps(t).some((p) => filterKind(p.type) === "rank")) errs.push(`types.${t.name}: finds by text, but store "${name}" has no text search`);
          if (!c.at && t.implements.Versioned) errs.push(`types.${t.name}: Versioned, but store "${name}" does not read at a date`);
        }
      }
      if (errs.length) throw new HarnessError(500, errs);
    })();
    return this.opened;
  }
  async heads(): Promise<string> {
    const stores = [...new Set(Object.values(this.spec.types).map((t) => t.store))];
    return (await Promise.all(stores.map((s) => this.stores[s]!.heads()))).join("|");
  }
  /** Caches (citations, analysed texts) hold while every store's heads stay the same; heads are asked at most once a second. */
  private async fresh(): Promise<void> {
    await this.ready();
    if (Date.now() - this.checkedAt < 1000) return;
    this.checkedAt = Date.now();
    const h = await this.heads();
    if (h !== this.cacheHeads) { this.cacheHeads = h; this.cites.clear(); this.texts.clear(); }
  }
  /** Data health from every store: values that broke their type, and how full each property is. */
  async health() {
    await this.fresh();
    const per = await Promise.all(Object.values(this.stores).map((s) => (s.health ? s.health(today()) : Promise.resolve(undefined))));
    return {
      ontology: this.spec.ontology, version: 2, heads: this.cacheHeads,
      objects: per.reduce((n, h) => n + (h?.objects ?? 0), 0),
      flags: per.flatMap((h) => h?.flags ?? []),
      fill: Object.assign({}, ...per.map((h) => h?.fill ?? {})) as Record<string, Record<string, string>>,
    };
  }

  /** One request: the date read at, who asks, and the objects fetched so far (each store asked once per batch). */
  private req(at: string, who: Caller): Req { return { at, who, objs: new Map(), links: new Map() }; }

  /** The types a ref can belong to: those whose id value type it matches (all of them when none has a pattern). */
  private typesForRef(ref: string): ObjectType[] {
    const ts = Object.values(this.spec.types);
    const hit = ts.filter((t) => { const p = valuePattern(this.spec, t.id); return !p || new RegExp(p, "u").test(ref); });
    return hit;
  }
  private async load(r: Req, refs: readonly string[]): Promise<void> {
    const need = [...new Set(refs.filter((x) => !r.objs.has(x)))];
    if (!need.length) return;
    const byStore = new Map<string, string[]>();
    for (const ref of need) for (const s of new Set(this.typesForRef(ref).map((t) => t.store))) (byStore.get(s) ?? byStore.set(s, []).get(s)!).push(ref);
    for (const [s, list] of byStore) {
      const got = await this.stores[s]!.get(list, r.at, r.who);
      list.forEach((ref, i) => { const o = got[i]; if (o && this.spec.types[o.type]?.store === s && !r.objs.get(ref)) r.objs.set(ref, o); });
    }
    for (const ref of need) if (!r.objs.has(ref)) r.objs.set(ref, null);
  }
  private async objs(r: Req, refs: readonly string[]): Promise<StoredObject[]> {
    await this.load(r, refs);
    return refs.map((x) => r.objs.get(x)).filter((o): o is StoredObject => !!o);
  }
  /** A link from each ref; the store that holds the link's `from` type answers both directions. Asked once per
   *  request for each (link, direction, ref). */
  private async nb(r: Req, link: LinkDecl, dir: "forward" | "backward", refs: readonly string[]): Promise<Map<string, string[]>> {
    const key = (ref: string) => `${link.name}|${dir}|${ref}`;
    const need = [...new Set(refs.filter((x) => !r.links.has(key(x))))];
    if (need.length) {
      const got = await this.stores[this.spec.types[link.from]!.store]!.neighbours(link, dir, need, r.who);
      for (const x of need) r.links.set(key(x), got.get(x) ?? []);
    }
    return new Map(refs.map((x) => [x, r.links.get(key(x))!]));
  }
  /** The ancestors of many objects at once, one level at a time (one neighbours and one get per level, not per object). */
  private async prefetchPaths(r: Req, objs: readonly StoredObject[]): Promise<void> {
    let level = [...objs];
    for (let depth = 0; level.length && depth < 32; depth++) {
      const next: string[] = [];
      for (const [name, group] of groupBy(level, (o) => this.spec.types[o.type]!.implements.Part?.link ?? "")) {
        if (!name) continue;
        const ups = await this.nb(r, this.spec.links[name]!, "forward", group.map((o) => o.ref));
        for (const o of group) { const up = ups.get(o.ref)?.[0]; if (up && !r.objs.has(up)) next.push(up); }
      }
      level = await this.objs(r, [...new Set(next)]);
    }
  }

  // ------------------------------------------------------------------------------------------- views

  private titleOf(t: ObjectType, props: Record<string, unknown>) { const k = t.implements.Citable?.title; return k && typeof props[k] === "string" ? (props[k] as string) : undefined; }
  private textOf(t: ObjectType, props: Record<string, unknown>) { const k = t.implements.Citable?.text; return k && typeof props[k] === "string" ? (props[k] as string) : undefined; }

  /** The citation: the store's own, else the spec's cite function, else the ref. */
  private async cite(r: Req, o: StoredObject): Promise<string> {
    const hit = this.cites.get(o.ref);
    if (hit !== undefined) return hit;
    const fn = this.spec.types[o.type]!.implements.Citable?.cite;
    let c = o.cite ?? o.ref;
    if (!o.cite && fn) {
      const arg = Object.keys(this.spec.functions[fn]!.args)[0]!;
      const v = await this.functions[fn]!({ [arg]: o.ref }, { engine: this, at: r.at, who: r.who });
      if (typeof v === "string" && v) c = v;
    }
    this.cites.set(o.ref, c);
    return c;
  }

  /** Ancestors along the type's Part link, root first: each with its title, or the first line of its text. */
  private async path(r: Req, o: StoredObject): Promise<Card[]> {
    const out: Card[] = [];
    const seen = new Set([o.ref]);
    let cur = o;
    for (;;) {
      const name = this.spec.types[cur.type]!.implements.Part?.link;
      if (!name) break;
      const up = (await this.nb(r, this.spec.links[name]!, "forward", [cur.ref])).get(cur.ref)?.[0];
      const [p] = up && !seen.has(up) ? await this.objs(r, [up]) : [];
      if (!p) break;
      seen.add(p.ref);
      const pt = this.spec.types[p.type]!;
      const title = this.titleOf(pt, p.props), lead = linesOf(this.textOf(pt, p.props) ?? "")[0];
      out.unshift({ ref: p.ref, cite: await this.cite(r, p), ...(title ? { title } : lead ? { lead } : {}) });
      cur = p;
    }
    return out;
  }
  /** Types whose objects can be parts of a `t` (a composition link ending at t). */
  private childTypes(t: ObjectType): string[] {
    return [...new Set(Object.values(this.spec.links).filter((l) => l.kind === "composition" && l.to === t.name).map((l) => l.from))];
  }
  /** Direct parts: objects joined to `o` by a composition link — and that link is their own nearest parent. */
  private async children(r: Req, o: StoredObject): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    for (const l of Object.values(this.spec.links)) {
      if (l.kind !== "composition" || l.to !== o.type) continue;
      const kids = await this.objs(r, (await this.nb(r, l, "backward", [o.ref])).get(o.ref) ?? []);
      // a deeper part (its own Part link is another link, and set) is listed under its own parent
      const deeper = new Set<string>();
      for (const [own, group] of groupBy(kids, (c) => this.spec.types[c.type]!.implements.Part?.link ?? "")) {
        if (!own || own === l.name) continue;
        const ups = await this.nb(r, this.spec.links[own]!, "forward", group.map((c) => c.ref));
        for (const c of group) if (ups.get(c.ref)?.length) deeper.add(c.ref);
      }
      // parts as in force on the date, as find lists them (a store may list a part with no version in force)
      out.push(...kids.filter((c) => !deeper.has(c.ref) && !(c.validity && c.validity.status !== "in_force")));
    }
    return out;
  }
  private async descendants(r: Req, o: StoredObject, max = 500): Promise<StoredObject[]> {
    const out: StoredObject[] = [], queue = [o], seen = new Set([o.ref]);
    while (queue.length && out.length < max) {
      for (const c of await this.children(r, queue.shift()!)) if (!seen.has(c.ref)) { seen.add(c.ref); out.push(c); queue.push(c); }
    }
    return out;
  }
  /** What `o` (and its parts) refers to — or, backward, what refers to `o` — with the start of each target's text. */
  private async refersOf(r: Req, o: StoredObject, backward: boolean, max: number): Promise<Card[]> {
    const name = this.spec.types[o.type]!.implements.Referring?.link;
    if (!name) return [];
    const inner = backward ? [] : await this.descendants(r, o);
    const own = new Set([o.ref, ...inner.map((x) => x.ref)]);
    const froms = [o, ...inner].filter((x) => this.spec.types[x.type]!.implements.Referring?.link === name);
    const m = await this.nb(r, this.spec.links[name]!, backward ? "backward" : "forward", froms.map((x) => x.ref));
    const targets = [...new Set(froms.flatMap((x) => m.get(x.ref) ?? []))].filter((x) => !own.has(x)).slice(0, max);
    const out: Card[] = [];
    for (const t of await this.objs(r, targets)) {
      const tt = this.spec.types[t.type]!;
      const text = this.textOf(tt, t.props) ?? this.titleOf(tt, t.props);
      out.push({ ref: t.ref, cite: await this.cite(r, t), ...(text ? { text: clip(text, LIMIT_REFER) } : {}) });
    }
    return out;
  }

  /** The whole text of an object: its own text, then its parts' (depth first, in order). What `lines` and `quote`
   *  number and cite, so that a part is cited inside its whole ("<ref> #n-m"). */
  private async wholeText(r: Req, o: StoredObject): Promise<string> {
    const t = this.spec.types[o.type]!;
    const own = this.textOf(t, o.props) ?? "";
    if (!this.childTypes(t).length) return own;
    const parts: string[] = own ? [own] : [];
    for (const c of await this.children(r, o)) { const w = await this.wholeText(r, c); if (w) parts.push(w); }
    return parts.join("\n");
  }

  private shownProps(t: ObjectType, props: Record<string, unknown>, clipText: boolean): Card {
    const out: Card = {};
    for (const [k, v] of Object.entries(props)) {
      if (t.hide.includes(k) || v === undefined) continue;
      out[k] = clipText && typeof v === "string" && k === t.implements.Citable?.text ? clip(v, LIMIT_TEXT) : v;
    }
    return out;
  }

  private async card(r: Req, o: StoredObject, mode: "find" | "short" | "read", match?: number): Promise<Card> {
    const t = this.spec.types[o.type]!;
    const head: Card = { ref: o.ref, object: o.type, cite: await this.cite(r, o) };
    const m = match !== undefined ? { match: Math.round(match * 100) / 100 } : {};
    if (mode === "short") {
      const title = this.titleOf(t, o.props), text = this.textOf(t, o.props);
      return { ...head, ...(title ? { title } : {}), ...(text ? { text: clip(text, LIMIT_SHORT) } : {}), ...m };
    }
    const card: Card = { ...head, ...this.shownProps(t, o.props, mode === "find") };
    if (t.implements.Part) { const p = await this.path(r, o); if (p.length) card.path = p; }
    if (this.childTypes(t).length) {
      const kids = await this.children(r, o);
      if (mode === "find") { if (kids.length) card.children = kids.length; }
      else if (kids.length) {
        card.children = await Promise.all(kids.map((k) => this.card(r, k, "short")));
        if (QUERY_CORE) card.parts = await this.parts(r, o);
      }
    }
    if (t.implements.Referring) {
      const out = await this.refersOf(r, o, false, mode === "find" ? REFERS_IN_FIND : 50);
      if (out.length) card.refers = out;
      if (mode === "read") { const b = await this.refersOf(r, o, true, 20); if (b.length) card.citedBy = b; }
    }
    if (o.validity) card.validity = o.validity;
    if (mode === "read") {
      const text = t.implements.Citable?.text ? await this.wholeText(r, o) : "";
      if (text) card.lines = linesOf(text).map((l, i) => ({ n: i + 1, text: l }));
      if (o.versions?.length) card.versions = o.versions;
    }
    return { ...card, ...m };
  }

  // ------------------------------------------------------------------------------------------- parsing refs

  /** A value as the model wrote it → the value of its type: kept when it matches, else through the type's parse. */
  private async parseValue(r: Req, valueType: string, v: unknown): Promise<unknown> {
    const p = valuePattern(this.spec, valueType);
    if (typeof v !== "string" || (p && new RegExp(p, "u").test(v))) return v;
    const fn = this.spec.values[valueType]?.parse;
    if (!fn) return v;
    const arg = Object.keys(this.spec.functions[fn]!.args)[0]!;
    const out = await this.functions[fn]!({ [arg]: v }, { engine: this, at: r.at, who: r.who });
    return typeof out === "string" && out ? out : v;
  }
  /** A ref as written → the object, trying the value types of every type's refs; the deepest object when several. */
  private async resolve(r: Req, ref0: string): Promise<StoredObject | undefined> {
    const ref = ref0.trim();
    const [direct] = await this.objs(r, [ref]);
    if (direct) return direct;
    // a ref already written as a type's ref names that object or nothing: it is not read as something else
    if (Object.values(this.spec.types).some((t) => { const p = valuePattern(this.spec, t.id); return !!p && new RegExp(p, "u").test(ref); })) return undefined;
    const found: StoredObject[] = [];
    for (const t of Object.values(this.spec.types)) {
      const v = await this.parseValue(r, t.id, ref);
      const [o] = typeof v === "string" && v !== ref ? await this.objs(r, [v]) : [];
      if (o && !found.some((x) => x.ref === o.ref)) found.push(o);
    }
    // "mục 2.1 sổ tay HB-001" names the handbook and the section in it: the deepest object is the one meant
    for (const o of found) {
      let inner = false;
      for (const d of found) if (d !== o && (await this.within(r, d, o))) inner = true;
      if (!inner) return o;
    }
    return found[0];
  }
  /** Is `inner` a part of `outer`, through composition links? */
  private async within(r: Req, inner: StoredObject, outer: StoredObject): Promise<boolean> {
    const comp = Object.values(this.spec.links).filter((l) => l.kind === "composition");
    const seen = new Set<string>();
    let level = [inner];
    while (level.length) {
      const next: string[] = [];
      for (const l of comp) {
        const from = level.filter((x) => x.type === l.from).map((x) => x.ref);
        for (const ups of (await this.nb(r, l, "forward", from)).values()) for (const up of ups) {
          if (up === outer.ref) return true;
          if (!seen.has(up)) { seen.add(up); next.push(up); }
        }
      }
      level = await this.objs(r, next);
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------- operations

  private date(at: unknown): string {
    if (at === undefined || at === null || at === "") return today();
    if (typeof at !== "string" || !DATE.test(at)) throw new HarnessError(400, [`at: expected a date YYYY-MM-DD, got ${JSON.stringify(at)}`]);
    return at;
  }
  private type(name: string): ObjectType {
    const t = this.spec.types[name];
    if (!t) throw new HarnessError(400, [`type: unknown type ${JSON.stringify(name)} (known: ${Object.keys(this.spec.types).join(", ")})`]);
    return t;
  }

  async find(typeName: string, args: unknown, who: Caller = {}): Promise<FindPage> {
    const t = this.type(typeName);
    if (!this.findProps(t).length) throw new HarnessError(400, [`${t.name} has no property marked find: true`]);
    // a date on a type without versions changes nothing: it is dropped, not refused (models send `at` to any tool)
    const args1 = !t.implements.Versioned && args && typeof args === "object" && "at" in args ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== "at")) : args;
    const a = checkArgs(this.findSchema(t), args1);
    if (!a.ok) throw new HarnessError(400, a.errors);
    await this.fresh();
    const { at: at0, limit: lim0, by, first, last, within, fields: show, ...given } = a.value as { at?: string; limit?: number; by?: string; first?: string; last?: string; within?: string[]; fields?: string[] } & Record<string, unknown>;
    const orderBy = first ?? last;
    if (first && last) throw new HarnessError(400, ["first and last: one of them"]);
    if (by && orderBy) throw new HarnessError(400, ["by counts, first / last list: one of them in a call"]);
    const r = this.req(this.date(at0), who);
    const limit = Math.max(1, Math.min(MAX_LIMIT, lim0 ?? this.spec.search.limit));
    // values written loosely ("sổ tay hb 1") are parsed into their type before they filter
    const filters: Filter[] = [];
    const rankers: PropDecl[] = [];
    for (const p of this.findProps(t)) {
      let v = given[p.name];
      if (v === undefined) continue;
      const k = filterKind(p.type);
      if (k === "rank") { rankers.push(p); continue; }
      const inner = p.type.kind === "list" ? p.type.of : p.type;
      const vt = inner.kind === "value" ? inner.name : inner.kind === "ref" ? this.spec.types[inner.target]!.id : undefined;
      if (vt && Array.isArray(v)) v = await Promise.all(v.map((x) => this.parseValue(r, vt, x)));
      filters.push({ prop: p.name, kind: k, value: v });
    }
    const store = this.stores[t.store]!;
    // only the filters the store says it applies go to it; the others are applied here, on far more candidates
    // A ranked search keeps its ref filters (doc …) with the runtime: the phrasings' ranks are fused over the whole base,
    // then filtered — as it was measured (the store filtering first changes the fused order: 14 of 22 traced finds).
    // A listing (no words) gives them to the store: that is what lets "every article of a document" be listed and counted.
    // A store that gives only its first few candidates over the whole base (searchLimit below the runtime's bound) gets
    // them too: filtered here, a capped list over the whole base holds none of a document's parts.
    const isRef = (f: Filter) => { const pt = t.properties[f.prop]?.type; return (pt?.kind === "list" ? pt.of : pt)?.kind === "ref"; };
    const capLimit = store.capabilities().searchLimit;
    const holdRefs = rankers.length > 0 && !(capLimit !== undefined && capLimit < WIDE_UNPUSHED);
    const pushed = filters.filter((f) => !(holdRefs && isRef(f)) && (store.applies ? store.applies(t, f) : store.capabilities().filters.includes(f.kind)));
    const phrasings = rankers.flatMap((p) => given[p.name] as string[]);
    if (orderBy && rankers.length) throw new HarnessError(400, [`${first ? "first" : "last"} orders a listing: leave out the words (${rankers.map((p) => p.name).join(", ")}), filter instead`]);
    const title = t.implements.Citable?.title;
    // a filter the store cannot apply is applied here, after the store's limit: ask far wider then, or matches are lost
    const unpushed = filters.length > pushed.length;
    // a listing (no words) is counted: it scans up to the bound unless the store counts it itself
    // within: the candidates are what lies below those refs (the store's count knows nothing of it)
    // a citation is read into a ref; what it was read as is said, so a citation read too wide (a chapter as its
    // document) shows instead of passing for the chapter
    const read = within?.length ? await Promise.all(within.map(async (x) => ({ x, ref: (await this.resolve(r, x))?.ref }))) : [];
    const readAs = read.filter((w) => w.ref !== w.x).map((w) => (w.ref ? `"${w.x}" read as ${w.ref}` : `"${w.x}" matches no object`)).join("; ");
    // an empty list of an optional argument is no argument (models send `within: []`, `fields: []`)
    const inside = within?.length ? await this.below(r, read.flatMap((w) => (w.ref ? [w.ref] : [])), WIDE_UNPUSHED) : undefined;
    const storeCounts = !inside && !rankers.length && !unpushed && !!store.count && !t.implements.Versioned;
    // a listing is ordered over all its candidates (up to the bound), never over a first handful in the store's order;
    // a count (by) looks at every candidate too, with words or without
    let wide = unpushed || !rankers.length || by || inside ? WIDE_UNPUSHED : Math.min(200, limit * 5);
    // an order (first / last) or a count of each (by) is only right over every candidate: when the store can count
    // them, ask for all of them (up to a hard bound); past it the answer says it is not settled
    let known: number | undefined;                                   // how many the store says match, when asked
    if ((orderBy || by) && !rankers.length && !unpushed && !inside && store.count && !t.implements.Versioned) {
      known = await store.count({ type: t, filters: pushed, at: r.at }, who);
      wide = Math.min(HARD_BOUND, Math.max(wide, known));
    }
    // each phrasing is searched on its own, and the rankings fused (reciprocal rank): a broad phrasing that matches
    // half the document must not crowd out a precise one — every phrasing gets its best matches in
    const fields = [...new Set([...(title ? [title] : []), ...rankers.map((p) => p.name)])];
    let hits: Array<{ ref: string; score: number }>;
    if (inside && !rankers.length) hits = [...inside.refs].map((ref) => ({ ref, score: 1 }));
    else if (!rankers.length) hits = (await store.scan({ type: t, filters: pushed, at: r.at, limit: wide }, who)).map((ref) => ({ ref, score: 1 }));
    else if (phrasings.length === 1) hits = await store.search({ type: t, phrasings, fields, filters: pushed, at: r.at, limit: wide }, who);
    else {
      const runs = await Promise.all(phrasings.map((ph) => store.search({ type: t, phrasings: [ph], fields, filters: pushed, at: r.at, limit: wide }, who)));
      const fused = new Map<string, number>();
      for (const run of runs) run.forEach((h, i) => fused.set(h.ref, (fused.get(h.ref) ?? 0) + 1 / (RRF_K + i + 1)));
      hits = [...fused].map(([ref, score]) => ({ ref, score })).sort((a, b) => b.score - a.score).slice(0, wide);
    }
    if (inside && rankers.length) hits = hits.filter((h) => inside.refs.has(h.ref));
    // a listing the store counts: refs in natural order, objects read only until the page is full
    if (!rankers.length) hits.sort((a, b) => NATURAL.compare(a.ref, b.ref));
    let objs: StoredObject[];
    if (storeCounts && !by && !orderBy) {
      objs = [];
      for (let i = 0, kept = 0; i < hits.length && kept < limit; i += limit * 2) {
        const got = await this.objs(r, hits.slice(i, i + limit * 2).map((h) => h.ref));
        objs.push(...got);
        kept += got.filter((o) => o.type === t.name && filters.every((f) => passes(o.props, f, words))).length;
      }
    } else objs = await this.objs(r, hits.map((h) => h.ref));
    if (rankers.length && t.implements.Part) await this.prefetchPaths(r, objs);   // each candidate's path is its context
    const order = new Map(hits.map((h, i) => [h.ref, i]));
    const scored: Array<{ o: StoredObject; score: number; titled: boolean }> = [];
    const scoreIn = async (objs: StoredObject[]) => { for (const o of objs) {
      if (o.type !== t.name || (o.validity && o.validity.status !== "in_force")) continue;
      if (!filters.every((f) => passes(o.props, f, words))) continue;     // every filter holds, whatever the store did
      if (!rankers.length) { scored.push({ o, score: 1, titled: false }); continue; }
      const ttl = this.titleOf(t, o.props);
      const context = t.implements.Part ? (await this.path(r, o)).map((s) => `${s.title ?? ""}\n${s.lead ?? ""}`).join("\n") : "";
      let score = 0;
      for (const p of rankers) {
        const key = `${r.at}|${o.ref}|${p.name}`;
        const txt = this.texts.get(key) ?? this.texts.set(key, analysed([ttl ?? "", String(o.props[p.name] ?? ""), context].join("\n"))).get(key)!;
        for (const ph of given[p.name] as string[]) score = Math.max(score, coverage(ph, txt));
      }
      // an object whose whole title stands in a phrasing is what the author filed the matter under: it ranks first
      const tp = ttl ? pairs(words(ttl)) : new Set<string>();
      const titled = tp.size >= 2 && phrasings.some((ph) => { const q = pairs(words(ph)); return [...tp].every((x) => q.has(x)); });
      if (score > 0 || titled) scored.push({ o, score, titled });
    } };
    await scoreIn(objs);
    // the ref filters held back from a ranked search (above) are applied to the store's candidates over the whole base;
    // a store that gives only its first few candidates (a large base) may hold none of the filtered object's parts among
    // them. When fewer than a page match, the store is asked again with them applied, and what it adds comes after.
    const held = rankers.length ? filters.filter((f) => isRef(f) && !pushed.includes(f) && (store.applies ? store.applies(t, f) : store.capabilities().filters.includes(f.kind))) : [];
    if (held.length && scored.length < limit && !inside) {
      const seen = new Set(scored.map((x) => x.o.ref));
      const again = (await Promise.all(phrasings.map((ph) => store.search({ type: t, phrasings: [ph], fields, filters: [...pushed, ...held], at: r.at, limit: wide }, who))))
        .flatMap((run) => run).filter((h) => !seen.has(h.ref) && !order.has(h.ref));
      const add = [...new Map(again.map((h) => [h.ref, h])).values()];
      add.forEach((h, i) => order.set(h.ref, hits.length + i));
      const more = await this.objs(r, add.map((h) => h.ref));
      if (t.implements.Part) await this.prefetchPaths(r, more);
      await scoreIn(more);
    }
    const byStore = this.spec.search.order === "store";
    // a listing comes in the refs' natural order (a document's: article 2 before 10), as parts are listed by read;
    // a ranked search: the store's order when it ranks, else by score, ties in the refs' natural order
    if (!rankers.length) scored.sort((x, y) => NATURAL.compare(x.o.ref, y.o.ref));
    else scored.sort((x, y) => Number(y.titled) - Number(x.titled) || (byStore ? order.get(x.o.ref)! - order.get(y.o.ref)! : y.score - x.score || NATURAL.compare(x.o.ref, y.o.ref)));
    // how many match in all, apart from how many are shown: exact unless the candidates reached their bound
    const counted = storeCounts ? await store.count!({ type: t, filters: pushed, at: r.at }, who) : undefined;
    const total = counted ?? scored.length;
    const exact = inside ? !inside.cut : counted !== undefined || hits.length < wide;
    if (by) return this.withNote(readAs, await this.counted(r, t, by, scored.map((x) => x.o), { rankers, phrasings, given, exact, store, storeMayCount: !inside, filters: pushed, who }));
    if (orderBy) {
      const p = orderBy, dir = first ? 1 : -1;
      const v = (o: StoredObject) => o.props[p];
      scored.sort((x, y) => (v(x.o) === undefined ? 1 : 0) - (v(y.o) === undefined ? 1 : 0) || (v(x.o) === undefined ? 0 : (String(v(x.o)) < String(v(y.o)) ? -dir : String(v(x.o)) > String(v(y.o)) ? dir : 0)) || NATURAL.compare(x.o.ref, y.o.ref));
    }
    // candidates cut at the bound, filters left to the runtime: an empty result does not mean that nothing matches
    const cut = unpushed && hits.length >= wide;
    if (!scored.length && cut) {
      const left = filters.filter((f) => !pushed.includes(f)).map((f) => f.prop).join(", ");
      return { verdict: "weak" as const, note: `Not settled: store "${t.store}" cannot apply ${left} itself; the first ${wide} candidates were checked and none matched. Narrow the search with other filters or words.`, total: 0, exact: false, items: [] };
    }
    if (!scored.length) {
      const covers = await this.covers(r, t);
      // a filter may be what emptied the result: say how many match without the filters, so the next call can drop them
      // which part emptied it: the filters alone, and the words alone — the next call drops or changes the right one
      let without = "";
      if (filters.length && rankers.length) {
        const names = filters.map((f) => f.prop).join(", ");
        const only = (await this.objs(r, await store.scan({ type: t, filters: pushed, at: r.at, limit: 200 }, who))).filter((o) => filters.every((f) => passes(o.props, f, words)));
        const free = await store.search({ type: t, phrasings, fields: [...new Set([...(title ? [title] : []), ...rankers.map((p) => p.name)])], filters: [], at: r.at, limit: 20 }, who);
        without = ` With ${names} as given nothing matches the words of ${rankers.map((p) => p.name).join(" / ")}.`
          + (only.length ? ` ${names} alone ${only.length === 1 ? "matches 1" : `match ${only.length}`} (${only.slice(0, 5).map((o) => o.ref).join(", ")}).` : "")
          + (free.length ? ` The words alone match ${free.length >= 20 ? "20 or more" : free.length} without ${filters.length > 1 ? "these filters" : "this filter"}.` : "")
          + (only.length || free.length ? " Drop or change the part that does not fit." : "");
      }
      return { verdict: "none" as const, note: (t.notes.none ?? `No ${t.name} matches.${covers.length ? " covers lists what the data holds." : ""}`) + without + (readAs ? ` Within: ${readAs}.` : ""), total: 0, exact: true, items: [], ...(covers.length ? { covers } : {}) };
    }
    const full = Math.min(this.spec.search.full, limit);
    const items = await Promise.all(scored.slice(0, full).map((x) => this.card(r, x.o, "find", rankers.length ? x.score : undefined)));
    const more = await Promise.all(scored.slice(full, limit).map((x) => this.card(r, x.o, "short", rankers.length ? x.score : undefined)));
    const best = Math.max(...scored.slice(0, full).map((x) => x.score));
    const weak = rankers.length > 0 && best < this.spec.search.weak_below;
    const note = weak
      ? t.notes.weak ?? "Nothing here speaks clearly of it (match = share of the phrasing's word pairs found). The data may not hold the answer: say so rather than stretch a near match."
      : t.notes.found ?? (rankers.length ? `Best first.${t.implements.Part ? " Each path gives where it stands: the titles, or the first line of the part above (a value is often stated there)." : ""}` : `${t.name} objects matching the filters.`);
    const capped = cut ? ` Store "${t.store}" could not apply every filter and the first ${WIDE_UNPUSHED} candidates were checked: narrow the search.` : "";
    if (show?.length) { items.splice(0, items.length, ...items.map((c) => this.pick(c, show))); more.splice(0, more.length, ...more.map((c) => this.pick(c, show))); }
    const shown = items.length + more.length;
    const top = orderBy ? scored.find((x) => x.o.props[orderBy] !== undefined) : undefined;
    const orderCut = known !== undefined ? known > wide : hits.length >= wide;
    const ordered = !orderBy ? "" : orderCut ? ` Not settled: only the first ${wide} candidates could be ordered; narrow the filters (a year, a type) and ask again.` : top
      ? ` Ordered by ${orderBy}, ${first ? "smallest / earliest" : "largest / latest"} first: ${String(top.o.props[orderBy])} (${top.o.ref}).${scored.some((x) => x.o.props[orderBy] === undefined) ? ` Objects without ${orderBy} come last.` : ""}`
      : ` None has ${orderBy}.`;
    // a listing's total is how many there are; a ranked search's only how many share some of the words
    const howMany = !(shown < total || !exact) ? ""
      : rankers.length ? ` ${exact ? total : `At least ${total}`} share some of the words; the ${shown} best are shown.`
      : ` ${exact ? total : `At least ${total}`} match, ${shown} shown: ${exact ? `there are ${total}` : "the bound was reached"}; narrow the filters to see the others.`;
    return { verdict: weak ? ("weak" as const) : ("found" as const), note: note + ordered + capped + howMany + (readAs ? ` Within: ${readAs}.` : ""), total, exact, items, ...(more.length ? { more } : {}) };
  }

  /** When nothing matches: the objects the type's ref properties point to (what the data holds). */
  /** `by`: how many of the matches have each value of a property (a date by year or month), with sample refs to cite.
   *  With words, a match is an object holding every word of one phrasing (a count must not hang on a ranking score).
   *  A store that counts gives each enum / bool value's count itself, exactly. */
  private async counted(r: Req, t: ObjectType, by: string, objs: StoredObject[], c: { rankers: PropDecl[]; phrasings: string[]; given: Record<string, unknown>; exact: boolean; store: Store; storeMayCount: boolean; filters: Filter[]; who: Caller }): Promise<FindPage> {
    const [prop, period] = by.split(":") as [string, "year" | "month" | undefined];
    const p = t.properties[prop]!;
    let pool = objs;
    if (c.rankers.length) {
      const title = t.implements.Citable?.title;
      pool = objs.filter((o) => {
        const have = new Set(words([title ? String(o.props[title] ?? "") : "", ...c.rankers.map((x) => String(o.props[x.name] ?? ""))].join("\n")));
        return c.phrasings.some((ph) => { const w = words(ph); return w.length > 0 && w.every((x) => have.has(x)); });
      });
    }
    const keyOf = (v: unknown): string[] => {
      if (v === undefined || v === null || v === "") return ["(none)"];
      if (Array.isArray(v)) return v.length ? v.flatMap(keyOf) : ["(none)"];
      const s = String(v);
      return [period === "year" ? s.slice(0, 4) : period === "month" ? s.slice(0, 7) : s];
    };
    const groups = new Map<string, { count: number; sample: string[] }>();
    for (const o of [...pool].sort((a, b) => NATURAL.compare(a.ref, b.ref)))
      for (const k of new Set(keyOf(o.props[prop]))) { const g = groups.get(k) ?? { count: 0, sample: [] }; g.count++; if (g.sample.length < 3) g.sample.push(o.ref); groups.set(k, g); }
    let total = pool.length, exact = c.exact;
    // a store that counts: each value of an enum / bool counted by the store, over every object, not over the candidates
    const vals = p.type.kind === "enum" ? p.type.values : scalarBase(p.type, this.spec.values) === "bool" ? ["true", "false"] : undefined;
    if (vals && c.storeMayCount && !c.rankers.length && c.store.count && !t.implements.Versioned) {
      const f = (v: string): Filter => ({ prop, kind: p.type.kind === "enum" ? "any" : "bool", value: p.type.kind === "enum" ? [v] : v === "true" });
      const fs = vals.map(f);
      if (fs.every((x) => (c.store.applies ? c.store.applies(t, x) : c.store.capabilities().filters.includes(x.kind)))) {
        for (const [i, v] of vals.entries()) {
          const n = await c.store.count({ type: t, filters: [...c.filters, fs[i]!], at: r.at }, c.who);
          if (n) groups.set(v, { count: n, sample: groups.get(v)?.sample ?? [] }); else groups.delete(v);
        }
        total = await c.store.count({ type: t, filters: c.filters, at: r.at }, c.who);
        exact = true;
      }
    }
    const all = [...groups].map(([value, g]) => ({ value, count: g.count, sample: g.sample })).sort((a, b) => b.count - a.count || NATURAL.compare(a.value, b.value));
    const shown = all.slice(0, MAX_LIMIT), rest = all.slice(MAX_LIMIT);
    const others = rest.length ? { groups: rest.length, count: rest.reduce((n, g) => n + g.count, 0) } : undefined;
    if (!total) return { verdict: "none" as const, note: `No ${t.name} matches${c.rankers.length ? " every word of a phrasing" : ""}.`, total: 0, exact, by, groups: [], items: [] };
    const note = `${exact ? total : `At least ${total}`} ${t.name} object(s) match${c.rankers.length ? " (every word of a phrasing present)" : ""}, counted by ${by}: ${shown.map((g) => `${g.value} ${g.count}`).join(", ")}${others ? `, and ${others.groups} other value(s) with ${others.count}` : ""}.${exact ? "" : " The bound of candidates was reached: narrow the filters for exact counts."} Each group's sample refs can be cited.`;
    return { verdict: "found" as const, note, total, exact, by, groups: shown, ...(others ? { others } : {}), items: [] };
  }

  private async covers(r: Req, t: ObjectType): Promise<Card[]> {
    const targets = [...new Set(Object.values(t.properties).flatMap((p) => { const i = p.type.kind === "list" ? p.type.of : p.type; return i.kind === "ref" ? [i.target] : []; }))];
    const out: Card[] = [];
    for (const n of targets) {
      const tt = this.spec.types[n]!;
      const refs = await this.stores[tt.store]!.scan({ type: tt, filters: [], at: r.at, limit: 50 }, r.who);
      for (const o of await this.objs(r, refs)) out.push({ ref: o.ref, cite: await this.cite(r, o) });
    }
    return out.slice(0, 50);
  }

  async read(refs: unknown, opt: { at?: unknown; fields?: unknown } = {}, who: Caller = {}): Promise<Card[]> {
    const a = checkArgs(this.readSchema(), { refs, ...(opt.at !== undefined ? { at: opt.at } : {}), ...(opt.fields !== undefined ? { fields: opt.fields } : {}) });
    if (!a.ok) throw new HarnessError(400, a.errors);
    await this.fresh();
    const r = this.req(this.date(a.value.at), who);
    return Promise.all((a.value.refs as string[]).map(async (ref) => {
      const o = await this.resolve(r, ref.replace(/\s*#\d+(-\d+)?$/, ""));
      if (!o) return { ref, found: false, note: `no object has this ref (refs look like ${(this.idSchema().examples as string[]).join(", ")})` };
      return this.pick(await this.card(r, o, "read"), a.value.fields as string[] | undefined);
    }));
  }

  async quote(refs: unknown, opt: { at?: unknown } = {}, who: Caller = {}) {
    const a = checkArgs(this.quoteSchema(), { refs, ...(opt.at !== undefined ? { at: opt.at } : {}) });
    if (!a.ok) throw new HarnessError(400, a.errors);
    await this.fresh();
    const r = this.req(this.date(a.value.at), who);
    return Promise.all((a.value.refs as string[]).map(async (ref): Promise<QuoteResult> => {
      const lines = /^(.*?)\s*#(\d+)(?:-(\d+))?$/.exec(ref);
      const field = lines ? undefined : /^(.*):([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
      const o = await this.resolve(r, lines?.[1] ?? field?.[1] ?? ref);
      if (!o) return { ref, found: false, note: "no object has this ref" };
      const t = this.spec.types[o.type]!;
      const cite = await this.cite(r, o);
      const text = (t.implements.Citable?.text ? await this.wholeText(r, o) : "") || this.titleOf(t, o.props) || "";
      if (lines) {
        // a range that starts inside and runs past the end is read to the end (repaired, not refused)
        const all = linesOf(text), x = Number(lines[2]), y = Math.min(Number(lines[3] ?? lines[2]), all.length);
        if (x < 1 || x > all.length || x > y) return { ref, found: false, note: `${o.ref} has lines 1–${all.length}` };
        return { ref, found: true, cite, text: all.slice(x - 1, y).join("\n") };
      }
      if (field) {
        const f = field[2]!;
        const value = f === "validity" ? o.validity : f === "cite" ? cite : t.hide.includes(f) ? undefined : o.props[f];
        if (value === undefined) return { ref, found: false, note: t.properties[f] || f === "validity" ? `${o.ref} has no ${f} on record` : `${f} is not a field of ${t.name} (fields: ${Object.keys(t.properties).join(", ")})` };
        // where the value was read from, when the spec says so (`from`): an answer can cite the source too
        const from = t.properties[f]?.from, source = from ? o.props[from] : undefined;
        return { ref, found: true, cite, value, ...(typeof source === "string" ? { source } : {}) };
      }
      // an object with no text of its own (a document, a heading) is cited by its parts or a field, never as ""
      if (!text) return { ref, found: false, note: `${o.ref} has no text of its own: cite one of its parts, or a field ("${o.ref}:<field>")` };
      return { ref, found: true, cite, text };
    }));
  }

  async follow(link: string, refs: unknown, opt: { at?: unknown } = {}, who: Caller = {}) {
    const fw = this.spec.links[link], bw = Object.values(this.spec.links).find((l) => l.inverse === link);
    if (!fw && !bw) throw new HarnessError(400, [`link: unknown link ${JSON.stringify(link)}`]);
    const a = checkArgs({ type: "object", properties: { refs: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["refs"] }, { refs });
    if (!a.ok) throw new HarnessError(400, a.errors);
    await this.fresh();
    const r = this.req(this.date(opt.at), who);
    const list = a.value.refs as string[];
    const m = await this.nb(r, (fw ?? bw)!, fw ? "forward" : "backward", list);
    return { link, results: await Promise.all(list.map(async (ref) => ({ ref, items: await Promise.all((await this.objs(r, m.get(ref) ?? [])).map((o) => this.card(r, o, "short"))) }))) };
  }

  async call(fn: string, args: unknown, opt: { at?: unknown } = {}, who: Caller = {}): Promise<unknown> {
    const f = this.spec.functions[fn];
    if (!f) throw new HarnessError(400, [`fn: unknown function ${JSON.stringify(fn)} (known: ${Object.keys(this.spec.functions).join(", ")})`]);
    const a = checkArgs(this.fnSchema(f), args);
    if (!a.ok) throw new HarnessError(400, a.errors);
    await this.fresh();
    const out = await this.functions[fn]!(a.value, { engine: this, at: this.date(opt.at), who });
    // a function keeps its declared result type, or the call fails: a wrong shape never reaches a model
    const errs = check(this.schemaOf(f.result), out, `${fn}()`);
    if (errs.length && out !== undefined && out !== null) throw new HarnessError(500, [`${fn} returned a value that breaks its type ${f.resultRaw}: ${errs[0]}`]);
    return out;
  }

  // ------------------------------------------------------------------------------------------- tools

  private toolNames(spec: TypedSpec = this.spec): string[] {
    return [
      ...Object.values(spec.types).filter((t) => Object.values(t.properties).some((p) => p.find)).map((t) => `find_${snake(t.name)}`),
      "read", "quote",
      ...Object.keys(spec.functions).filter((f) => !this.helpers.has(f)),
    ];
  }

  private features(t: ObjectType): string[] {
    return [t.implements.Part && "its path (titles, or the lead line above)", t.implements.Referring && "its references", t.implements.Versioned && "validity on `at`"].filter((x): x is string => !!x);
  }

  toolDef(name: string): TypedToolDef {
    if (name === "read") {
      const parts = Object.values(this.spec.types).flatMap((t) => this.features(t));
      return { name, parameters: this.readSchema(), output: this.readOutput(),
        description: `Read objects in full by ref: numbered lines to cite${parts.length ? `, ${[...new Set(parts)].join(", ")}` : ""}, and their parts.` };
    }
    if (name === "quote") return { name, parameters: this.quoteSchema(), output: this.quoteOutput(), description: 'The exact text behind refs an answer cites: an object, its lines ("<ref> #n-m") or one field ("<ref>:<field>").' };
    const t = Object.values(this.spec.types).find((x) => `find_${snake(x.name)}` === name);
    if (t) {
      const ranks = this.findProps(t).filter((p) => filterKind(p.type) === "rank").map((p) => p.name);
      const f = this.features(t);
      // what the model matches a question to: how many, of each, first / last, inside (only what this type allows)
      const also = ["how many (total)", ...(this.groupKeys(t).length ? ["of each (by)"] : []), ...(Object.values(t.properties).some((p) => p.extreme) ? ["newest (last)"] : []), ...(this.isPart(t) ? ["inside (within)"] : [])];
      return { name, parameters: this.findSchema(t), output: this.pageSchema(t),
        description: `Find ${t.description ?? t.name}${ranks.length ? `; best first by ${ranks.join(" / ")}` : ""}.${f.length ? ` Each result shows ${f.join(", ")}.` : ""} ${QUERY_CORE ? `Also ${also.join(", ")}. ` : ""}Verdict found, weak or none.` };
    }
    const fn = this.spec.functions[name];
    if (fn && !this.helpers.has(name)) return { name, description: fn.description, parameters: this.fnSchema(fn), output: this.schemaOf(fn.result) };
    throw new HarnessError(400, [`tool: unknown tool ${JSON.stringify(name)} (tools: ${this.toolNames().join(", ")})`]);
  }

  /** Tool definitions for a surface, an explicit list, or (no argument) every tool. */
  tools(surfaceOrList?: string | readonly string[]): TypedToolDef[] {
    const list = surfaceOrList === undefined ? this.toolNames() : typeof surfaceOrList === "string" ? this.spec.surfaces[surfaceOrList]?.tools : surfaceOrList;
    if (!list) throw new HarnessError(400, [`surface: unknown surface ${JSON.stringify(surfaceOrList)} (known: ${Object.keys(this.spec.surfaces).join(", ")})`]);
    return list.map((n) => this.toolDef(n));
  }

  async tool(name: string, args: unknown, who: Caller = {}): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "read") return this.read(a.refs, { at: a.at, fields: a.fields }, who);
    if (name === "quote") return this.quote(a.refs, { at: a.at }, who);
    const t = Object.values(this.spec.types).find((x) => `find_${snake(x.name)}` === name);
    if (t) return this.find(t.name, a, who);
    if (this.spec.functions[name] && !this.helpers.has(name)) return this.call(name, a, {}, who);
    throw new HarnessError(400, [`tool: unknown tool ${JSON.stringify(name)} (tools: ${this.toolNames().join(", ")})`]);
  }

  /** HTTP `get`: read. */
  async get(refs: unknown, opt: { type?: string | undefined; at?: unknown } = {}, who: Caller = {}) { return this.read(refs, { at: opt.at }, who); }

  catalogue() {
    const s = this.spec;
    return {
      ontology: s.ontology, version: 2,
      values: Object.values(s.values).map((v) => ({ name: v.name, base: v.base, description: v.description, examples: v.examples, ...(v.parse ? { parse: v.parse } : {}) })),
      types: Object.values(s.types).map((t) => ({
        name: t.name, description: t.description, id: t.id, implements: Object.keys(t.implements),
        properties: Object.fromEntries(Object.values(t.properties).map((p) => [p.name, { type: p.raw, ...(p.find ? { find: filterKind(p.type) } : {}), ...(p.description ? { description: p.description } : {}) }])),
      })),
      links: Object.values(s.links).map((l) => ({ name: l.name, from: l.from, to: l.to, card: l.card, kind: l.kind, inverse: l.inverse, description: l.description })),
      functions: Object.values(s.functions).map((f) => ({ name: f.name, description: f.description, result: f.resultRaw, ...(this.helpers.has(f.name) ? { helper: true } : {}) })),
      tools: this.toolNames(),
      surfaces: Object.values(s.surfaces).map((x) => ({ name: x.name, description: x.description, tools: x.tools })),
    };
  }

  async close() {}
}
