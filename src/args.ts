// ARGUMENTS — the JSON schema of every tool argument, built from the spec, and the check that runs before any store
// is touched. Small models get arguments slightly wrong in a few recurring ways; the forgiving ones are repaired
// (an array sent as a JSON string, with a bracket too many or too few; one value where a list is expected; a number
// sent as a string), the others are refused with a message that names the argument, what is expected and what came.

import { parseType, type PropDecl } from "./spec.ts";

export type JsonSchema = Record<string, unknown>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The schema of a property's value. `asFilter`: the shape a filter on it takes (text → phrasings, enum → any of). */
export function schemaOf(p: PropDecl, asFilter = false): JsonSchema {
  const t = parseType(p.type)!;
  const desc = p.description ? { description: p.description } : {};
  const one = (): JsonSchema => {
    switch (t.base) {
      case "int": return { type: "integer" };
      case "decimal": return { type: "number" };
      case "bool": return { type: "boolean" };
      case "date": return { type: "string", pattern: DATE.source, description: "YYYY-MM-DD" };
      case "datetime": return { type: "string" };
      case "enum": return { type: "string", enum: p.values };
      case "quantity": return { type: "object", properties: { value: { type: "number" }, min: { type: "number" }, max: { type: "number" }, unit: { type: "string" } } };
      case "object": return { type: "object" };
      default: return { type: "string" }; // string, text, span, ref<T>
    }
  };
  if (asFilter) {
    if (p.filter === "range") return { type: "object", properties: { min: one(), max: one() }, ...desc };
    if (p.filter === "text") return { type: "array", items: { type: "string" }, minItems: 1, ...desc, description: `${p.description ? `${p.description}. ` : ""}One or more phrasings; a unit matching any of them counts` };
    if (t.base === "bool") return { ...one(), ...desc };
    return { type: "array", items: one(), minItems: 1, ...desc }; // exact / enum: any of the values
  }
  return t.list ? { type: "array", items: one(), ...desc } : { ...one(), ...desc };
}

/** Parse a JSON value a model wrote as a string, repairing missing or surplus closing brackets outside strings. */
export function parseLoose(v: string): unknown {
  const s = v.trim();
  if (!/^[[{]/.test(s)) return undefined;
  try { return JSON.parse(s); } catch { /* repair below */ }
  const stack: string[] = [];
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { out += ch; if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "[" || ch === "{") { stack.push(ch === "[" ? "]" : "}"); out += ch; continue; }
    if (ch === "]" || ch === "}") { if (stack.at(-1) === ch) { stack.pop(); out += ch; } continue; } // a surplus closer is dropped
    out += ch;
  }
  out += stack.reverse().join("");
  try { return JSON.parse(out); } catch { return undefined; }
}

/** Repair the forgiving mistakes, in place of the value. */
export function coerce(schema: JsonSchema, v: unknown): unknown {
  if (v === undefined || v === null) return v;
  const type = schema.type;
  if (typeof v === "string" && (type === "array" || type === "object")) {
    const p = parseLoose(v);
    if (p !== undefined) v = p;
    else if (type === "array") v = [v];
  }
  if (type === "array" && !Array.isArray(v) && typeof v !== "object") v = [v];
  if (type === "array" && Array.isArray(v)) return v.map((x) => coerce((schema.items ?? {}) as JsonSchema, x));
  if (type === "object" && v && typeof v === "object" && !Array.isArray(v) && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, props[k] ? coerce(props[k], x) : x]));
  }
  if ((type === "integer" || type === "number") && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (type === "boolean" && (v === "true" || v === "false")) return v === "true";
  return v;
}

const show = (v: unknown) => { const s = JSON.stringify(v); return s && s.length > 80 ? `${s.slice(0, 80)}…` : s; };

/** Every way `v` breaks `schema`, as "<path>: expected …, got …". */
export function check(schema: JsonSchema, v: unknown, path: string): string[] {
  const type = schema.type;
  const bad = (what: string) => [`${path}: expected ${what}, got ${show(v)}`];
  if (Array.isArray(schema.anyOf)) {
    const tries = (schema.anyOf as JsonSchema[]).map((s) => check(s, v, path));
    return tries.some((e) => !e.length) ? [] : tries.sort((a, b) => a.length - b.length)[0]!;
  }
  switch (type) {
    case "string": {
      if (typeof v !== "string") return bad("a string");
      if (schema.enum && !(schema.enum as string[]).includes(v)) return bad(`one of ${(schema.enum as string[]).join(" | ")}`);
      if (schema.pattern && !new RegExp(schema.pattern as string).test(v)) return bad(`${schema.description ?? "the pattern"}`);
      return [];
    }
    case "integer":
    case "number": {
      if (type === "integer" ? !Number.isInteger(v) : !(typeof v === "number" && Number.isFinite(v))) return bad(type === "integer" ? "an integer" : "a number");
      // a bound is refused with the bound, never cut silently
      if (typeof schema.maximum === "number" && (v as number) > schema.maximum) return bad(`at most ${schema.maximum}`);
      if (typeof schema.minimum === "number" && (v as number) < schema.minimum) return bad(`at least ${schema.minimum}`);
      return [];
    }
    case "boolean": return typeof v === "boolean" ? [] : bad("true or false");
    case "array": {
      if (!Array.isArray(v)) return bad("a list");
      if (schema.minItems && v.length < (schema.minItems as number)) return bad(`at least ${schema.minItems} item(s)`);
      return v.flatMap((x, i) => check((schema.items ?? {}) as JsonSchema, x, `${path}[${i}]`));
    }
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad("an object");
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const req = (schema.required ?? []) as string[];
      const out = req.filter((k) => (v as Record<string, unknown>)[k] === undefined).map((k) => `${path}.${k}: required`);
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) out.push(...check(props[k], x, `${path}.${k}`));
        else if (schema.additionalProperties === false) out.push(`${path}.${k}: unknown argument (known: ${Object.keys(props).join(", ") || "none"})`);
      }
      return out;
    }
    default: return [];
  }
}

/** Coerce then check an object of arguments; returns the repaired value or the errors. */
export function checkArgs(schema: JsonSchema, args: unknown, path = "args"): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const v = coerce(schema, args ?? {});
  const errors = check(schema, v, path);
  return errors.length ? { ok: false, errors } : { ok: true, value: v as Record<string, unknown> };
}
