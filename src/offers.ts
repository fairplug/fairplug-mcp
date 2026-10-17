import fs from "node:fs";
import { offersPath } from "./config.js";

export interface Offer {
  id: string; advertiser_id: string; campaign_id: string; source?: string; vertical: string;
  category_path: string[]; title: string; summary: string; attributes: Record<string, string | number | boolean>;
  price?: { amount: number; currency: string; unit: string }; availability: string; url: string;
  payout: { model: "cpa_fixed" | "cpa_percent" | "cpl"; amount: number; currency: string; attribution_window_days?: number; validation_days?: number };
  eligibility: { geo?: string[]; requires_user_action?: boolean };
  disclosure: { label: "Sponsored" | "Ad" | "Affiliate link"; sponsor_name: string; material_connection?: string };
  status: string; ads_eligible: boolean; is_example?: boolean;
}

export const SEED_NOTICE = "EXAMPLE/SEED DATA: these offers are fictional and for local testing only.";

let injected: Offer[] | null = null;
/** Inject offers (used by the Worker, which has no filesystem). Pass null to go back to the file. */
export function setOffers(raw: { offers: Offer[] } | null): void { injected = raw ? raw.offers : null; }

export function loadOffers(): Offer[] {
  const all = injected ?? (JSON.parse(fs.readFileSync(offersPath(), "utf8")).offers as Offer[]);
  return all.filter((o) => o.status === "active" && o.ads_eligible);
}

export function getOffer(id: string): Offer | undefined {
  return loadOffers().find((o) => o.id === id);
}

const VERTICAL_ALIASES: Record<string, string> = {
  travel: "travel", saas: "b2b_saas", b2b_saas: "b2b_saas", software: "b2b_saas", retail: "retail", shopping: "retail",
};

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1).map((t) => (t.length > 3 ? t.replace(/s$/, "") : t));

export function searchOffers(query: string, category?: string, region?: string, limit = 5): Array<{ offer: Offer; score: number }> {
  const q = tokens(query);
  const cat = category?.toLowerCase().trim();
  const reg = region?.toUpperCase().trim();
  const out: Array<{ offer: Offer; score: number }> = [];
  for (const offer of loadOffers()) {
    // hard eligibility filters first (spec: relevance first, filters before ranking)
    if (reg && offer.eligibility.geo && !offer.eligibility.geo.includes(reg)) continue;
    if (cat) {
      const v = VERTICAL_ALIASES[cat] ?? cat;
      const inPath = offer.category_path.some((c) => c.toLowerCase() === cat || c.toLowerCase().includes(cat));
      if (offer.vertical !== v && !inPath) continue;
    }
    const title = new Set(tokens(offer.title));
    const catTok = new Set(tokens(offer.category_path.join(" ")));
    const rest = new Set(tokens([offer.summary, offer.vertical, Object.keys(offer.attributes).join(" ")].join(" ")));
    let score = 0;
    for (const t of q) {
      if (title.has(t)) score += 3;
      else if (catTok.has(t)) score += 2;
      else if (rest.has(t)) score += 1;
      else if ([...title, ...rest, ...catTok].some((w) => w.startsWith(t) || (t.length > 3 && t.startsWith(w) && w.length > 3))) score += 0.5;
    }
    if (q.length && score === 0) continue;
    out.push({ offer, score });
  }
  return out.sort((a, b) => b.score - a.score || a.offer.id.localeCompare(b.offer.id)).slice(0, limit);
}

export function disclosureText(o: Offer): string {
  const mc = o.disclosure.material_connection ?? "Fairplug may earn a commission if you buy through this link.";
  return `${o.disclosure.label}: ${o.title} is promoted by ${o.disclosure.sponsor_name}. ${mc}`;
}
