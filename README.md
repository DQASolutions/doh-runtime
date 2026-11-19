# @ontology-harness/runtime

An agent harness generated from an ontology. A project declares its object types, links, functions and surfaces once
(a `spec.yaml` and a module exporting `project`); the runtime serves them to agents as typed tools and to
applications as an HTTP API, over the stores that hold the data. Generic: no domain code.

Needs Node >= 22.18.

## Use

```bash
npm install @ontology-harness/runtime          # or a packed file: npm install ./ontology-harness-runtime-0.1.0.tgz
npx harness serve --project project.ts --port 8796
```

A project module (TypeScript runs as is on Node >= 22.18, outside `node_modules`):

```ts
import type { Project } from "@ontology-harness/runtime";

export const project: Project = {
  spec: new URL("./spec.yaml", import.meta.url).pathname,
  async open(spec, env) {
    return { stores: { main: /* a Store adapter */ }, functions: { /* the spec's functions */ } };
  },
};
```

`examples/handbook` is a complete project on the built-in memory store.

## HTTP

| Call | What |
|---|---|
| `GET /v1/tools?surface=<name>` | the tools of a surface: name, description, JSON schema of the arguments |
| `POST /v1/tool` `{ name, args }` | call a tool; arguments are checked (and repaired where safe) against the spec |
| `/v1/find`, `/v1/get`, `/v1/follow`, `/v1/call` | the engine's operations for applications |
| `/v1/catalogue`, `/v1/health` | the spec's types; liveness |

## Develop

```bash
npm install
npm test            # node --test on the .ts sources
npm run typecheck
npm run build       # dist/: JS + type declarations (what the package ships)
npm pack            # builds first
```

In development `bin/harness.mjs` runs the `.ts` sources directly; the installed package runs `bin/harness.js` on `dist/`.
