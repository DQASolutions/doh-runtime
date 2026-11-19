// The handbook project as the runtime loads it: its spec, its store (here in memory), and its domain code — three
// helpers the spec names (parse two kinds of ref, cite a section) and one function. Nothing else is written by hand:
// tools, filters, cards and output schemas are generated from the spec's types.
//
//   node bin/harness.mjs tools --project examples/handbook/project.ts
//   node bin/harness.mjs tool  --project examples/handbook/project.ts find_section '{"text":["phạt tiền không đội mũ bảo hộ"]}'

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Project } from "../../src/project.ts";
import type { TypedFunctionImpl } from "../../src/typed/engine.ts";
import { MemoryStore } from "../../src/typed/store.ts";

export const SPEC_FILE = join(dirname(fileURLToPath(import.meta.url)), "spec.yaml");

export const LEAD_NEW = "Phạt tiền từ 500.000 đồng đến 1.000.000 đồng đối với một trong các hành vi sau:";
export const LEAD_OLD = "Phạt tiền từ 300.000 đồng đến 500.000 đồng đối với một trong các hành vi sau:";

export function data() {
  const mem = new MemoryStore()
    .put({ type: "Handbook", ref: "HB-001", props: { title: "Sổ tay an toàn lao động", owner: "Phòng An toàn", issued: "2024-01-10", issued_by: "HB-001/1/1", status: "active" } })
    .put({ type: "Handbook", ref: "HB-002", props: { title: "Sổ tay công tác phí", owner: "Phòng Tài chính", issued: "2023-05-01", status: "active" } })
    .put({ type: "Section", ref: "HB-001/1", props: { handbook: "HB-001", level: "chapter", title: "Quy định chung", text: "Quy định chung" } })
    .put({ type: "Section", ref: "HB-001/1/1", props: { handbook: "HB-001", level: "clause", title: "Phạm vi áp dụng", text: "Sổ tay áp dụng cho mọi nhân viên làm việc tại công trường." } })
    .put({ type: "Section", ref: "HB-001/2", props: { handbook: "HB-001", level: "chapter", title: "Xử lý vi phạm", text: "Xử lý vi phạm", topics: ["discipline"] } })
    .put({ type: "Section", ref: "HB-001/2/1", props: { handbook: "HB-001", level: "clause", topics: ["discipline", "safety"] } })
    .put({ type: "Section", ref: "HB-001/2/1/1", props: { handbook: "HB-001", level: "point", text: "Không đội mũ bảo hộ khi vào công trường, trừ trường hợp quy định tại mục 1.1;", topics: ["safety"] } })
    .put({ type: "Section", ref: "HB-001/2/1/2", props: { handbook: "HB-001", level: "point", text: "Hút thuốc trong kho vật liệu.", topics: ["safety"] } })
    .put({ type: "Section", ref: "HB-002/1", props: { handbook: "HB-002", level: "chapter", title: "Định mức công tác phí", text: "Định mức công tác phí" } })
    .put({ type: "Section", ref: "HB-002/1/1", props: { handbook: "HB-002", level: "clause", text: "Mức phụ cấp lưu trú là 200.000 đồng mỗi ngày.", topics: ["finance"] } })
    .put({ type: "Section", ref: "HB-002/1/2", props: { handbook: "HB-002", level: "clause", text: "Mức phụ cấp lưu trú của ban giám đốc là 500.000 đồng mỗi ngày.", topics: ["finance"] }, clearance: "staff" })
    // a clause whose lead changed: the earlier text until 2025-07-01, the later one from then on
    .version({ ref: "HB-001/2/1", from: "2024-01-10", to: "2025-07-01", by: "HB-001", props: { text: LEAD_OLD } })
    .version({ ref: "HB-001/2/1", from: "2025-07-01", by: "HB-001/AM-1", props: { text: LEAD_NEW } });
  for (const s of ["HB-001/1", "HB-001/1/1", "HB-001/2", "HB-001/2/1", "HB-001/2/1/1", "HB-001/2/1/2"]) mem.link("inHandbook", s, "HB-001");
  for (const s of ["HB-002/1", "HB-002/1/1", "HB-002/1/2"]) mem.link("inHandbook", s, "HB-002");
  mem.link("parent", "HB-001/1/1", "HB-001/1").link("parent", "HB-001/2/1", "HB-001/2")
    .link("parent", "HB-001/2/1/1", "HB-001/2/1").link("parent", "HB-001/2/1/2", "HB-001/2/1")
    .link("parent", "HB-002/1/1", "HB-002/1").link("parent", "HB-002/1/2", "HB-002/1")
    .link("refersTo", "HB-001/2/1/1", "HB-001/1/1");
  return mem;
}


// the project's domain code: three helpers (parse two kinds of ref, cite a section) and one function
export const functions: Record<string, TypedFunctionImpl> = {
  parseHandbook: async ({ text }) => { const m = /hb\s*-?\s*0*(\d{1,3})/i.exec(String(text)); return m ? `HB-${m[1]!.padStart(3, "0")}` : null; },
  parseSection: async ({ text }) => {
    const h = /hb\s*-?\s*0*(\d{1,3})/i.exec(String(text)), p = /mục\s+([\d.]+)/i.exec(String(text));
    return h && p ? `HB-${h[1]!.padStart(3, "0")}/${p[1]!.replace(/\.$/, "").split(".").join("/")}` : null;
  },
  citeSection: async ({ ref }) => { const [hb, ...path] = String(ref).split("/"); return `mục ${path.join(".")} sổ tay ${hb}`; },
  summary: async ({ handbook }, ctx) => {
    const [h] = await ctx.engine.read([handbook]);
    const all = (await ctx.engine.follow("sections", [handbook])).results[0]!.items;
    return { title: String(h!.title), owner: String(h!.owner), sections: all.length };
  },
};

export const project: Project = {
  spec: SPEC_FILE,
  async open() { return { stores: { main: data() }, functions }; },
};
