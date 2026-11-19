// The runtime on a spec that has nothing to do with law (a library: books, authors, loans), over the memory adapter:
// if the core needed domain code, this would not run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { coerce, parseLoose } from "./args.ts";
import { Engine, HarnessError } from "./engine.ts";
import { MemoryAdapter } from "./memory.ts";
import { handle } from "./serve.ts";
import { buildSpec, SpecError } from "./spec.ts";
import { createServer } from "node:http";

const SPEC = `
ontology: library
version: 1
types:
  Book:
    description: a title held by the library
    store: mem
    key: id
    properties:
      title:  { type: text, filter: text, description: words of the title }
      genre:  { type: enum, values: [novel, poetry, history], filter: true }
      year:   { type: int, filter: range }
      isbn:   { type: string }
    derived:
      shelf: { description: where it stands }
    expose:
      find: { filters: [title, genre, year], limit: 3 }
      card: [title, genre, year, shelf]
      follow: [writtenBy]
  Author:
    store: mem
    key: id
    properties:
      name: { type: string, filter: text }
    expose:
      find: { filters: [name] }
      follow: [wrote]
links:
  writtenBy: { from: Book, to: Author, card: many-to-many, inverse: wrote, kind: reference, description: the authors of the book }
functions:
  countBooks:
    description: How many books an author wrote.
    args: { author: { type: "ref<Author>", required: true } }
    result: int
    reads: [Book, Author]
surfaces:
  lookup: { description: finding books, tools: [Book.find, Book.get, Book.writtenBy, Author.find, countBooks] }
`;

function setup() {
  const spec = buildSpec(parse(SPEC));
  const mem = new MemoryAdapter()
    .put({ ref: "b1", type: "Book", props: { title: "Truyện Kiều", genre: "poetry", year: 1820, isbn: "x", shelf: "A1" } })
    .put({ ref: "b2", type: "Book", props: { title: "Số đỏ", genre: "novel", year: 1936, isbn: "y", shelf: "B2" } })
    .put({ ref: "b3", type: "Book", props: { title: "Vỡ đê", genre: "novel", year: 1936, shelf: "B3" }, clearance: "staff" })
    .put({ ref: "a1", type: "Author", props: { name: "Nguyễn Du" } })
    .put({ ref: "a2", type: "Author", props: { name: "Vũ Trọng Phụng" } })
    .link("writtenBy", "b1", "a1").link("writtenBy", "b2", "a2").link("writtenBy", "b3", "a2");
  const engine = new Engine(spec, { mem }, {
    countBooks: async (args, ctx) => (await ctx.engine.follow("wrote", [args.author], {}, ctx.who)).results[0]!.items.length,
  });
  return { spec, engine, mem };
}

test("spec: every rule broken is reported, with its place", () => {
  const bad = parse(SPEC);
  bad.types.Book.temporal = "versioned";             // no versions_from
  bad.types.Book.properties.year.filter = "text";     // text filter on an int
  bad.types.Book.expose.find.filters.push("isbn");    // not filterable
  bad.links.writtenBy.inverse = undefined;            // no inverse
  bad.surfaces.lookup.tools.push("Book.nothing");
  try { buildSpec(bad); assert.fail("should refuse"); } catch (e) {
    assert.ok(e instanceof SpecError);
    const all = e.errors.join("\n");
    for (const s of ["types.Book.versions_from", "types.Book.properties.year.filter", "expose.find.filters: isbn is not filterable", "links.writtenBy.inverse", "Book.nothing"]) assert.match(all, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), s);
  }
});

test("find: filters checked against the spec, card projected, verdicts", async () => {
  const { engine } = setup();
  const p = await engine.find("Book", { genre: ["novel"], year: { min: 1900 } });
  assert.equal(p.verdict, "found");
  assert.deepEqual(p.items.map((i) => i.ref), ["b2"]); // b3 is not visible to the public
  assert.deepEqual(Object.keys(p.items[0]!.props).sort(), ["genre", "shelf", "title", "year"]); // isbn is not on the card
  const staff = await engine.find("Book", { genre: "novel" }, { clearance: "staff" }); // one value where a list is expected
  assert.deepEqual(staff.items.map((i) => i.ref), ["b2", "b3"]);
  assert.equal((await engine.find("Book", { title: "truyen kieu" })).items[0]?.ref, "b1"); // a phrasing as a string, without diacritics
  assert.equal((await engine.find("Book", { title: ["chiến tranh"] })).verdict, "none");
  await assert.rejects(engine.find("Book", { genre: ["essay"] }), (e: HarnessError) => /genre\[0\]: expected one of novel \| poetry \| history, got "essay"/.test(e.errors[0]!));
  await assert.rejects(engine.find("Book", { isbn: ["x"] }), (e: HarnessError) => /isbn: unknown argument/.test(e.errors[0]!));
});

test("get, follow both ways, functions with typed args", async () => {
  const { engine } = setup();
  const got = await engine.get(["b1", "zz"]);
  assert.equal((got[0] as { type: string }).type, "Book");
  assert.equal((got[1] as { found: boolean }).found, false);
  const f = await engine.follow("writtenBy", ["b1"]);
  assert.equal(f.results[0]!.items[0]!.ref, "a1");
  assert.equal(f.kind, "reference");
  const back = await engine.follow("wrote", ["a2"], {}, { clearance: "staff" });
  assert.deepEqual(back.results[0]!.items.map((i) => i.ref).sort(), ["b2", "b3"]);
  assert.equal(await engine.call("countBooks", { author: "a2" }), 1);
  await assert.rejects(engine.call("countBooks", {}), (e: HarnessError) => /author: required/.test(e.errors[0]!));
});

test("tools: generated per surface, run by name, arguments repaired where a model slips", async () => {
  const { engine } = setup();
  const defs = engine.tools("lookup");
  assert.deepEqual(defs.map((d) => d.name), ["book_find", "book_get", "book_writtenBy", "author_find", "countBooks"]);
  const find = defs[0]!.parameters as { properties: Record<string, { enum?: unknown; items?: { enum?: unknown } }> };
  assert.deepEqual(find.properties.genre!.items!.enum, ["novel", "poetry", "history"]);
  // a list sent as a JSON string with a bracket missing
  const r = (await engine.tool("book_find", { genre: '["novel"', year: '{"min": "1900"}' })) as { items: Array<{ ref: string }> };
  assert.deepEqual(r.items.map((i) => i.ref), ["b2"]);
  assert.deepEqual(parseLoose('["a"]]'), ["a"]);
  assert.deepEqual(coerce({ type: "array", items: { type: "string" } }, "one"), ["one"]);
  assert.equal(await engine.tool("countBooks", { author: "a1" }), 1);
  await assert.rejects(engine.tool("book_burn", {}), HarnessError);
});

test("engine refuses a project that does not implement what the spec declares", () => {
  const spec = buildSpec(parse(SPEC));
  assert.throws(() => new Engine(spec, {}, {}), (e: HarnessError) => e.errors.some((x) => /no adapter for store "mem"/.test(x)) && e.errors.some((x) => /countBooks: the project does not implement it/.test(x)));
});

test("http: routes, 400 with named errors", async () => {
  const { engine } = setup();
  const server = createServer((req, res) => void handle(engine, req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
  try {
    const ok = await (await post("/v1/tool", { name: "book_find", args: { title: ["số đỏ"] } })).json() as { items: Array<{ ref: string }> };
    assert.equal(ok.items[0]!.ref, "b2");
    const bad = await post("/v1/find", { type: "Book", args: { year: "old" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { errors: string[] }).errors[0]!, /year: expected an object/);
    const tools = await (await fetch(`http://127.0.0.1:${port}/v1/tools?surface=lookup`)).json() as unknown[];
    assert.equal(tools.length, 5);
  } finally { server.close(); }
});
