// טבלאות המעבר של מבחן ספציפי, מתוך דף "חישוב אומדן ציוני הבחינה" שבסוף חוברות מאל"ו.
// הקלט: הטקסט של העמודים (פריטים עם s, x, y, w) כפי ש-pdf.js מחזיר אותו.
import { RAW_TO_V, RAW_TO_Q, GENERAL_TABLE, PERCENTILE_TABLE } from './tables.js';

export const DEFAULT_TABLES = { V: RAW_TO_V, Q: RAW_TO_Q, general: GENERAL_TABLE, pct: PERCENTILE_TABLE };
export const DEFAULT_LABEL = 'טבלה כללית (סתיו 2023)';

const NUM = /^\d+(\.\d+)?$/;
const clean = (s) => s.replace(/[‎‏‪-‮⁦-⁩\s]/g, '');

// group a page's items into rows of tokens; "a - b" becomes one range token
function rows(items) {
  const lines = [];
  for (const it of items) {
    const s = clean(it.s);
    if (!s) continue;
    let L = lines.find(l => Math.abs(l.y - it.y) < 2.5);
    if (!L) { L = { y: it.y, raw: [] }; lines.push(L); }
    L.raw.push({ s, x: it.x, w: it.w || 0 });
  }
  return lines.map(L => {
    const r = L.raw.sort((a, b) => a.x - b.x);
    const toks = [];
    let onlyNums = true;
    for (let i = 0; i < r.length; i++) {
      const t = r[i];
      // range written as separate items: 100.5 - 105
      if (NUM.test(t.s) && r[i + 1] && r[i + 1].s === '-' && r[i + 2] && NUM.test(r[i + 2].s)) {
        const a = +t.s, b = +r[i + 2].s;
        toks.push({ lo: Math.min(a, b), hi: Math.max(a, b), cx: (t.x + r[i + 2].x + r[i + 2].w) / 2 });
        i += 2; continue;
      }
      const m = t.s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/); // range as a single item
      if (m) { const a = +m[1], b = +m[2]; toks.push({ lo: Math.min(a, b), hi: Math.max(a, b), cx: t.x + t.w / 2 }); continue; }
      if (NUM.test(t.s)) { toks.push({ lo: +t.s, hi: +t.s, cx: t.x + t.w / 2 }); continue; }
      onlyNums = false;
    }
    return { y: L.y, toks, onlyNums };
  }).sort((a, b) => b.y - a.y);
}

// raw score -> V and Q. Columns come in groups of three: (Q, V, raw) from left to right.
function parseRawTable(R) {
  const rowsN = R.filter(r => r.onlyNums && r.toks.length >= 6 && r.toks.every(t => t.lo === t.hi && Number.isInteger(t.lo)));
  if (rowsN.length < 10) return null;
  const xs = rowsN.flatMap(r => r.toks.map(t => t.cx)).sort((a, b) => a - b);
  const clusters = [];
  for (const x of xs) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.max < 15) { c.max = x; c.xs.push(x); } else clusters.push({ min: x, max: x, xs: [x] });
  }
  if (clusters.length !== 9) return null;
  const centers = clusters.map(c => c.xs.reduce((a, b) => a + b, 0) / c.xs.length);
  const V = [], Q = [];
  for (const r of rowsN) {
    const byCol = {};
    for (const t of r.toks) {
      let best = 0, bd = 1e9;
      centers.forEach((c, i) => { const d = Math.abs(c - t.cx); if (d < bd) { bd = d; best = i; } });
      byCol[best] = t.lo;
    }
    for (let g = 0; g < 3; g++) {
      const q = byCol[g * 3], v = byCol[g * 3 + 1], raw = byCol[g * 3 + 2];
      if (raw == null) continue;
      if (v != null) V[raw] = v;
      if (q != null) Q[raw] = q;
    }
  }
  return { V, Q };
}

// weighted score -> general score range. Pairs of (general, weighted) from left to right.
function parseGeneralTable(R) {
  const out = [];
  for (const r of R) {
    if (!r.onlyNums || r.toks.length < 2) continue;
    const t = r.toks;
    for (let i = 1; i < t.length; i++) {
      const w = t[i], g = t[i - 1];
      if (w.hi <= 150 && w.lo >= 50 && g.lo >= 200 && g.hi <= 800) out.push({ max: w.hi, min: w.lo, lo: g.lo, hi: g.hi });
    }
  }
  out.sort((a, b) => a.max - b.max);
  return out.length ? out : null;
}

// general score range -> % of examinees below. Columns from left: above, in, below, range.
function parsePercentileTable(R) {
  const out = [];
  for (const r of R) {
    const t = r.toks;
    if (!r.onlyNums || t.length !== 4) continue;
    const range = t[3];
    if (range.lo < 200 || range.hi > 800 || range.lo === range.hi) continue;
    if (![0, 1, 2].every(i => t[i].lo === t[i].hi && t[i].lo >= 0 && t[i].lo <= 100)) continue;
    out.push({ lo: range.lo, hi: range.hi, below: t[2].lo });
  }
  out.sort((a, b) => a.hi - b.hi);
  return out.length ? out.map(({ hi, below }) => ({ hi, below })) : null;
}

export function validateVQ(V, Q) {
  const errs = [];
  const chk = (arr, n, name) => {
    if (!arr || arr.length !== n + 1) { errs.push(`${name}: צריך ערכים לציוני גלם 0 עד ${n}`); return; }
    for (let i = 0; i <= n; i++) {
      const v = arr[i];
      if (!Number.isFinite(v) || v < 50 || v > 150) { errs.push(`${name}: ערך לא תקין בציון גלם ${i}`); return; }
      if (i && v < arr[i - 1]) { errs.push(`${name}: הערך בציון גלם ${i} קטן מהקודם`); return; }
    }
  };
  chk(V, 46, 'מילולי'); chk(Q, 40, 'כמותי');
  return errs;
}
function validGeneral(G) {
  if (!G || G.length < 15 || G[G.length - 1].max !== 150) return false;
  for (let i = 1; i < G.length; i++) if (G[i].lo <= G[i - 1].hi || G[i].max <= G[i - 1].max) return false;
  return true;
}
function validPct(P) {
  if (!P || P.length < 10) return false;
  for (let i = 1; i < P.length; i++) if (P[i].below < P[i - 1].below || P[i].hi <= P[i - 1].hi) return false;
  return true;
}

// pagesText: [{ header, body, items }]. Returns { tables, label, ok, problems } or null when no scoring page.
export function extractTables(pagesText) {
  const pages = pagesText.filter(t => /חישוב אומדן/.test(t.header + ' ' + t.body));
  if (!pages.length) return null;
  const label = (() => { for (const p of pages) { const m = (p.header + ' ' + p.body).match(/(חורף|אביב|קיץ|סתיו)\s*(\d{4})/); if (m) return `${m[1]} ${m[2]}`; } return null; })();
  let raw = null, general = null, pct = null;
  for (const p of pages) {
    const R = rows(p.items);
    raw = raw || parseRawTable(R);
    const g = parseGeneralTable(R); if (g && validGeneral(g)) general = general || g;
    const pc = parsePercentileTable(R); if (pc && validPct(pc)) pct = pct || pc;
  }
  const problems = raw ? validateVQ(raw.V, raw.Q) : ['לא נמצאה טבלת המעבר מציוני גלם'];
  return {
    label,
    ok: problems.length === 0,
    problems,
    tables: {
      V: raw ? Array.from({ length: 47 }, (_, i) => raw.V[i] ?? null) : null,
      Q: raw ? Array.from({ length: 41 }, (_, i) => raw.Q[i] ?? null) : null,
      general: general ? general.map(({ max, lo, hi }) => ({ max, lo, hi })) : null,
      pct,
    },
  };
}

// ---------- scoring ----------
function weightedToGeneral(w, G) {
  const r = Math.round(w * 2) / 2;
  for (const row of G) if (r <= row.max) return { weighted: r, lo: row.lo, hi: row.hi };
  return { weighted: r, lo: 800, hi: 800 };
}
function percentBelow(g, P) {
  for (const row of P) if (g <= row.hi) return row.below;
  return P[P.length - 1].below;
}
// tables may be partial: missing parts fall back to the general table
export function scoreFromRaw(vRaw, qRaw, tables) {
  const T = { ...DEFAULT_TABLES, ...Object.fromEntries(Object.entries(tables || {}).filter(([, v]) => v)) };
  const V = T.V[Math.max(0, Math.min(vRaw, T.V.length - 1))];
  const Q = T.Q[Math.max(0, Math.min(qRaw, T.Q.length - 1))];
  const mk = (w) => { const g = weightedToGeneral(w, T.general); return { ...g, mid: Math.round((g.lo + g.hi) / 2) }; };
  const two = mk((V + Q) / 2), verbalW = mk((3 * V + Q) / 4), quantW = mk((3 * Q + V) / 4);
  return { vRaw, qRaw, V, Q, two, verbalW, quantW, percentBelow: percentBelow(two.mid, T.pct) };
}
