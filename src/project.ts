// PROJECT — what a project hands the runtime: the path of its spec, and how to open the adapters of its stores and
// the implementations of its functions. A module exporting `project: Project` is loaded by path (`--project`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { Engine, type FunctionImpl, type StoreAdapter } from "./engine.ts";
import type { Harness } from "./serve.ts";
import { buildSpec, type Spec } from "./spec.ts";
import { TypedEngine, type TypedFunctionImpl } from "./typed/engine.ts";
import type { Store } from "./typed/store.ts";
import { buildTypedSpec, type TypedSpec } from "./typed/spec.ts";

/** A version 1 project opens adapters (each store answers find / get / follow with its own cards); a typed
 *  (version 2) project opens stores (each answers search / scan / get / neighbours; the runtime builds the rest). */
export interface Opened {
  adapters?: Record<string, StoreAdapter>;
  stores?: Record<string, Store>;
  functions: Record<string, FunctionImpl> | Record<string, TypedFunctionImpl>;
}
export interface Project {
  /** absolute path of the spec file */
  spec: string;
  open(spec: Spec | TypedSpec, env: NodeJS.ProcessEnv): Promise<Opened>;
}

/** Read a spec of either version: `version: 2` is a typed spec. */
export function loadAnySpec(file: string): Spec | TypedSpec {
  const raw = parse(readFileSync(file, "utf8")) as { version?: unknown };
  return raw?.version === 2 ? buildTypedSpec(raw, file) : buildSpec(raw, file);
}

export async function loadProject(modulePath: string): Promise<Project> {
  const m = (await import(pathToFileURL(resolve(modulePath)).href)) as { project?: Project };
  if (!m.project?.spec || typeof m.project.open !== "function") throw new Error(`${modulePath}: expected an export \`project\` with spec and open()`);
  return m.project;
}

export async function openEngine(p: Project, env: NodeJS.ProcessEnv = process.env): Promise<Harness> {
  const spec = loadAnySpec(p.spec);
  const o = await p.open(spec, env);
  if (spec.version === 2) return new TypedEngine(spec as TypedSpec, o.stores ?? {}, o.functions as Record<string, TypedFunctionImpl>);
  return new Engine(spec as Spec, o.adapters ?? {}, o.functions as Record<string, FunctionImpl>);
}
