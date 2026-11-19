// TYPED SPEC (version 2) — every value has a type, and the type decides what the harness does with it.
//
//   values:      value types: a base type with meaning and a constraint (pattern, examples), and optionally a `parse`
//                function that turns free text into the value ("nđ 99/2020" → "99/2020/NĐ-CP")
//   structs:     named records of typed fields (results of functions)
//   types:       object types; `id` names the value type of their refs; every property is typed; `find: true` makes a
//                property a parameter of the type's find tool (the kind of filter comes from its type); `group: true`
//                lets find count by it (`by`: an enum, ref, bool, string, or a date by year / month); `extreme: true` lets
//                find order by it (`first` / `last`: a date or a number)
//   implements:  the built-in interfaces a type takes on, each giving it fixed behaviour in every output:
//                  Citable   { title?, text?, cite? }  ref to cite, numbered lines, quote, field refs "<ref>:<field>"
//                  Versioned {}                        read as in force on `at`, validity, versions
//                  Part      { link }                  its place: path (each ancestor's title, or its first line)
//                  Referring { link }                  what it refers to (with the start of the target's text)
//   links, functions, surfaces: as in version 1, but a function's arguments and result are typed (no `object`)
//
// There is no `derived:` block: a value the store does not hold either follows from an interface or is a function.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SpecError, type LinkCard, type LinkKind } from "../spec.ts";

export type Scalar = "string" | "text" | "int" | "decimal" | "date" | "datetime" | "bool";
export type TypeExpr =
  | { kind: "scalar"; name: Scalar }
  | { kind: "enum"; values: string[] }
  | { kind: "value"; name: string }
  | { kind: "struct"; name: string }
  | { kind: "ref"; target: string }
  | { kind: "list"; of: TypeExpr };

export interface ValueDecl { name: string; base: Scalar; pattern?: string; examples: string[]; description?: string; parse?: string }
export interface StructField { type: TypeExpr; optional: boolean; raw: string }
/** `from`: the property (a ref) naming the object this value was read from — quoted with the value, as its source. */
/** `group`: find may count its objects by this property (`by`); `extreme`: find may order by it (`first` / `last`). */
export interface PropDecl { name: string; type: TypeExpr; raw: string; description?: string; find: boolean; group?: boolean; extreme?: boolean; from?: string }
export interface Interfaces {
  Citable?: { title?: string; text?: string; cite?: string };
  Versioned?: Record<string, never>;
  Part?: { link: string };
  Referring?: { link: string };
}
export type Verdict = "found" | "weak" | "none";
export interface ObjectType {
  name: string;
  description?: string;
  store: string;
  id: string;                                   // value type of the refs
  properties: Record<string, PropDecl>;
  implements: Interfaces;
  hide: string[];                               // properties left out of every card
  notes: Partial<Record<Verdict, string>>;      // what the model should do next, per verdict
  /** where the type lives in its store, in that store kind's terms; read by the store's adapter (optional: conventions) */
  source?: Record<string, unknown>;
}
export interface LinkDecl { name: string; from: string; to: string; card: LinkCard; inverse: string; kind: LinkKind; description?: string; inverse_description?: string; source?: Record<string, unknown> }
export interface FunctionDecl { name: string; description: string; args: Record<string, { type: TypeExpr; raw: string; required: boolean; description?: string }>; result: TypeExpr; resultRaw: string }
export interface SurfaceDecl { name: string; description?: string; tools: string[] }
/** weak_below: best match under it → verdict weak; full: results shown with their whole card; order: the store's
 *  ranking (its text / vector index) or the runtime's coverage of word pairs, titled objects first either way. */
export interface SearchPolicy { weak_below: number; full: number; limit: number; order: "store" | "coverage" }
export interface TypedSpec {
  ontology: string;
  version: 2;
  values: Record<string, ValueDecl>;
  structs: Record<string, Record<string, StructField>>;
  types: Record<string, ObjectType>;
  links: Record<string, LinkDecl>;
  functions: Record<string, FunctionDecl>;
  surfaces: Record<string, SurfaceDecl>;
  search: SearchPolicy;
  file?: string;
}

const SCALARS = new Set<Scalar>(["string", "text", "int", "decimal", "date", "datetime", "bool"]);
const CARDS = new Set(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]);
const KINDS = new Set(["reference", "composition", "succession", "derivation", "correspondence"]);
const INTERFACES = new Set(["Citable", "Versioned", "Part", "Referring"]);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Fields the runtime puts on every card; a property cannot take these names. */
export const CARD_KEYS = new Set(["ref", "object", "cite", "match", "path", "children", "refers", "citedBy", "validity", "versions", "lines"]);

/**
 * "text", "date", "enum[a, b]", "DocNumber", "ref<Unit>", "list<enum[a, b]>", "list<ref<Unit>>", "Quote" → a type.
 * `enum` alone takes its values from the declaration's `values`. A string is the reason it is not a type.
 */
export function parseTypeExpr(raw: string, names: { values: Set<string>; structs: Set<string>; types: Set<string> }, values?: unknown): TypeExpr | string {
  const s = raw.trim();
  const list = /^list<(.+)>$/.exec(s);
  if (list) { const of = parseTypeExpr(list[1]!, names, values); return typeof of === "string" ? of : { kind: "list", of }; }
  const ref = /^ref<([A-Za-z][A-Za-z0-9_]*)>$/.exec(s);
  if (ref) return names.types.has(ref[1]!) ? { kind: "ref", target: ref[1]! } : `ref to unknown type ${ref[1]}`;
  const en = /^enum\[(.*)\]$/.exec(s);
  if (en) { const v = en[1]!.split(",").map((x) => x.trim()).filter(Boolean); return v.length ? { kind: "enum", values: v } : "an enum lists its values"; }
  if (s === "enum") return Array.isArray(values) && values.length ? { kind: "enum", values: values.map(String) } : "an enum lists its values (values: [...] or enum[a, b])";
  if (SCALARS.has(s as Scalar)) return { kind: "scalar", name: s as Scalar };
  if (names.values.has(s)) return { kind: "value", name: s };
  if (names.structs.has(s)) return { kind: "struct", name: s };
  if (s === "object") return "`object` says nothing of its content: declare a struct";
  return `unknown type ${JSON.stringify(s)} (${[...SCALARS].join(", ")}, enum[…], a value type, a struct, ref<T>, list<T>)`;
}

/** The pattern of a value type, with `<Other>` replaced by the other value type's pattern. */
export function valuePattern(spec: Pick<TypedSpec, "values">, name: string, seen: string[] = []): string | undefined {
  const v = spec.values[name];
  if (!v?.pattern) return undefined;
  return v.pattern.replace(/<([A-Za-z][A-Za-z0-9_]*)>/g, (m, n: string) => {
    if (seen.includes(n)) return m;
    const inner = valuePattern(spec, n, [...seen, name]);
    return inner ? inner.replace(/^\^/, "").replace(/\$$/, "") : m;
  });
}

export function loadTypedSpec(file: string): TypedSpec { return buildTypedSpec(readSpecFile(file), file); }
/** A spec file as parsed YAML, before validation (to derive a variant of a spec in tests and tools). */
/** The kind of value a type holds at bottom: a scalar's name, a value type's base, "enum", "ref", "struct"; a list's element's. */
export function scalarBase(t: TypeExpr, values: Record<string, { base?: string }>): string {
  return t.kind === "scalar" ? t.name : t.kind === "value" ? String(values[t.name]?.base ?? "string") : t.kind === "list" ? scalarBase(t.of, values) : t.kind;
}

export function readSpecFile(file: string): any { return parse(readFileSync(file, "utf8")); }

export function buildTypedSpec(raw: unknown, file?: string): TypedSpec {
  const errs: string[] = [];
  const r = (raw ?? {}) as Record<string, any>;
  if (typeof r.ontology !== "string" || !r.ontology) errs.push("`ontology`: a project id (string) is required");
  if (r.version !== 2) errs.push("`version`: 2 for a typed spec");
  const names = {
    values: new Set(Object.keys(r.values ?? {})),
    structs: new Set(Object.keys(r.structs ?? {})),
    types: new Set(Object.keys(r.types ?? {})),
  };
  const type = (at: string, raw0: unknown, values?: unknown): TypeExpr | undefined => {
    if (typeof raw0 !== "string") { errs.push(`${at}: a type is required`); return undefined; }
    const t = parseTypeExpr(raw0, names, values);
    if (typeof t === "string") { errs.push(`${at}: ${t}`); return undefined; }
    return t;
  };

  const values: Record<string, ValueDecl> = {};
  for (const [name, v0] of Object.entries((r.values ?? {}) as Record<string, any>)) {
    const v = v0 ?? {}, at = `values.${name}`;
    if (!NAME.test(name)) errs.push(`${at}: a name is letters, digits and _`);
    const base = v.base ?? "string";
    if (!SCALARS.has(base)) errs.push(`${at}.base: one of ${[...SCALARS].join(", ")}`);
    if (!v.description) errs.push(`${at}.description: say what the value means (the model reads it)`);
    const examples = Array.isArray(v.examples) ? v.examples.map(String) : [];
    if (!examples.length) errs.push(`${at}.examples: at least one example (the model reads them)`);
    values[name] = { name, base, examples, ...(v.pattern ? { pattern: String(v.pattern) } : {}), ...(v.description ? { description: v.description } : {}), ...(v.parse ? { parse: String(v.parse) } : {}) };
  }

  const structs: Record<string, Record<string, StructField>> = {};
  for (const [name, s0] of Object.entries((r.structs ?? {}) as Record<string, any>)) {
    const fields: Record<string, StructField> = {};
    for (const [fn, f0] of Object.entries((s0 ?? {}) as Record<string, any>)) {
      const rawT = typeof f0 === "string" ? f0 : f0?.type;
      const optional = typeof rawT === "string" && rawT.endsWith("?");
      const t = type(`structs.${name}.${fn}`, optional ? rawT.slice(0, -1) : rawT, f0?.values);
      if (t) fields[fn] = { type: t, optional, raw: rawT };
    }
    if (!Object.keys(fields).length) errs.push(`structs.${name}: at least one field`);
    structs[name] = fields;
  }

  const types: Record<string, ObjectType> = {};
  for (const [name, t0] of Object.entries((r.types ?? {}) as Record<string, any>)) {
    const t = t0 ?? {}, at = `types.${name}`;
    if (!NAME.test(name)) errs.push(`${at}: a type name is letters, digits and _`);
    if (typeof t.store !== "string") errs.push(`${at}.store: the store that holds the type is required`);
    if (typeof t.id !== "string" || !names.values.has(t.id)) errs.push(`${at}.id: the value type of its refs (one of values: ${[...names.values].join(", ") || "none declared"})`);
    if (t.derived) errs.push(`${at}.derived: not in a typed spec — a value the store does not hold follows from an interface (implements) or is a function`);
    if (t.expose) errs.push(`${at}.expose: not in a typed spec — find parameters are the properties marked find: true; cards follow from the types`);
    const properties: Record<string, PropDecl> = {};
    for (const [pn, p0] of Object.entries((t.properties ?? {}) as Record<string, any>)) {
      const p = typeof p0 === "string" ? { type: p0 } : (p0 ?? {});
      const pt = type(`${at}.properties.${pn}.type`, p.type, p.values);
      if (!pt) continue;
      const base = scalarBase(pt, r.values ?? {});
      if (p.group === true && !["enum", "ref", "bool", "string", "date", "datetime"].includes(base)) errs.push(`${at}.properties.${pn}.group: an enum, ref, bool, string or date can be grouped by, not ${base}`);
      if (p.extreme === true && !["date", "datetime", "int", "decimal"].includes(base)) errs.push(`${at}.properties.${pn}.extreme: a date or a number can be ordered by, not ${base}`);
      if (p.extreme === true && pt.kind === "list") errs.push(`${at}.properties.${pn}.extreme: a list cannot be ordered by`);
      properties[pn] = { name: pn, type: pt, raw: String(p.type), find: p.find === true, ...(p.group === true ? { group: true } : {}), ...(p.extreme === true ? { extreme: true } : {}), ...(p.description ? { description: p.description } : {}), ...(p.from ? { from: String(p.from) } : {}) };
    }
    const impl: Interfaces = {};
    for (const [iname, i0] of Object.entries((t.implements ?? {}) as Record<string, any>)) {
      if (!INTERFACES.has(iname)) { errs.push(`${at}.implements.${iname}: one of ${[...INTERFACES].join(", ")}`); continue; }
      (impl as Record<string, unknown>)[iname] = i0 ?? {};
    }
    types[name] = {
      name, store: t.store, id: t.id, properties, implements: impl,
      hide: Array.isArray(t.hide) ? t.hide.map(String) : [], notes: t.notes ?? {},
      ...(t.description ? { description: t.description } : {}), ...(t.source && typeof t.source === "object" ? { source: t.source } : {}),
    };
  }

  const links: Record<string, LinkDecl> = {};
  for (const [name, l0] of Object.entries((r.links ?? {}) as Record<string, any>)) {
    const l = l0 ?? {};
    links[name] = { name, from: l.from, to: l.to, card: l.card, inverse: l.inverse, kind: l.kind,
      ...(l.description ? { description: l.description } : {}), ...(l.inverse_description ? { inverse_description: l.inverse_description } : {}),
      ...(l.source && typeof l.source === "object" ? { source: l.source } : {}) };
  }

  const functions: Record<string, FunctionDecl> = {};
  for (const [name, f0] of Object.entries((r.functions ?? {}) as Record<string, any>)) {
    const f = f0 ?? {}, at = `functions.${name}`;
    if (!f.description) errs.push(`${at}.description: agents choose a function by its description; write one`);
    const args: FunctionDecl["args"] = {};
    for (const [an, a0] of Object.entries((f.args ?? {}) as Record<string, any>)) {
      const a = typeof a0 === "string" ? { type: a0 } : (a0 ?? {});
      const at2 = type(`${at}.args.${an}.type`, a.type, a.values);
      if (at2) args[an] = { type: at2, raw: String(a.type), required: a.required === true, ...(a.description ? { description: a.description } : {}) };
    }
    const res = type(`${at}.result`, f.result, f.values);
    if (res) functions[name] = { name, description: f.description ?? "", args, result: res, resultRaw: String(f.result) };
  }

  const surfaces: Record<string, SurfaceDecl> = {};
  for (const [name, s0] of Object.entries((r.surfaces ?? {}) as Record<string, any>)) {
    const s = s0 ?? {};
    surfaces[name] = { name, tools: Array.isArray(s.tools) ? s.tools.map(String) : [], ...(s.description ? { description: s.description } : {}) };
  }
  const search: SearchPolicy = { weak_below: Number(r.search?.weak_below ?? 0.2), full: Number(r.search?.full ?? 3), limit: Number(r.search?.limit ?? 6), order: r.search?.order === "coverage" ? "coverage" : "store" };
  if (r.search?.order !== undefined && !["store", "coverage"].includes(r.search.order)) errs.push("search.order: store | coverage");

  const spec: TypedSpec = { ontology: r.ontology, version: 2, values, structs, types, links, functions, surfaces, search, ...(file ? { file } : {}) };
  errs.push(...validateTyped(spec));
  if (errs.length) throw new SpecError(errs, file);
  return spec;
}

/** The rules a typed spec keeps beyond its types: interfaces bound to what they need, links, parse functions. */
export function validateTyped(spec: TypedSpec): string[] {
  const errs: string[] = [];
  for (const v of Object.values(spec.values)) {
    const p = valuePattern(spec, v.name);
    if (p) {
      let re: RegExp | undefined;
      try { re = new RegExp(p, "u"); } catch (e) { errs.push(`values.${v.name}.pattern: ${(e as Error).message}`); }
      if (re) for (const x of v.examples) if (!re.test(x)) errs.push(`values.${v.name}.examples: ${JSON.stringify(x)} does not match the pattern`);
    }
    if (v.parse) {
      const f = spec.functions[v.parse];
      if (!f) errs.push(`values.${v.name}.parse: unknown function ${v.parse}`);
      else {
        const a = Object.values(f.args);
        if (a.length !== 1 || a[0]!.type.kind !== "scalar" || !["string", "text"].includes((a[0]!.type as { name: string }).name)) errs.push(`functions.${v.parse}: a parse function takes one text argument`);
        if (!(f.result.kind === "value" && f.result.name === v.name)) errs.push(`functions.${v.parse}.result: a parse function for ${v.name} returns ${v.name}`);
      }
    }
  }
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
    const at = `types.${t.name}.implements`;
    const c = t.implements.Citable;
    if (c) {
      for (const k of ["title", "text"] as const) {
        const pn = c[k];
        if (pn === undefined) continue;
        const p = t.properties[pn];
        if (!p) errs.push(`${at}.Citable.${k}: ${pn} is not a property`);
        else if (p.type.kind !== "scalar" || !["string", "text"].includes(p.type.name)) errs.push(`${at}.Citable.${k}: ${pn} must be string or text`);
      }
      if (c.cite) {
        const f = spec.functions[c.cite];
        if (!f) errs.push(`${at}.Citable.cite: unknown function ${c.cite}`);
        else if (!(f.result.kind === "scalar" && f.result.name === "string")) errs.push(`functions.${c.cite}.result: a cite function returns string`);
      }
    }
    for (const [iname, kind, card] of [["Part", "composition", "many-to-one"], ["Referring", "reference", undefined]] as const) {
      const b = t.implements[iname];
      if (!b) continue;
      const l = spec.links[b.link];
      if (!l) { errs.push(`${at}.${iname}.link: unknown link ${JSON.stringify(b.link)}`); continue; }
      if (l.from !== t.name) errs.push(`${at}.${iname}.link: ${l.name} starts from ${l.from}, not ${t.name}`);
      if (l.kind !== kind) errs.push(`${at}.${iname}.link: ${l.name} must be a ${kind} link (it is ${l.kind})`);
      if (card && l.card !== card) errs.push(`${at}.${iname}.link: ${l.name} must be ${card} (an object has one parent)`);
    }
    for (const h of t.hide) if (!t.properties[h]) errs.push(`types.${t.name}.hide: ${h} is not a property`);
    for (const p of Object.values(t.properties)) {
      if (!p.from) continue;
      const src = t.properties[p.from];
      const inner = src?.type.kind === "list" ? src.type.of : src?.type;
      if (!src || inner?.kind !== "ref") errs.push(`types.${t.name}.properties.${p.name}.from: ${p.from} must be a property of type ref<T> (the object the value was read from)`);
    }
    for (const pn of Object.keys(t.properties)) if (CARD_KEYS.has(pn)) errs.push(`types.${t.name}.properties.${pn}: the name is a field every card carries (${[...CARD_KEYS].join(", ")}); name the property otherwise`);
    for (const k of Object.keys(t.notes)) if (!["found", "weak", "none"].includes(k)) errs.push(`types.${t.name}.notes.${k}: one of found | weak | none`);
  }
  if (!(spec.search.weak_below >= 0 && spec.search.weak_below <= 1)) errs.push("search.weak_below: 0–1");
  if (!(spec.search.full >= 1 && spec.search.full <= spec.search.limit && spec.search.limit <= 20)) errs.push("search: 1 ≤ full ≤ limit ≤ 20");
  return errs;
}
