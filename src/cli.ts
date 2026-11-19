// harness — the runtime's command line.
//
//   harness lint <spec.yaml>                                 check a spec; exit 1 with every error
//   harness catalogue --project <module>                     types, links, functions, surfaces
//   harness tools --project <module> [--surface s] [--output] tool definitions (--output: with output schemas)
//   harness find  --project <module> <Type> '<args json>'    run find
//   harness get   --project <module> <ref>… [--at d]         read objects
//   harness follow --project <module> <link> <ref>…          follow a link
//   harness call  --project <module> <fn> '<args json>'      run a function
//   harness tool  --project <module> <name> '<args json>'    run a generated tool by name
//   harness serve --project <module> [--port 8791] [--host 127.0.0.1]

import { HarnessError } from "./engine.ts";
import { loadAnySpec, loadProject, openEngine } from "./project.ts";
import { serve } from "./serve.ts";
import { SpecError } from "./spec.ts";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  try {
    if (cmd === "lint") {
      const s = loadAnySpec(args[0] ?? "");
      out({ ok: true, ontology: s.ontology, types: Object.keys(s.types).length, links: Object.keys(s.links).length, functions: Object.keys(s.functions).length, surfaces: Object.keys(s.surfaces).length });
      return 0;
    }
    const mod = opt(args, "project") ?? process.env.HARNESS_PROJECT;
    if (!mod) { process.stderr.write("harness: --project <module> (or HARNESS_PROJECT) is required\n"); return 2; }
    const at = opt(args, "at");
    const surface = opt(args, "surface");
    const withOutput = args.includes("--output") ? (args.splice(args.indexOf("--output"), 1), true) : false;
    const port = Number(opt(args, "port") ?? process.env.HARNESS_PORT ?? 8791);
    const host = opt(args, "host") ?? "127.0.0.1";
    const engine = await openEngine(await loadProject(mod));
    const json = (s: string | undefined) => (s ? JSON.parse(s) : {});
    switch (cmd) {
      case "catalogue": out(engine.catalogue()); break;
      case "tools": out(engine.tools(surface).map(({ name, description, parameters, output }) => ({ name, description, parameters, ...(withOutput && output ? { output } : {}) }))); break;
      case "find": out(await engine.find(args[0] ?? "", json(args[1]))); break;
      case "get": out(await engine.get(args, { at })); break;
      case "follow": out(await engine.follow(args[0] ?? "", args.slice(1), { at })); break;
      case "call": out(await engine.call(args[0] ?? "", json(args[1]), { at })); break;
      case "tool": out(await engine.tool(args[0] ?? "", json(args[1]))); break;
      case "serve": {
        const s = await serve(engine, port, host);
        process.stderr.write(`harness serve · ${engine.spec.ontology} v${engine.spec.version} · ${host}:${s.port}\n`);
        await new Promise(() => {});
        break;
      }
      default: process.stderr.write("harness: lint | catalogue | tools | find | get | follow | call | tool | serve\n"); return 2;
    }
    await engine.close();
    return 0;
  } catch (e) {
    if (e instanceof SpecError || e instanceof HarnessError) { process.stderr.write(`${e instanceof SpecError ? e.message : `harness: ${e.errors.join("\n")}`}\n`); return 1; }
    throw e;
  }
}
