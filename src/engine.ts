// ENGINE — one harness over a spec: it routes each type to the adapter of its store, checks every request against the
// spec before a store is touched, shapes results (verdict, note, items with refs), projects cards, runs the project's
// functions, and turns surfaces into tool definitions for agents. Generic: it knows nothing of any domain.

import { checkArgs, schemaOf, type JsonSchema } from "./args.ts";
import { linkView, parseType, resolveTool, type FunctionDecl, type LinkView, type Spec, type ToolOp, type TypeDecl } from "./spec.ts";

export type Verdict = "found" | "weak" | "none" | "ambiguous" | "not_recorded" | "error";

/** Who asks. The store applies the clearance; the runtime never widens it. */
export interface Caller { clearance?: string | undefined; id?: string | undefined }

export interface Item {
  ref: string;
  type: string;
  cite?: string | undefined;
  props: Record<string, unknown>;
  links?: Record<string, unknown> | undefined;
  validity?: unknown;
  flags?: unknown[] | undefined;
  match?: number | undefined;
}
export interface Page { verdict: Verdict; note: string; items: Item[]; more?: Item[] | undefined; [extra: string]: unknown }
export interface Missing { ref: string; found: false; note: string }
export interface FindQuery { filters: Record<string, unknown>; at?: string | undefined; limit: number }

export interface StoreAdapter {
  /** objects of one type matching the filters (already checked against the spec), in force on `at`, visible to `who` */
  find(type: TypeDecl, q: FindQuery, who: Caller): Promise<Page>;
  /** objects by ref; `type` when the caller named it, else the adapter tells the type from the ref */
  get(type: TypeDecl | undefined, refs: readonly string[], at: string | undefined, who: Caller): Promise<Array<Item | Missing>>;
  /** one link from each ref (forward or backward) */
  follow(link: LinkView, refs: readonly string[], at: string | undefined, who: Caller): Promise<Array<{ ref: string; items: Item[]; note?: string | undefined }>>;
  /** the store's change marker, for caches */
  heads(): Promise<string>;
  close?(): Promise<void>;
}

export interface FnContext { engine: Engine; at: string; who: Caller }
export type FunctionImpl = (args: Record<string, unknown>, ctx: FnContext) => Promise<unknown>;

export interface ToolDef { name: string; description: string; parameters: JsonSchema; op: ToolOp }

export class HarnessError extends Error {
  readonly status: number;
  readonly errors: string[];
  constructor(status: number, errors: string[]) {
    super(errors.join("; "));
    this.status = status;
    this.errors = errors;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export class Engine {
  readonly spec: Spec;
  private readonly adapters: Record<string, StoreAdapter>;
  private readonly functions: Record<string, FunctionImpl>;

  constructor(spec: Spec, adapters: Record<string, StoreAdapter>, functions: Record<string, FunctionImpl> = {}) {
    const errs: string[] = [];
    for (const t of Object.values(spec.types)) if (!adapters[t.store]) errs.push(`types.${t.name}.store: no adapter for store "${t.store}"`);
    for (const f of Object.keys(spec.functions)) if (!functions[f]) errs.push(`functions.${f}: the project does not implement it`);
    for (const f of Object.keys(functions)) if (!spec.functions[f]) errs.push(`function ${f} is implemented but not declared in the spec`);
    if (errs.length) throw new HarnessError(500, errs);
    this.spec = spec;
    this.adapters = adapters;
    this.functions = functions;
  }

  private type(name: string): TypeDecl {
    const t = this.spec.types[name];
    if (!t) throw new HarnessError(400, [`type: unknown type ${JSON.stringify(name)} (known: ${Object.keys(this.spec.types).join(", ")})`]);
    return t;
  }
  private date(at: unknown): string | undefined {
    if (at === undefined || at === null || at === "") return undefined;
    if (typeof at !== "string" || !DATE.test(at)) throw new HarnessError(400, [`at: expected a date YYYY-MM-DD, got ${JSON.stringify(at)}`]);
    return at;
  }

  /** The schema of `<Type>.find`'s arguments: the exposed filters, `at` for a versioned type, `limit`. */
  findSchema(t: TypeDecl): JsonSchema {
    const f = t.expose?.find;
    const props: Record<string, JsonSchema> = {};
    for (const n of f?.filters ?? []) {
      if (n === "at") props.at = { type: "string", pattern: DATE.source, description: "the date the law is read at, YYYY-MM-DD (default today)" };
      else props[n] = schemaOf(t.properties[n]!, true);
    }
    props.limit = { type: "integer", description: `how many results (default ${f?.limit ?? 6}, at most 20)` };
    return { type: "object", properties: props, additionalProperties: false };
  }
  fnSchema(f: FunctionDecl): JsonSchema {
    const props = Object.fromEntries(Object.entries(f.args).map(([n, a]) => [n, schemaOf(a)]));
    const required = Object.entries(f.args).filter(([, a]) => a.required).map(([n]) => n);
    return { type: "object", properties: props, ...(required.length ? { required } : {}), additionalProperties: false };
  }

  /** Keep the card's properties only (and the derived values it names). */
  private project(item: Item, card: string[] | undefined): Item {
    if (!card?.length) return item;
    const keep = new Set(card);
    return { ...item, props: Object.fromEntries(Object.entries(item.props).filter(([k]) => keep.has(k))) };
  }

  async find(typeName: string, args: unknown, who: Caller = {}): Promise<Page> {
    const t = this.type(typeName);
    if (!t.expose?.find) throw new HarnessError(400, [`${t.name} does not expose find`]);
    const r = checkArgs(this.findSchema(t), args);
    if (!r.ok) throw new HarnessError(400, r.errors);
    const { at, limit, ...filters } = r.value as { at?: string; limit?: number } & Record<string, unknown>;
    const lim = Math.max(1, Math.min(20, limit ?? t.expose.find.limit ?? 6));
    const page = await this.adapters[t.store]!.find(t, { filters, at: t.temporal === "versioned" ? (this.date(at) ?? today()) : this.date(at), limit: lim }, who);
    const card = t.expose.find.card ?? t.expose.card;
    return { ...page, items: page.items.map((i) => this.project(i, card)), ...(page.more ? { more: page.more } : {}) };
  }

  async get(refs: unknown, opt: { type?: string | undefined; at?: unknown } = {}, who: Caller = {}): Promise<Array<Item | Missing>> {
    const r = checkArgs({ type: "object", properties: { refs: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["refs"] }, { refs });
    if (!r.ok) throw new HarnessError(400, r.errors);
    const list = r.value.refs as string[];
    const at = this.date(opt.at);
    const t = opt.type ? this.type(opt.type) : undefined;
    // without a type, every store is asked; a ref belongs to the first store that knows it
    const stores = t ? [t.store] : [...new Set(Object.values(this.spec.types).map((x) => x.store))];
    const out = new Map<string, Item | Missing>();
    for (const s of stores) {
      const left = list.filter((x) => !out.has(x) || !("type" in out.get(x)!));
      if (!left.length) break;
      for (const got of await this.adapters[s]!.get(t, left, at, who)) if (!out.has(got.ref) || "type" in got) out.set(got.ref, got);
    }
    return list.map((ref) => {
      const got = out.get(ref) ?? { ref, found: false as const, note: "no object of the harness has this ref" };
      if (!("type" in got)) return got;
      const gt = this.spec.types[got.type];
      return gt ? this.project(got, gt.expose?.card) : got;
    });
  }

  async follow(link: string, refs: unknown, opt: { at?: unknown } = {}, who: Caller = {}) {
    const v = linkView(this.spec, link);
    if (!v) throw new HarnessError(400, [`link: unknown link ${JSON.stringify(link)} (known: ${Object.values(this.spec.links).flatMap((l) => [l.name, l.inverse]).join(", ")})`]);
    const r = checkArgs({ type: "object", properties: { refs: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["refs"] }, { refs });
    if (!r.ok) throw new HarnessError(400, r.errors);
    const from = this.type(v.from), to = this.type(v.to);
    // a link inside one store is followed by that store; across stores, the key is read on the owning side (one hop)
    const res = await this.adapters[from.store]!.follow(v, r.value.refs as string[], this.date(opt.at), who);
    return { link: v.name, kind: v.link.kind, ...(v.description ? { means: v.description } : {}),
      results: res.map((x) => ({ ...x, items: x.items.map((i) => this.project(i, to.expose?.find?.card ?? to.expose?.card)) })) };
  }

  async call(fn: string, args: unknown, opt: { at?: unknown } = {}, who: Caller = {}): Promise<unknown> {
    const f = this.spec.functions[fn];
    if (!f) throw new HarnessError(400, [`fn: unknown function ${JSON.stringify(fn)} (known: ${Object.keys(this.spec.functions).join(", ")})`]);
    const r = checkArgs(this.fnSchema(f), args);
    if (!r.ok) throw new HarnessError(400, r.errors);
    const at = this.date((r.value.at as string | undefined) ?? opt.at) ?? today();
    return this.functions[fn]!(r.value, { engine: this, at, who });
  }

  /** Types, links (both directions), functions and surfaces, as an agent or a developer reads them. */
  catalogue() {
    const s = this.spec;
    return {
      ontology: s.ontology, version: s.version,
      types: Object.values(s.types).map((t) => ({
        name: t.name, description: t.description, temporal: t.temporal, provenance: t.provenance,
        properties: Object.fromEntries(Object.entries(t.properties).map(([n, p]) => [n, { type: p.type, ...(p.values ? { values: p.values } : {}), ...(p.filter ? { filter: p.filter } : {}), ...(p.description ? { description: p.description } : {}) }])),
        derived: t.derived, find: t.expose?.find?.filters ?? null, card: t.expose?.card ?? null, follow: t.expose?.follow ?? [],
      })),
      links: Object.values(s.links).map((l) => ({ name: l.name, from: l.from, to: l.to, card: l.card, kind: l.kind, inverse: l.inverse, description: l.description })),
      functions: Object.values(s.functions).map((f) => ({ name: f.name, description: f.description, args: f.args, result: f.result })),
      surfaces: Object.values(s.surfaces).map((x) => ({ name: x.name, description: x.description, tools: x.tools })),
    };
  }

  /** Tool definitions for a surface (or an explicit list "Unit.find", "resolveCitation" …). */
  tools(surfaceOrList?: string | readonly string[]): ToolDef[] {
    const list = surfaceOrList === undefined ? [...new Set(Object.values(this.spec.surfaces).flatMap((s) => s.tools))] : typeof surfaceOrList === "string" ? this.spec.surfaces[surfaceOrList]?.tools : surfaceOrList;
    if (!list) throw new HarnessError(400, [`surface: unknown surface ${JSON.stringify(surfaceOrList)} (known: ${Object.keys(this.spec.surfaces).join(", ")})`]);
    return list.map((name) => this.toolDef(name));
  }

  toolName(op: ToolOp): string {
    if (op.op === "call") return op.fn;
    if (op.op === "follow") return `${lower(op.type)}_${op.link}`;
    return `${lower(op.type)}_${op.op}`;
  }

  toolDef(name: string): ToolDef {
    const op = resolveTool(this.spec, name);
    if (typeof op === "string") throw new HarnessError(400, [op]);
    const refs = (what: string): JsonSchema => ({ type: "object", properties: { refs: { type: "array", items: { type: "string" }, minItems: 1, description: what } }, required: ["refs"], additionalProperties: false });
    if (op.op === "call") { const f = this.spec.functions[op.fn]!; return { name: op.fn, description: f.description, parameters: this.fnSchema(f), op }; }
    const t = this.spec.types[op.type]!;
    if (op.op === "find") {
      return { name: this.toolName(op), op, parameters: this.findSchema(t),
        description: t.expose?.find?.description ?? `Find ${t.name} objects${t.description ? ` (${t.description})` : ""} by ${(t.expose?.find?.filters ?? []).join(", ")}. Returns a verdict (found | weak | none | ambiguous) and items with refs.` };
    }
    if (op.op === "get") {
      const p = refs(`refs of ${t.name} objects`);
      if (t.temporal === "versioned") (p.properties as Record<string, JsonSchema>).at = { type: "string", pattern: DATE.source, description: "date read at, YYYY-MM-DD" };
      return { name: this.toolName(op), op, parameters: p, description: t.expose?.get?.description ?? `Read ${t.name} objects by ref: their card.` };
    }
    if (op.op !== "follow") throw new HarnessError(400, [`${name}: not a tool`]);
    const v = linkView(this.spec, op.link)!;
    return { name: this.toolName(op), op, parameters: refs(`refs of ${t.name} objects`),
      description: `${v.description ?? `Follow ${v.name}`} (${t.name} → ${v.to}, ${v.link.kind}).` };
  }

  /** Run a generated tool by name with an agent's arguments. */
  async tool(name: string, args: unknown, who: Caller = {}): Promise<unknown> {
    const def = Object.values(this.spec.surfaces).flatMap((s) => s.tools).concat(Object.keys(this.spec.functions))
      .map((n) => resolveTool(this.spec, n)).find((op) => typeof op !== "string" && this.toolName(op) === name);
    const op = def ?? this.opFromName(name);
    if (!op || typeof op === "string") throw new HarnessError(400, [`tool: unknown tool ${JSON.stringify(name)}`]);
    const a = (args ?? {}) as Record<string, unknown>;
    switch (op.op) {
      case "find": return this.find(op.type, a, who);
      case "get": return this.get(a.refs, { type: op.type, at: a.at }, who);
      case "follow": return this.follow(op.link, a.refs, { at: a.at }, who);
      case "call": return this.call(op.fn, a, {}, who);
    }
  }
  private opFromName(name: string): ToolOp | undefined {
    for (const t of Object.values(this.spec.types)) {
      const p = `${lower(t.name)}_`;
      if (!name.startsWith(p)) continue;
      const what = name.slice(p.length);
      const op = resolveTool(this.spec, `${t.name}.${what}`);
      if (typeof op !== "string") return op;
    }
    return undefined;
  }

  /** The kind of a property's value ("ref" to another type, "list"), for adapters that need it. */
  static propBase(t: TypeDecl, prop: string) { const p = t.properties[prop]; return p ? parseType(p.type) : undefined; }

  async heads(): Promise<string> {
    const stores = [...new Set(Object.values(this.spec.types).map((t) => t.store))];
    return (await Promise.all(stores.map((s) => this.adapters[s]!.heads()))).join("|");
  }
  async close() {
    for (const a of new Set(Object.values(this.adapters))) await a.close?.();
  }
}
