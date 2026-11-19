// SERVING — one HTTP route per generic operation (never one per type), JSON in and out.
//
//   POST /v1/find     { type, args }               → page: verdict, note, items, more
//   POST /v1/get      { refs, type?, at? }         → items (or { ref, found: false, note })
//   POST /v1/follow   { link, refs, at? }          → per ref, the linked items
//   POST /v1/call     { fn, args }                 → the function's result
//   POST /v1/tool     { name, args }               → a generated tool run by name (what an agent runtime calls)
//   GET  /v1/catalogue                             → types, links, functions, surfaces
//   GET  /v1/tools?surface=<name> | ?tool=A&tool=B → tool definitions (&output=1: with their output schemas)
//   GET  /v1/health                                → spec id, store heads
//
// The caller's clearance comes from the `x-harness-clearance` header, set by the gateway that authenticated them.
// A request the spec refuses answers 400 with { errors: [...] }, each naming the argument and what was expected.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HarnessError, type Caller } from "./engine.ts";

/** What the HTTP layer needs of a harness: the spec-driven engine of version 1 and the typed engine both provide it. */
export interface Harness {
  spec: { ontology: string; version: number };
  heads(): Promise<string>;
  health?(): Promise<unknown>;
  catalogue(): unknown;
  tools(surfaceOrList?: string | readonly string[]): Array<{ name: string; description: string; parameters: unknown; output?: unknown }>;
  find(type: string, args: unknown, who?: Caller): Promise<unknown>;
  get(refs: unknown, opt: { type?: string | undefined; at?: unknown }, who?: Caller): Promise<unknown>;
  follow(link: string, refs: unknown, opt: { at?: unknown }, who?: Caller): Promise<unknown>;
  call(fn: string, args: unknown, opt: { at?: unknown }, who?: Caller): Promise<unknown>;
  tool(name: string, args: unknown, who?: Caller): Promise<unknown>;
  close(): Promise<void>;
}

const LIMIT = 1_000_000;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) { s += c; if (s.length > LIMIT) throw new HarnessError(413, ["body too large"]); }
  if (!s.trim()) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { throw new HarnessError(400, ["body: expected JSON"]); }
}

function send(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export async function handle(engine: Harness, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://harness");
  const who: Caller = { clearance: String(req.headers["x-harness-clearance"] ?? "none") };
  try {
    if (req.method === "GET") {
      switch (u.pathname) {
        case "/v1/health": return send(res, 200, engine.health ? { ok: true, ...(await engine.health() as object) } : { ok: true, ontology: engine.spec.ontology, version: engine.spec.version, heads: await engine.heads() });
        case "/v1/catalogue": return send(res, 200, engine.catalogue());
        case "/v1/tools": {
          const surface = u.searchParams.get("surface");
          const list = u.searchParams.getAll("tool");
          const defs = surface ? engine.tools(surface) : list.length ? engine.tools(list) : engine.tools();
          // what a model is given: name, description, parameters. The output schema (for checks and guards) only on ?output=1
          const withOutput = u.searchParams.has("output");
          return send(res, 200, defs.map(({ name, description, parameters, output }) => ({ name, description, parameters, ...(withOutput && output ? { output } : {}) })));
        }
      }
      return send(res, 404, { errors: [`no route GET ${u.pathname}`] });
    }
    if (req.method !== "POST") return send(res, 405, { errors: ["GET or POST"] });
    const b = await body(req);
    switch (u.pathname) {
      case "/v1/find": return send(res, 200, await engine.find(String(b.type ?? ""), b.args ?? {}, who));
      case "/v1/get": return send(res, 200, await engine.get(b.refs, { type: b.type as string | undefined, at: b.at }, who));
      case "/v1/follow": return send(res, 200, await engine.follow(String(b.link ?? ""), b.refs, { at: b.at }, who));
      case "/v1/call": return send(res, 200, await engine.call(String(b.fn ?? ""), b.args ?? {}, { at: b.at }, who));
      case "/v1/tool": return send(res, 200, await engine.tool(String(b.name ?? ""), b.args ?? {}, who));
    }
    return send(res, 404, { errors: [`no route POST ${u.pathname}`] });
  } catch (e) {
    if (e instanceof HarnessError) return send(res, e.status, { errors: e.errors });
    return send(res, 500, { errors: [e instanceof Error ? e.message : String(e)] });
  }
}

export async function serve(engine: Harness, port: number, host = "127.0.0.1"): Promise<{ close(): Promise<void>; port: number }> {
  const server = createServer((req, res) => { handle(engine, req, res).catch((e) => send(res, 500, { errors: [String(e)] })); });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, host, ok); });
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : port, close: () => new Promise((ok) => server.close(() => ok())) };
}
