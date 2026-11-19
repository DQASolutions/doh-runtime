// The typed harness on a spec that is not law (company handbooks: chapters, clauses with a lead line and points under
// them, cross-references, versions in time), over the memory source. Everything the tests check — tools, filters,
// cards, outputs — is generated from the declared types; the project writes only the spec, the data and three helpers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parse } from "yaml";
import { check } from "../args.ts";
import { HarnessError } from "../engine.ts";
import { handle } from "../serve.ts";
import { SpecError } from "../spec.ts";
import { TypedEngine } from "./engine.ts";
import type { Capabilities, Store } from "./store.ts";
import { buildTypedSpec } from "./spec.ts";
import { readFileSync } from "node:fs";
import { data, functions, LEAD_NEW, LEAD_OLD, SPEC_FILE } from "../../examples/handbook/project.ts";

const SPEC = readFileSync(SPEC_FILE, "utf8");

const setup = (fns: typeof functions = functions, mem = data()) => new TypedEngine(buildTypedSpec(parse(SPEC)), { main: mem }, fns);
const errorsOf = (schema: unknown, v: unknown) => check(schema as Record<string, unknown>, v, "output");

test("typed spec: every rule broken is reported, with its place", () => {
  const bad = parse(SPEC);
  bad.types.Section.derived = { path: { description: "where it stands" } };       // untyped value
  bad.functions.summary.result = "object";                                       // result says nothing of its content
  bad.links.parent.kind = "reference";                                           // Part needs a composition link
  bad.values.HandbookId.examples = ["handbook one"];                             // example breaks its own pattern
  bad.types.Handbook.properties.path = { type: "string" };                       // a card field's name
  bad.types.Handbook.properties.pages = { type: "number" };                      // unknown type
  bad.types.Handbook.properties.year = { type: "enum" };                         // enum without values
  try { buildTypedSpec(bad); assert.fail("should refuse"); } catch (e) {
    assert.ok(e instanceof SpecError);
    const all = e.errors.join("\n");
    for (const s of ["types.Section.derived", "functions.summary.result: `object`", "Part.link: parent must be a composition link", "values.HandbookId.examples", "properties.path: the name is a field every card carries", "properties.pages.type: unknown type", "properties.year.type: an enum lists its values"])
      assert.ok(all.includes(s), `missing: ${s}\n${all}`);
  }
  const s2 = parse(SPEC);
  s2.surfaces.discover.tools.push("find_author");
  assert.throws(() => new TypedEngine(buildTypedSpec(s2), { main: data() }, functions), (e: HarnessError) => /find_author is not a tool/.test(e.errors[0]!));
});

test("tools: generated from the types — names, parameters by type, outputs; helpers are not tools", () => {
  const e = setup();
  assert.deepEqual(e.tools().map((t) => t.name), ["find_handbook", "find_section", "read", "quote", "summary"]);
  assert.deepEqual(e.tools("discover").map((t) => t.name), ["find_section", "read", "find_handbook"]);
  const fs = e.toolDef("find_section").parameters as { properties: Record<string, any> };
  assert.deepEqual(Object.keys(fs.properties), ["handbook", "text", "topics", "at", "within", "fields", "limit"]);
  assert.equal(fs.properties.text.type, "array");                               // text → phrasings
  assert.deepEqual(fs.properties.topics.items.enum, ["safety", "finance", "discipline"]); // list<enum> → any of
  assert.deepEqual(fs.properties.handbook.items.examples, ["HB-001"]);           // ref<Handbook> → its id type, examples
  assert.equal(fs.properties.handbook.items.pattern, undefined);                 // … free text allowed: it has a parse
  const fh = e.toolDef("find_handbook").parameters as { properties: Record<string, any> };
  assert.deepEqual(Object.keys(fh.properties.issued.properties), ["min", "max"]); // date → range
  assert.deepEqual(fh.properties.status.items.enum, ["draft", "active", "retired"]);
  for (const t of e.tools()) assert.ok(t.output && t.description.split(/\s+/).length <= 50, `${t.name}: ${t.description}`);
  assert.deepEqual((e.toolDef("summary").output as { required: string[] }).required, ["title", "sections"]);
});

test("find: the answer's context comes with the result — path with the lead line, references, validity", async () => {
  const e = setup();
  const p = await e.find("Section", { text: ["phạt tiền không đội mũ bảo hộ"], at: "2025-08-01" });
  assert.deepEqual(errorsOf(e.toolDef("find_section").output, p), []);         // the output keeps its declared shape
  assert.equal(p.verdict, "found");
  const top = p.items[0]!;
  assert.equal(top.ref, "HB-001/2/1/1");
  assert.equal(top.cite, "mục 2.1.1 sổ tay HB-001");
  assert.deepEqual(top.path, [
    { ref: "HB-001/2", cite: "mục 2 sổ tay HB-001", title: "Xử lý vi phạm" },
    { ref: "HB-001/2/1", cite: "mục 2.1 sổ tay HB-001", lead: LEAD_NEW },       // the fine stands in the clause above
  ]);
  assert.deepEqual(top.refers, [{ ref: "HB-001/1/1", cite: "mục 1.1 sổ tay HB-001", text: "Sổ tay áp dụng cho mọi nhân viên làm việc tại công trường." }]);
  assert.deepEqual(top.validity, { status: "in_force" });
  // the same question on an earlier date reads the lead then in force
  const before = await e.find("Section", { text: ["phạt tiền không đội mũ bảo hộ"], at: "2024-06-01" });
  assert.equal((before.items[0]!.path as Array<{ lead?: string }>)[1]!.lead, LEAD_OLD);
});

test("find: title first, verdicts weak / none with what the data holds, filters by type", async () => {
  const e = setup();
  assert.equal((await e.find("Section", { text: ["phạm vi áp dụng của sổ tay"] })).items[0]!.ref, "HB-001/1/1");
  const weak = await e.find("Section", { text: ["nghỉ phép dài ngày ở công trường"] });
  assert.equal(weak.verdict, "weak");
  const none = await e.find("Section", { text: ["bảo hiểm thất nghiệp"] });
  assert.equal(none.verdict, "none");
  assert.deepEqual(none.covers, [{ ref: "HB-001", cite: "HB-001" }, { ref: "HB-002", cite: "HB-002" }]);
  // a handbook written loosely ("hb 2") is parsed into its type before it filters
  const fee = await e.find("Section", { handbook: ["hb 2"], text: ["phụ cấp lưu trú"] });
  assert.deepEqual(fee.items.map((i) => i.ref), ["HB-002/1/1"]);               // HB-002/1/2 is not visible to the public
  const staff = await e.find("Section", { handbook: ["HB-002"], text: ["phụ cấp lưu trú"] }, { clearance: "staff" });
  assert.deepEqual(staff.items.map((i) => i.ref).sort(), ["HB-002/1/1", "HB-002/1/2"]);
  assert.deepEqual((await e.find("Section", { topics: ["finance"] })).items.map((i) => i.ref), ["HB-002/1/1"]);
  assert.deepEqual((await e.find("Handbook", { issued: { max: "2023-12-31" } })).items.map((i) => i.ref), ["HB-002"]);
  assert.deepEqual((await e.find("Handbook", { owner: ["an toàn"] })).items.map((i) => i.ref), ["HB-001"]);
  await assert.rejects(e.find("Handbook", { status: ["archived"] }), (x: HarnessError) => /status\[0\]: expected one of draft \| active \| retired/.test(x.errors[0]!));
  await assert.rejects(e.find("Handbook", { pages: 3 }), (x: HarnessError) => /pages: unknown argument/.test(x.errors[0]!));
  // a date on a type without versions is dropped, not refused
  assert.deepEqual((await e.find("Handbook", { owner: ["an toàn"], at: "2025-01-01" })).items.map((i) => i.ref), ["HB-001"]);
});

test("read: by ref or as written; full card with lines, parts, versions; parts listed under their own parent", async () => {
  const e = setup();
  const [clause, hb, missing] = await e.read(["mục 2.1 sổ tay HB-001", "HB-001", "HB-009/1"], { at: "2025-08-01" });
  assert.deepEqual(errorsOf(e.toolDef("read").output, [clause, hb, missing]), []);
  assert.equal(clause!.ref, "HB-001/2/1");
  // the whole clause: its lead, then its points, numbered as one text
  assert.deepEqual(clause!.lines, [{ n: 1, text: LEAD_NEW }, { n: 2, text: "Không đội mũ bảo hộ khi vào công trường, trừ trường hợp quy định tại mục 1.1;" }, { n: 3, text: "Hút thuốc trong kho vật liệu." }]);
  assert.deepEqual((clause!.children as Array<{ ref: string }>).map((c) => c.ref), ["HB-001/2/1/1", "HB-001/2/1/2"]);
  assert.deepEqual(clause!.versions, [{ from: "2024-01-10", to: "2025-07-01", by: "HB-001" }, { from: "2025-07-01", by: "HB-001/AM-1" }]);
  assert.deepEqual(clause!.validity, { status: "in_force", since: "2025-07-01" });
  assert.deepEqual(clause!.refers, [{ ref: "HB-001/1/1", cite: "mục 1.1 sổ tay HB-001", text: "Sổ tay áp dụng cho mọi nhân viên làm việc tại công trường." }]); // from its point
  assert.deepEqual((hb!.children as Array<{ ref: string }>).map((c) => c.ref), ["HB-001/1", "HB-001/2"]); // top-level only
  assert.equal(missing!.found, false);
  // a well-formed ref of nothing is not read as another object (here, its handbook)
  assert.equal((await e.quote(["HB-001/9/9"]))[0]!.found, false);
  assert.match(String(missing!.note), /HB-001, HB-001\/2\/1/);
  const [cited] = await e.read(["HB-001/1/1"]);
  assert.deepEqual(cited!.citedBy, [{ ref: "HB-001/2/1/1", cite: "mục 2.1.1 sổ tay HB-001", text: "Không đội mũ bảo hộ khi vào công trường, trừ trường hợp quy định tại mục 1.1;" }]);
});

test("quote: lines, fields, and every ref an output shows reads back", async () => {
  const e = setup();
  const q = await e.quote(["HB-001/2/1 #1", "HB-001:owner", "HB-001/2/1:validity", "HB-001:pages", "HB-001/2/1 #5"], { at: "2025-08-01" });
  // a range running past the end is read to the end; one starting past it is not found
  assert.equal((await e.quote(["HB-001/2/1 #2-9"], { at: "2025-08-01" }))[0]!.text, "Không đội mũ bảo hộ khi vào công trường, trừ trường hợp quy định tại mục 1.1;\nHút thuốc trong kho vật liệu.");
  assert.deepEqual(errorsOf(e.toolDef("quote").output, q), []);
  assert.deepEqual(q.map((x) => x.found), [true, true, true, false, false]);
  assert.equal(q[0]!.text, LEAD_NEW);
  assert.equal(q[1]!.value, "Phòng An toàn");
  assert.deepEqual(await e.quote(["HB-001:issued"]), [{ ref: "HB-001:issued", found: true, cite: "HB-001", value: "2024-01-10", source: "HB-001/1/1" }]);   // its source, from the spec's `from`
  assert.match(String(q[3]!.note), /pages is not a field of Handbook/);
  assert.equal((await e.quote(["HB-001"]))[0]!.text, "Sổ tay an toàn lao động");   // no text: its title stands for it
  const bare = setup(functions, data().put({ type: "Handbook", ref: "HB-003", props: { owner: "Phòng Kế hoạch" } }));
  const [whole] = await bare.quote(["HB-003"]);                                // neither text nor title: not quoted as ""
  assert.equal(whole!.found, false);
  assert.match(String(whole!.note), /cite one of its parts, or a field/);
  // a filter that empties the result is named, with how many match without it
  const none = await e.find("Section", { handbook: ["HB-002"], text: ["đội mũ bảo hộ"] });
  assert.equal(none.verdict, "none");
  assert.match(none.note, /With handbook as given nothing matches the words of text\. handbook alone match 2 \(HB-002\/1, HB-002\/1\/1\)\. The words alone match \d+ without this filter/);
  const words = await e.find("Handbook", { owner: ["an toàn"], title: ["quy chế lương thưởng"] });  // the owner matches, the title words do not
  assert.equal(words.verdict, "none");
  assert.match(words.note, /owner alone matches 1 \(HB-001\)\./);
  // integrity: whatever ref a find shows (items, path, refers) can be quoted back
  const shown = new Set<string>();
  for (const ph of ["phạt tiền không đội mũ bảo hộ", "phụ cấp lưu trú", "phạm vi áp dụng"]) {
    for (const it of (await e.find("Section", { text: [ph] })).items) {
      shown.add(it.ref as string);
      for (const s of [...((it.path ?? []) as Array<{ ref: string }>), ...((it.refers ?? []) as Array<{ ref: string }>)]) shown.add(s.ref);
    }
  }
  assert.ok((await e.quote([...shown])).every((x) => x.found), [...shown].join(", "));
});

test("data: a value that breaks its type is kept out and reported; a function keeps its result type", async () => {
  const mem = data()
    .put({ type: "Section", ref: "HB-001/3", props: { handbook: "HB-001", level: "appendix", text: "Phụ lục" } })   // not a level
    .put({ type: "Section", ref: "hb-1/3", props: { handbook: "HB-001", level: "chapter" } })                      // not a SectionRef
    .put({ type: "Section", ref: "HB-001/4", props: { handbook: "HB-404", level: "chapter", text: "Phụ lục 2" } }); // dangling ref
  const e = setup(functions, mem);
  const h = await e.health();
  assert.deepEqual(h.flags.map((f) => `${f.ref} ${f.field}`).sort(), ["HB-001/3 level", "HB-001/4 handbook", "hb-1/3 ref"]);
  assert.equal(h.fill.Section!.level, "10/11");
  assert.deepEqual(await e.call("summary", { handbook: "HB-002" }), { title: "Sổ tay công tác phí", owner: "Phòng Tài chính", sections: 2 });
  const broken = setup({ ...functions, summary: async () => ({ title: 3 }) });
  await assert.rejects(broken.call("summary", { handbook: "HB-001" }), (x: HarnessError) => /summary returned a value that breaks its type HandbookSummary/.test(x.errors[0]!));
});

test("http: the same routes serve a typed spec; tool definitions carry their output schema", async () => {
  const e = setup();
  const server = createServer((req, res) => void handle(e, req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    const defs = await (await fetch(`http://127.0.0.1:${port}/v1/tools?surface=discover`)).json() as Array<{ name: string; output?: unknown }>;
    assert.deepEqual(defs.map((d) => d.name), ["find_section", "read", "find_handbook"]);
    assert.ok(defs.every((d) => !d.output));                                       // what a model is given
    const full = await (await fetch(`http://127.0.0.1:${port}/v1/tools?surface=discover&output=1`)).json() as Array<{ output?: unknown }>;
    assert.ok(full.every((d) => d.output));                                        // what checks and guards are given
    const r = await (await fetch(`http://127.0.0.1:${port}/v1/tool`, { method: "POST", body: JSON.stringify({ name: "read", args: { refs: '["HB-001/1/1"' } }) })).json() as Array<{ ref: string }>;
    assert.equal(r[0]!.ref, "HB-001/1/1");                                       // a list sent as a broken JSON string, repaired
    const h = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json() as { ok: boolean; objects: number };
    assert.equal(h.objects, 11);
  } finally { server.close(); }
});

// ------------------------------------------------------------------------------------------------ the store interface

/** A store seen through the interface only: it can be made to push down nothing, to lack an ability, and it counts
 *  every object it hands out — what any adapter (kb, a document database, SQL) would look like to the runtime. */
function through(inner: Store, over: Partial<Capabilities> = {}) {
  const seen = { get: 0, calls: [] as string[] };
  const store: Store = {
    capabilities: () => ({ ...inner.capabilities(), ...over }),
    open: (s, n) => inner.open(s, n),
    heads: () => inner.heads(),
    search: (q, who) => { seen.calls.push("search"); return inner.search({ ...q, filters: q.filters.filter((f) => (over.filters ?? inner.capabilities().filters).includes(f.kind)) }, who); },
    scan: (q, who) => { seen.calls.push("scan"); return inner.scan({ ...q, filters: q.filters.filter((f) => (over.filters ?? inner.capabilities().filters).includes(f.kind)) }, who); },
    get: async (refs, at, who) => { seen.calls.push("get"); seen.get += refs.length; return inner.get(refs, at, who); },
    neighbours: (l, d, refs, who) => { seen.calls.push("neighbours"); return inner.neighbours(l, d, refs, who); },
  };
  return { store, seen };
}

test("store: a store that pushes no filter down gives the same results (the runtime re-checks every filter)", async () => {
  const mem = () => { const m = data(); for (let i = 1; i <= 60; i++) m.put({ type: "Section", ref: `HB-001/8/${i}`, props: { handbook: "HB-001", level: "clause", text: `Điều khoản an toàn thứ ${i}.`, topics: ["safety"] } }); return m; };
  const plain = setup(functions, mem());
  const { store } = through(mem(), { filters: [] });       // the finance clause stands after 60 others: past any small limit
  const bare = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: store }, functions);
  for (const [type, args] of [["Section", { topics: ["finance"] }], ["Handbook", { issued: { max: "2023-12-31" } }], ["Section", { handbook: ["hb 2"], text: ["phụ cấp lưu trú"] }], ["Handbook", { owner: ["an toàn"] }]] as const)
    assert.deepEqual((await bare.find(type, args)).items.map((i) => i.ref), (await plain.find(type, args)).items.map((i) => i.ref), JSON.stringify(args));
});

test("store: what the spec needs and the store cannot do is refused at start, not when a model calls", async () => {
  const noSearch = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: through(data(), { search: false }).store }, functions);
  await assert.rejects(noSearch.find("Handbook", { owner: ["an toàn"] }), (x: HarnessError) => x.errors.some((e) => /Section: finds by text, but store "main" has no text search/.test(e)));
  const noTime = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: through(data(), { at: false }).store }, functions);
  await assert.rejects(noTime.read(["HB-001"]), (x: HarnessError) => x.errors.some((e) => /Section: Versioned, but store "main" does not read at a date/.test(e)));
});

test("store: a find reads only the objects it shows, never the whole store", async () => {
  const mem = data();
  for (let i = 1; i <= 300; i++) mem.put({ type: "Section", ref: `HB-002/9/${i}`, props: { handbook: "HB-002", level: "clause", text: `Quy định thứ ${i} về hồ sơ thanh toán.` } }).link("inHandbook", `HB-002/9/${i}`, "HB-002");
  const { store, seen } = through(mem);
  const e = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: store }, functions);
  const p = await e.find("Section", { text: ["không đội mũ bảo hộ"] });
  assert.equal(p.items[0]!.ref, "HB-001/2/1/1");
  assert.ok(seen.get < 40, `objects fetched: ${seen.get} of 311`);
  console.log(`  find read ${seen.get} of 311 objects, in ${seen.calls.length} store calls`);
  assert.equal(seen.calls.filter((c) => c === "search").length, 1);
});

test("find: filters a store does not apply are applied by the runtime — same page; a cut candidate list is never 'none'", async () => {
  const full = setup();
  // a store that lists every kind as applied but applies none of them (an adapter's old ref filter)
  const lazy = () => {
    const mem = data();
    const wrap = Object.create(mem) as Store;
    wrap.open = (spec, name) => mem.open(spec, name);
    wrap.applies = () => false;
    wrap.scan = async (q, who) => (await mem.scan({ ...q, filters: [] }, who)).slice(0, q.limit);
    wrap.search = async (q, who) => (await mem.search({ ...q, filters: [] }, who)).slice(0, q.limit);
    return new TypedEngine(buildTypedSpec(parse(SPEC)), { main: wrap }, functions);
  };
  const asks = [
    ["Section", { handbook: ["HB-001"] }], ["Section", { handbook: ["HB-002"], text: ["phụ cấp lưu trú"] }],
    ["Section", { topics: ["finance"] }], ["Handbook", { issued: { max: "2023-12-31" } }], ["Handbook", { status: ["active"] }],
  ] as const;
  for (const [type, args] of asks) {
    const a = await full.find(type, args), b = await lazy().find(type, args);
    assert.deepEqual(b.items.map((i) => i.ref), a.items.map((i) => i.ref), `${type} ${JSON.stringify(args)}`);
    assert.equal(b.verdict, a.verdict);
  }
  // the store fills the whole bound with candidates that all fail the filter: the bound was reached, so not "none"
  const mem = data(), wrap = Object.create(mem) as Store;
  wrap.open = (spec, name) => mem.open(spec, name);
  wrap.applies = () => false;
  wrap.scan = async (q) => new Array(q.limit).fill("HB-001/1/1");
  const cut = await new TypedEngine(buildTypedSpec(parse(SPEC)), { main: wrap }, functions).find("Section", { handbook: ["HB-002"] });
  assert.match(cut.note, /Not settled/);
  assert.notEqual(cut.verdict, "none");
  assert.ok((cut.items as Array<{ ref: string }>).every((i) => i.ref.startsWith("HB-002")));
});

test("find: a ranked search in one object whose parts are not among the store's first few candidates still finds them", async () => {
  // a large base: the store gives only its first candidate over the whole base (the HB-001 one); filtered to HB-002 in
  // the runtime that is nothing — the store is asked again with the filter applied
  const mem = data(), wrap = Object.create(mem) as Store;
  wrap.open = (spec, name) => mem.open(spec, name);
  wrap.search = async (q, who) => { const all = await mem.search(q, who); return q.filters.some((f) => f.prop === "handbook") ? all : all.filter((h) => h.ref.startsWith("HB-001")).slice(0, 1); };
  const e = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: wrap }, functions);
  const full = await setup().find("Section", { handbook: ["HB-002"], text: ["phụ cấp lưu trú"] });
  const got = await e.find("Section", { handbook: ["HB-002"], text: ["phụ cấp lưu trú"] });
  assert.notEqual(got.verdict, "none");
  assert.deepEqual(got.items.map((i) => i.ref), full.items.map((i) => i.ref));
});

test("find: total on every answer, a listing in the refs' natural order, a limit above 20 refused", async () => {
  const e = setup();
  const all = await e.find("Section", { handbook: ["HB-001"] });
  const refs = (all.items as Array<{ ref: string }>).concat(((all as { more?: unknown[] }).more ?? []) as Array<{ ref: string }>).map((i) => i.ref);
  assert.equal(all.total, refs.length);
  assert.equal(all.exact, true);
  assert.deepEqual(refs, [...refs].sort(new Intl.Collator("en", { numeric: true }).compare));
  const two = await e.find("Section", { handbook: ["HB-001"], limit: 2 });
  assert.equal(two.total, all.total);
  assert.equal((two.items as unknown[]).length + ((two as { more?: unknown[] }).more ?? []).length, 2);
  assert.match(two.note, new RegExp(`${all.total} match, 2 shown: there are ${all.total}`));
  assert.equal((await e.find("Section", { text: ["bảo hiểm thất nghiệp"] })).total, 0);
  await assert.rejects(e.find("Section", { handbook: ["HB-001"], limit: 21 }), (x: HarnessError) => /limit: expected at most 20/.test(x.errors[0]!));
  // a store that cannot count: the runtime counts from its scan, the same total
  const mem = data(), wrap = Object.create(mem) as Store;
  wrap.open = (spec, name) => mem.open(spec, name);
  (wrap as { count?: unknown }).count = undefined;
  const e2 = new TypedEngine(buildTypedSpec(parse(SPEC)), { main: wrap }, functions);
  assert.equal((await e2.find("Section", { handbook: ["HB-001"], limit: 2 })).total, all.total);
});

test("find: by counts by value (a date by year), with samples; first / last order a listing; spec checks group / extreme", async () => {
  const raw = parse(SPEC);
  raw.types.Handbook.properties.status.group = true;
  raw.types.Handbook.properties.issued.group = true;
  raw.types.Handbook.properties.issued.extreme = true;
  raw.types.Section.properties.handbook.group = true;
  const e = new TypedEngine(buildTypedSpec(raw), { main: data() }, functions);
  const list = await e.find("Handbook", {});
  const refs = (list.items as Array<{ ref: string; status?: string; issued?: string }>).concat((list.more ?? []) as never[]);
  const byStatus = await e.find("Handbook", { by: "status" });
  assert.equal(byStatus.total, list.total);
  assert.equal(byStatus.groups!.reduce((n, g) => n + g.count, 0), list.total);
  for (const g of byStatus.groups!) assert.ok(g.sample.length >= 1 && g.sample.length <= 3);
  const byYear = await e.find("Handbook", { by: "issued:year" });
  assert.ok(byYear.groups!.every((g) => /^\d{4}$|^\(none\)$/.test(g.value)));
  const sections = await e.find("Section", { by: "handbook" });
  assert.deepEqual(sections.groups!.map((g) => g.value).sort(), [...new Set(sections.groups!.flatMap((g) => g.sample.map((s) => s.split("/")[0])))].sort());
  // with words: an object counts when it holds every word of one phrasing
  const w = await e.find("Section", { text: ["phụ cấp lưu trú"], by: "handbook" });
  assert.ok(w.total >= 1 && w.groups!.every((g) => g.value === "HB-002"));
  // first / last: earliest / latest issued first, objects without it last
  const last = await e.find("Handbook", { last: "issued" }), first = await e.find("Handbook", { first: "issued" });
  const dates = (p: typeof last) => (p.items as Array<{ issued?: string }>).map((i) => i.issued).filter(Boolean) as string[];
  assert.deepEqual(dates(last), [...dates(last)].sort().reverse());
  assert.deepEqual(dates(first), [...dates(first)].sort());
  assert.match(last.note, /largest \/ latest first/);
  await assert.rejects(e.find("Handbook", { title: ["sổ tay"], last: "issued" }), (x: HarnessError) => /last orders a listing: leave out the words/.test(x.errors[0]!));
  await assert.rejects(e.find("Section", { last: "issued" }), (x: HarnessError) => /last: unknown argument/.test(x.errors[0]!));
  await assert.rejects(e.find("Handbook", { by: "status", last: "issued" }), (x: HarnessError) => /one of them in a call/.test(x.errors[0]!));
  await assert.rejects(e.find("Handbook", { by: "owner" }), (x: HarnessError) => /by: expected one of/.test(x.errors[0]!));
  // the spec refuses grouping a text and ordering a string
  const bad = parse(SPEC);
  bad.types.Section.properties.text.group = true;
  bad.types.Handbook.properties.owner.extreme = true;
  assert.throws(() => buildTypedSpec(bad), (x: Error) => /text\.group: an enum, ref, bool, string or date/.test(x.message) && /owner\.extreme: a date or a number/.test(x.message));
  void refs;
});

test("find: within lists what lies below an object, counted; fields keep the card short (find and read)", async () => {
  const e = setup();
  const all = await e.find("Section", { handbook: ["HB-001"] });
  const inHb = await e.find("Section", { within: ["HB-001"] });
  assert.equal(inHb.total, all.total);                                           // a handbook's sections: all below it
  const one = (inHb.items as Array<{ ref: string }>)[0]!.ref;
  const below = await e.find("Section", { within: [one] });
  assert.ok((below.items as Array<{ ref: string }>).every((i) => i.ref.startsWith(`${one}/`)));
  assert.ok(below.total < inHb.total);
  const words = await e.find("Section", { within: ["HB-002"], text: ["phụ cấp lưu trú"] });
  assert.ok((words.items as Array<{ ref: string }>).every((i) => i.ref.startsWith("HB-002/")));
  const slim = await e.find("Handbook", { fields: ["issued"] });
  for (const c of slim.items as Array<Record<string, unknown>>) assert.deepEqual(Object.keys(c).filter((k) => !["ref", "object", "cite", "issued"].includes(k)), []);
  const [r] = await e.read(["HB-001"], { fields: ["title"] }) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(r!).sort(), ["cite", "object", "ref", "title"]);
  assert.match(e.toolDef("find_section").description, /inside \(within\)/);
  // a citation in within is read into a ref, and the answer says what it was read as
  const cited = await e.find("Section", { within: ["hb 1"] });
  assert.match(cited.note, /Within: "hb 1" read as HB-001/);
});

test("read: a whole tells how many parts lie inside it, at every depth (no list for the model to count)", async () => {
  const e = setup();
  const [hb] = await e.read(["HB-001"]) as Array<Record<string, any>>;
  const inside = await e.find("Section", { within: ["HB-001"] });
  assert.equal(hb!.parts.total, inside.total);
  const found = await e.find("Handbook", { owner: ["an toàn"] });
  assert.equal((found.items as Array<Record<string, unknown>>)[0]!.parts, undefined);   // only when read
});
