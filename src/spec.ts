// SPEC — the declaration a project writes once: its object types (properties, time, provenance, the store that holds
// them, what agents see), the links between types (each with an inverse name and a semantic kind), its deterministic
// functions, and the surfaces (tool sets) granted to agent steps. The runtime refuses to start on a spec that breaks
// a rule below; every error names the place in the spec and what is expected there.

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Temporal = "versioned" | "current" | "none";
export type Provenance = "required" | "optional" | "none";
export type FilterMode = "exact" | "range" | "text" | true;
export type LinkCard = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
/** What a link means (the same kinds as the application ontology format, so the two can be joined later). */
export type LinkKind = "reference" | "composition" | "succession" | "derivation" | "correspondence";

export interface PropDecl {
  type: string;                     // string | text | span | int | decimal | quantity | date | datetime | enum | bool | ref<T> | list<T> | object
  values?: string[];                // enum, list<enum>
  filter?: FilterMode;
  description?: string;
  required?: boolean;
  default?: unknown;
}
export interface TypeDecl {
  name: string;
  description?: string;
  store: string;
  key: string;
  id_rule?: string;
  temporal: Temporal;
  versions_from?: string;
  provenance: Provenance;
  flags?: boolean;
  clearance?: string;
  title_prop?: string;
  properties: Record<string, PropDecl>;
  /** values the store computes for a card (a unit's path, numbered lines …): shown, never filtered */
  derived: Record<string, { description?: string }>;
  expose?: {
    find?: { filters: string[]; limit?: number; card?: string[]; description?: string };
    get?: { description?: string };
    card?: string[];
    follow?: string[];
  };
}
export interface LinkDecl {
  name: string;
  from: string;
  to: string;
  card: LinkCard;
  inverse: string;
  kind: LinkKind;
  description?: string;
  inverse_description?: string;
}
export interface ArgDecl extends PropDecl { required?: boolean }
export interface FunctionDecl {
  name: string;
  description: string;
  args: Record<string, ArgDecl>;
  result: string;
  reads: string[];
}
export interface SurfaceDecl { name: string; description?: string; tools: string[] }
export interface Spec {
  ontology: string;
  version: number;
  types: Record<string, TypeDecl>;
  links: Record<string, LinkDecl>;
  functions: Record<string, FunctionDecl>;
  surfaces: Record<string, SurfaceDecl>;
  /** the file it was read from, for messages */
  file?: string;
}

/** A link seen from one side: forward (`from` → `to`) under its name, backward under its inverse name. */
export interface LinkView { name: string; link: LinkDecl; backward: boolean; from: string; to: string; many: boolean; description?: string | undefined }

export class SpecError extends Error {
  readonly errors: string[];
  constructor(errors: string[], file?: string) {
    super(`spec${file ? ` ${file}` : ""} has ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
    this.errors = errors;
  }
}

const SCALARS = new Set(["string", "text", "span", "int", "decimal", "quantity", "date", "datetime", "enum", "bool", "object"]);
const TEMPORAL = new Set(["versioned", "current", "none"]);
const PROVENANCE = new Set(["required", "optional", "none"]);
const CARDS = new Set(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]);
const KINDS = new Set(["reference", "composition", "succession", "derivation", "correspondence"]);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `list<ref<Unit>>` → { list: true, base: "ref", target: "Unit" } */
export function parseType(t: string): { list: boolean; base: string; target?: string } | undefined {
  const l = /^list<(.+)>$/.exec(t);
  const inner = l ? l[1]! : t;
  const r = /^ref<([A-Za-z][A-Za-z0-9_]*)>$/.exec(inner);
  if (r) return { list: !!l, base: "ref", target: r[1]! };
  return SCALARS.has(inner) ? { list: !!l, base: inner } : undefined;
}

export function loadSpec(file: string): Spec {
  const raw = parse(readFileSync(file, "utf8")) as unknown;
  return buildSpec(raw, file);
}

/** Normalise and validate a parsed spec. Throws SpecError listing every problem found, not only the first. */
export function buildSpec(raw: unknown, file?: string): Spec {
  const errs: string[] = [];
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.ontology !== "string" || !r.ontology) errs.push("`ontology`: a project id (string) is required");
  if (typeof r.version !== "number") errs.push("`version`: a number is required");
  const types: Record<string, TypeDecl> = {};
  for (const [name, t0] of Object.entries((r.types ?? {}) as Record<string, any>)) {
    const t = t0 ?? {};
    const at = `types.${name}`;
    if (!NAME.test(name)) errs.push(`${at}: a type name is letters, digits and _`);
    if (typeof t.store !== "string") errs.push(`${at}.store: the store that holds the type is required`);
    if (typeof t.key !== "string") errs.push(`${at}.key: the property used as the stable key is required`);
    const temporal = t.temporal ?? "none";
    if (!TEMPORAL.has(temporal)) errs.push(`${at}.temporal: one of versioned | current | none, got ${JSON.stringify(temporal)}`);
    if (temporal === "versioned" && !t.versions_from) errs.push(`${at}.versions_from: a versioned type says where its versions come from`);
    const provenance = t.provenance ?? "none";
    if (!PROVENANCE.has(provenance)) errs.push(`${at}.provenance: one of required | optional | none, got ${JSON.stringify(provenance)}`);
    types[name] = {
      name, store: t.store, key: t.key, temporal, provenance, properties: t.properties ?? {}, derived: t.derived ?? {},
      ...(t.description ? { description: t.description } : {}), ...(t.id_rule ? { id_rule: t.id_rule } : {}),
      ...(t.versions_from ? { versions_from: t.versions_from } : {}), ...(t.flags ? { flags: true } : {}),
      ...(t.clearance ? { clearance: t.clearance } : {}), ...(t.title_prop ? { title_prop: t.title_prop } : {}),
      ...(t.expose ? { expose: t.expose } : {}),
    };
  }
  const links: Record<string, LinkDecl> = {};
  for (const [name, l0] of Object.entries((r.links ?? {}) as Record<string, any>)) {
    const l = l0 ?? {};
    links[name] = { name, from: l.from, to: l.to, card: l.card, inverse: l.inverse, kind: l.kind ?? "reference",
      ...(l.description ? { description: l.description } : {}), ...(l.inverse_description ? { inverse_description: l.inverse_description } : {}) };
  }
  const functions: Record<string, FunctionDecl> = {};
  for (const [name, f0] of Object.entries((r.functions ?? {}) as Record<string, any>)) {
    const f = f0 ?? {};
    functions[name] = { name, description: f.description ?? "", args: f.args ?? {}, result: f.result ?? "object", reads: f.reads ?? [] };
  }
  const surfaces: Record<string, SurfaceDecl> = {};
  for (const [name, s0] of Object.entries((r.surfaces ?? {}) as Record<string, any>)) {
    const s = s0 ?? {};
    surfaces[name] = { name, tools: Array.isArray(s.tools) ? s.tools : [], ...(s.description ? { description: s.description } : {}) };
  }
  const spec: Spec = { ontology: r.ontology, version: r.version, types, links, functions, surfaces, ...(file ? { file } : {}) };
  errs.push(...validate(spec));
  if (errs.length) throw new SpecError(errs, file);
  return spec;
}

function checkProp(spec: Spec, at: string, p: PropDecl | undefined): string[] {
  if (!p || typeof p !== "object") return [`${at}: a declaration { type: … } is required`];
  const t = typeof p.type === "string" ? parseType(p.type) : undefined;
  if (!t) return [`${at}.type: unknown type ${JSON.stringify(p.type)} (string, text, span, int, decimal, quantity, date, datetime, enum, bool, object, ref<T>, list<T>)`];
  const out: string[] = [];
  if (t.base === "ref" && !spec.types[t.target!]) out.push(`${at}.type: ref to unknown type ${t.target}`);
  if (t.base === "enum" && !(Array.isArray(p.values) && p.values.length)) out.push(`${at}.values: an enum lists its values`);
  if (p.filter !== undefined && ![true, "exact", "range", "text"].includes(p.filter as never)) out.push(`${at}.filter: true | exact | range | text`);
  if (p.filter === "range" && !["int", "decimal", "date", "datetime", "quantity"].includes(t.base)) out.push(`${at}.filter: range needs a number, date or quantity`);
  if (p.filter === "text" && !["string", "text", "span"].includes(t.base)) out.push(`${at}.filter: text needs a string, text or span`);
  return out;
}

/** The rules a spec must keep (document 02 §10, those that apply to this track). */
export function validate(spec: Spec): string[] {
  const errs: string[] = [];
  const views = new Map<string, number>();
  for (const l of Object.values(spec.links)) {
    const at = `links.${l.name}`;
    if (!spec.types[l.from]) errs.push(`${at}.from: unknown type ${JSON.stringify(l.from)}`);
    if (!spec.types[l.to]) errs.push(`${at}.to: unknown type ${JSON.stringify(l.to)}`);
    if (!CARDS.has(l.card)) errs.push(`${at}.card: one of ${[...CARDS].join(" | ")}`);
    if (!KINDS.has(l.kind)) errs.push(`${at}.kind: one of ${[...KINDS].join(" | ")}`);
    if (typeof l.inverse !== "string" || !l.inverse) errs.push(`${at}.inverse: every link names its inverse, so agents can go both ways`);
    for (const n of [l.name, l.inverse]) if (n) views.set(n, (views.get(n) ?? 0) + 1);
  }
  for (const [n, c] of views) if (c > 1) errs.push(`links: the name ${n} is used ${c} times (link and inverse names are one namespace)`);
  for (const t of Object.values(spec.types)) {
    const at = `types.${t.name}`;
    for (const [pn, p] of Object.entries(t.properties)) errs.push(...checkProp(spec, `${at}.properties.${pn}`, p));
    if (t.key && t.key !== "id" && !t.properties[t.key]) errs.push(`${at}.key: ${t.key} is not a property (or "id")`);
    if (t.title_prop && !t.properties[t.title_prop]) errs.push(`${at}.title_prop: ${t.title_prop} is not a property`);
    const known = (n: string) => n === "id" || n === "cite" || !!t.properties[n] || !!t.derived[n];
    const f = t.expose?.find;
    if (f) {
      for (const n of f.filters ?? []) {
        if (n === "at") { if (t.temporal !== "versioned") errs.push(`${at}.expose.find.filters: "at" needs temporal: versioned`); continue; }
        const p = t.properties[n];
        if (!p) errs.push(`${at}.expose.find.filters: ${n} is not a property`);
        else if (!p.filter) errs.push(`${at}.expose.find.filters: ${n} is not filterable (add filter: … to the property)`);
      }
      if (f.limit !== undefined && !(f.limit >= 1 && f.limit <= 20)) errs.push(`${at}.expose.find.limit: 1–20`);
      for (const n of f.card ?? []) if (!known(n)) errs.push(`${at}.expose.find.card: ${n} is neither a property nor a derived value`);
    }
    for (const n of t.expose?.card ?? []) if (!known(n)) errs.push(`${at}.expose.card: ${n} is neither a property nor a derived value`);
    for (const n of t.expose?.follow ?? []) {
      const v = linkView(spec, n);
      if (!v) errs.push(`${at}.expose.follow: ${n} is not a link or an inverse name`);
      else if (v.from !== t.name) errs.push(`${at}.expose.follow: ${n} starts from ${v.from}, not ${t.name}`);
    }
  }
  for (const f of Object.values(spec.functions)) {
    const at = `functions.${f.name}`;
    if (!f.description) errs.push(`${at}.description: agents choose a function by its description; write one`);
    for (const [an, a] of Object.entries(f.args)) errs.push(...checkProp(spec, `${at}.args.${an}`, a));
    if (!parseType(f.result)) errs.push(`${at}.result: unknown type ${JSON.stringify(f.result)}`);
    for (const t of f.reads) if (!spec.types[t]) errs.push(`${at}.reads: unknown type ${t}`);
  }
  for (const s of Object.values(spec.surfaces)) {
    for (const tool of s.tools) {
      const op = resolveTool(spec, tool);
      if (typeof op === "string") errs.push(`surfaces.${s.name}: ${op}`);
    }
  }
  return errs;
}

export function linkView(spec: Spec, name: string): LinkView | undefined {
  const fw = spec.links[name];
  if (fw) return { name, link: fw, backward: false, from: fw.from, to: fw.to, many: fw.card === "one-to-many" || fw.card === "many-to-many", description: fw.description };
  const bw = Object.values(spec.links).find((l) => l.inverse === name);
  if (bw) return { name, link: bw, backward: true, from: bw.to, to: bw.from, many: bw.card === "many-to-one" || bw.card === "many-to-many", description: bw.inverse_description };
  return undefined;
}

export type ToolOp = { op: "find" | "get"; type: string } | { op: "follow"; type: string; link: string } | { op: "call"; fn: string };

/** "Unit.find", "Unit.get", "Unit.hasChild", "resolveCitation" → the operation; a string is the reason it is not one. */
export function resolveTool(spec: Spec, tool: string): ToolOp | string {
  const dot = tool.indexOf(".");
  if (dot < 0) return spec.functions[tool] ? { op: "call", fn: tool } : `${tool} is not a function`;
  const type = tool.slice(0, dot), what = tool.slice(dot + 1);
  const t = spec.types[type];
  if (!t) return `${tool}: unknown type ${type}`;
  if (what === "find") return t.expose?.find ? { op: "find", type } : `${tool}: ${type} does not expose find`;
  if (what === "get") return { op: "get", type };
  if (!(t.expose?.follow ?? []).includes(what)) return `${tool}: ${type} does not expose the link ${what}`;
  return { op: "follow", type, link: what };
}
