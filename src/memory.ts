// MEMORY ADAPTER — a store held in memory: objects by type, links as pairs of refs. For tests, examples and small
// reference tables. Filters follow the spec: exact / enum = any of the values, text = any phrasing whose words all stand
// in the value (case and diacritics ignored), range = min / max inclusive.

import type { Caller, FindQuery, Item, Missing, Page, StoreAdapter } from "./engine.ts";
import type { LinkView, TypeDecl } from "./spec.ts";

export interface MemObject { ref: string; type: string; props: Record<string, unknown>; cite?: string; clearance?: string }

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export class MemoryAdapter implements StoreAdapter {
  private readonly objects = new Map<string, MemObject>();
  private readonly edges: Array<{ link: string; from: string; to: string }> = [];
  private version = 0;

  put(o: MemObject): this { this.objects.set(o.ref, o); this.version++; return this; }
  link(link: string, from: string, to: string): this { this.edges.push({ link, from, to }); this.version++; return this; }

  private visible(o: MemObject, who: Caller) { return !o.clearance || o.clearance === "public" || o.clearance === who.clearance; }
  private item(o: MemObject, match?: number): Item { return { ref: o.ref, type: o.type, ...(o.cite ? { cite: o.cite } : {}), props: o.props, ...(match !== undefined ? { match } : {}) }; }

  async find(t: TypeDecl, q: FindQuery, who: Caller): Promise<Page> {
    const scored: Array<{ o: MemObject; score: number }> = [];
    for (const o of this.objects.values()) {
      if (o.type !== t.name || !this.visible(o, who)) continue;
      let score = 1, ok = true;
      for (const [name, f] of Object.entries(q.filters)) {
        const p = t.properties[name];
        const v = o.props[name];
        if (!p || f === undefined) continue;
        if (p.filter === "text") {
          const have = new Set(words(String(v ?? "")));
          const best = Math.max(0, ...(f as string[]).map((ph) => { const w = words(ph); return w.length ? w.filter((x) => have.has(x)).length / w.length : 0; }));
          if (best < 1) ok = false; else score *= best;
        } else if (p.filter === "range") {
          const r = f as { min?: unknown; max?: unknown };
          if ((r.min !== undefined && !((v as never) >= (r.min as never))) || (r.max !== undefined && !((v as never) <= (r.max as never)))) ok = false;
        } else if (typeof f === "boolean") { if (v !== f) ok = false; }
        else {
          const any = f as unknown[];
          const vs = Array.isArray(v) ? v : [v];
          if (!vs.some((x) => any.includes(x))) ok = false;
        }
        if (!ok) break;
      }
      if (ok) scored.push({ o, score });
    }
    scored.sort((a, b) => b.score - a.score || a.o.ref.localeCompare(b.o.ref));
    if (!scored.length) return { verdict: "none", note: `No ${t.name} matches.`, items: [] };
    const items = scored.slice(0, q.limit).map((x) => this.item(x.o, x.score));
    return { verdict: "found", note: "Best matches first.", items, ...(scored.length > q.limit ? { more: scored.slice(q.limit, q.limit + 10).map((x) => this.item(x.o)) } : {}) };
  }

  async get(t: TypeDecl | undefined, refs: readonly string[], _at: string | undefined, who: Caller): Promise<Array<Item | Missing>> {
    return refs.map((ref) => {
      const o = this.objects.get(ref);
      if (!o || (t && o.type !== t.name) || !this.visible(o, who)) return { ref, found: false as const, note: t ? `no ${t.name} ${ref}` : `no object ${ref}` };
      return this.item(o);
    });
  }

  async follow(v: LinkView, refs: readonly string[], _at: string | undefined, who: Caller) {
    return refs.map((ref) => {
      const to = this.edges.filter((e) => e.link === v.link.name && (v.backward ? e.to === ref : e.from === ref)).map((e) => (v.backward ? e.from : e.to));
      const items = to.map((r) => this.objects.get(r)).filter((o): o is MemObject => !!o && this.visible(o, who)).map((o) => this.item(o));
      return { ref, items };
    });
  }

  async heads() { return `mem:${this.version}`; }
}
