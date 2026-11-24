// סימולטור פסיכומטרי — מעלה PDF של סימולציה, מציג פרק אחרי פרק עם זמן נעול, ומנקד לפי מפתח התשובות.
import * as pdfjs from './vendor/pdf.min.js';
import { extractTables, scoreFromRaw, validateVQ, DEFAULT_TABLES, DEFAULT_LABEL } from './scoring.js?v=202611241420';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;

const $app = document.getElementById('app');
const STATE_KEY = 'psy_state_v1';
const HISTORY_KEY = 'psy_history_v1';
const DEFAULT_ESSAY_MIN = 30;
const DEFAULT_SECTION_MIN = 20;
const WARN_MS = 5 * 60 * 1000;
const SCROLL_TO = 0.2; // where a question lands on screen when jumping to it from the answer bar

let state = null;     // persisted
let pdfDoc = null;    // loaded pdf.js document
let tickTimer = null;
let lastTick = 0;
let selectedQ = 0;    // question shown in the bottom answer row
let renderGen = 0;    // bumps on every screen change, so stale async page rendering stops
let busy = false;     // a file is being processed
let revisit = null;   // review-mode view: { rep, layout, doc, si, back }
let historyView = null; // results screen of a saved simulation: { id }
let homeView = false;   // show the home page (history) while the last finished simulation is still open
let lockedOut = false; // the exam was changed from another tab
const TAB_ID = Math.random().toString(36).slice(2);
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);

// ---------- storage ----------
function save() { if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY)); } catch { return null; } }
function history() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('psy_pdfs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pdfs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function putPdf(id, buf) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('pdfs', 'readwrite'); t.objectStore('pdfs').put(buf, id); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
async function getPdf(id) {
  const db = await idb();
  return new Promise((res, rej) => { const r = db.transaction('pdfs').objectStore('pdfs').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function delPdf(id) {
  const db = await idb();
  return new Promise((res) => { const t = db.transaction('pdfs', 'readwrite'); t.objectStore('pdfs').delete(id); t.oncomplete = res; t.onerror = res; });
}

// ---------- helpers ----------
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rng = (lo, hi) => lo === hi ? `${lo}` : `<span dir="ltr">${lo}–${hi}</span>`;
const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const domainName = (d) => ({ quant: 'חשיבה כמותית', verbal: 'חשיבה מילולית', english: 'אנגלית' }[d] || 'פרק');

function toast(msg, ms = 6000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function modal(contentEl) {
  const m = document.getElementById('modal');
  const body = m.querySelector('.modal-body');
  body.innerHTML = ''; body.appendChild(contentEl);
  m.classList.remove('hidden');
  const close = () => m.classList.add('hidden');
  m.querySelector('.modal-close').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
}
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- PDF analysis ----------
async function pageText(page) {
  const tc = await page.getTextContent();
  const H = page.view[3];
  const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width }));
  const header = items.filter(i => i.y > H * 0.88).map(i => i.s).join(' ');
  const body = items.filter(i => i.y <= H * 0.88).map(i => i.s).join(' ');
  return { items, header, body, H };
}

function classify(t) {
  const hd = t.header;
  const blank = t.body.length < 40 && (/עמוד ריק/.test(t.body) || /טיוטה/.test(t.body));
  if (/פתרונות/.test(hd)) return { kind: 'solutions' };
  if (/מפתח תשובות/.test(hd)) return { kind: 'key' };
  if (/חישוב אומדן/.test(hd)) return { kind: 'scoring' };
  if (/מטלת כתיבה/.test(hd)) return { kind: 'essay', blank };
  const m = hd.match(/פרק\s*(\d+)/);
  if (m) {
    const domain = /כמותית/.test(hd) ? 'quant' : /מילולית/.test(hd) ? 'verbal' : /אנגלית|English/i.test(hd) ? 'english' : 'other';
    return { kind: 'section', num: +m[1], domain, blank };
  }
  return { kind: 'other', blank };
}

// Answer key: rows of question numbers followed by rows of answers (1-4), grouped under "פרק N" lines.
function parseKey(pagesText) {
  const blocks = [];
  let cur = null;
  for (const t of pagesText) {
    const lines = [];
    for (const it of t.items) {
      let L = lines.find(l => Math.abs(l.y - it.y) < 2.5);
      if (!L) { L = { y: it.y, items: [] }; lines.push(L); }
      L.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const txt = L.items.map(x => x.s).join(' ');
      if (/פרק/.test(txt) && !/מפתח/.test(txt)) {
        const m = txt.match(/פרק\D*(\d+)/);
        cur = { num: m ? +m[1] : blocks.length + 1, pilot: /פיילוט/.test(txt), domain: /כמותית/.test(txt) ? 'quant' : /מילולית/.test(txt) ? 'verbal' : /אנגלית/.test(txt) ? 'english' : 'other', answers: {} };
        blocks.push(cur);
        continue;
      }
      if (!cur) continue;
      const nums = L.items.filter(x => /^\d+$/.test(x.s));
      if (nums.length < 3) continue;
      const vals = nums.map(x => +x.s);
      const isAnswerRow = vals.every(v => v >= 1 && v <= 4);
      const isNumberRow = !isAnswerRow || (vals.length >= 3 && new Set(vals).size === vals.length && Math.max(...vals) - Math.min(...vals) === vals.length - 1);
      if (isNumberRow && !L.used) {
        // find following answer row (the next numeric line below)
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const A = lines[j];
          const an = A.items.filter(x => /^\d+$/.test(x.s));
          if (an.length >= nums.length * 0.8 && an.every(x => +x.s >= 1 && +x.s <= 4)) {
            for (const n of nums) {
              let best = null, bd = 1e9;
              for (const a of an) { const d = Math.abs(a.x - n.x); if (d < bd) { bd = d; best = a; } }
              if (best && bd < 12) cur.answers[+n.s] = +best.s;
            }
            A.used = true;
            break;
          }
        }
      }
    }
  }
  return blocks.filter(b => Object.keys(b.answers).length > 0).map(b => {
    const n = Math.max(...Object.keys(b.answers).map(Number));
    const arr = []; for (let q = 1; q <= n; q++) arr.push(b.answers[q] || null);
    return { num: b.num, pilot: b.pilot, domain: b.domain, key: arr };
  });
}

// Detect question-number positions on a scanned page.
// Question numbers sit alone in the right gutter, bold, with the period on their left (".12").
function detectQuestions(img, W, H) {
  const ink = new Uint8Array(W * H);
  const d = img.data;
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < 150 ? 1 : 0;
  const y0 = Math.floor(0.065 * H), y1 = Math.floor(0.965 * H);
  const rext = [], rowCount = new Int32Array(H);
  for (let y = y0; y < y1; y++) {
    let last = -1, c = 0;
    for (let x = 0; x < W; x++) if (ink[y * W + x]) { last = x; c++; }
    rowCount[y] = c;
    if (last >= 0) rext.push(last);
  }
  if (!rext.length) return { nums: [], seps: [] };
  rext.sort((a, b) => a - b);
  const R = rext[Math.min(rext.length - 1, Math.floor(rext.length * 0.97))];
  const sx0 = Math.max(0, R - Math.floor(0.08 * W)), sx1 = Math.min(W - 1, R + 2);
  const prof = (y) => { for (let x = sx0; x <= sx1; x++) if (ink[y * W + x]) return true; return false; };

  const seps = [];
  for (let y = y0; y < y1; y++) if (rowCount[y] > 0.5 * W) { if (!seps.length || y - seps[seps.length - 1].e > 2) seps.push({ s: y, e: y }); else seps[seps.length - 1].e = y; }

  const bands = [];
  for (let y = y0; y < y1; y++) {
    if (!prof(y)) continue;
    const s = y; let gap = 0;
    while (y < y1 && (prof(y) || gap < 2)) { gap = prof(y) ? 0 : gap + 1; y++; }
    bands.push([s, y - gap]);
  }
  const nums = [];
  for (const [s, e] of bands) {
    const hh = e - s;
    if (!(hh > 0.007 * H && hh < 0.03 * H)) continue;
    const cols = new Uint8Array(W);
    for (let y = s; y < e; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) cols[x] = 1;
    let x1 = W - 1; while (x1 > 0 && !cols[x1]) x1--;
    let x = x1;
    while (x > 0) {
      let any = false; for (let k = Math.max(0, x - 6); k < x; k++) if (cols[k]) { any = true; break; }
      if (!any) break;
      x--; while (x > 0 && !cols[x]) x--;
    }
    const x0 = x;
    let lx = x0 - 1; while (lx >= 0 && !cols[lx]) lx--;
    const gapL = lx >= 0 ? x0 - lx : 999;
    const cw = x1 - x0 + 1;
    if (!(cw < 0.05 * W && gapL > 0.022 * W && x1 >= R - 0.012 * W)) continue;
    // period test: the leftmost column-cluster only has ink in the lower part
    let a = x0; while (a < x1 && !cols[a]) a++;
    let b = a; while (b < x1 && cols[b + 1]) b++;
    let top = -1;
    for (let y = s; y <= e && top < 0; y++) for (let xx = a; xx <= b; xx++) if (ink[y * W + xx]) { top = y; break; }
    if (top < 0 || (top - s) / (hh + 1) <= 0.4) continue;
    nums.push(s);
  }
  return { nums, seps };
}

async function renderPageCanvas(pageNum, width, doc = pdfDoc) {
  const page = await doc.getPage(pageNum);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

async function analyzeExam(onProgress, doc = pdfDoc) {
  const n = doc.numPages;
  const pages = [];
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const t = await pageText(page);
    pages.push({ n: p, t, c: classify(t) });
  }
  if (pages.some(p => p.c.kind === 'solutions') && !pages.some(p => p.c.kind === 'section' && !p.c.blank && /פרק/.test(p.t.header) && !/פתרונות/.test(p.t.header)))
    throw new Error('נראה שזה קובץ הפתרונות. העלה את קובץ הבחינה עצמו (זה שמתחיל במטלת הכתיבה).');

  const essayPages = pages.filter(p => p.c.kind === 'essay' && !p.c.blank).map(p => p.n);
  const secMap = new Map();
  for (const p of pages) {
    if (p.c.kind !== 'section' || p.c.blank) continue;
    if (!secMap.has(p.c.num)) secMap.set(p.c.num, { num: p.c.num, domain: p.c.domain, pages: [] });
    secMap.get(p.c.num).pages.push(p.n);
  }
  const sections = [...secMap.values()].sort((a, b) => a.num - b.num);
  if (!sections.length) throw new Error('לא זוהו פרקים בקובץ. האתר מכיר את הפורמט שבו בראש כל עמוד כתוב "פרק N - חשיבה ...".');

  const keyBlocks = parseKey(pages.filter(p => p.c.kind === 'key').map(p => p.t));
  const scoringFound = pages.some(p => p.c.kind === 'scoring');

  // question detection
  const totalPages = sections.reduce((a, s) => a + s.pages.length, 0);
  let done = 0;
  for (const s of sections) {
    s.questions = [];
    for (const pn of s.pages) {
      const c = await renderPageCanvas(pn, 827, doc);
      const W = c.width, H = c.height;
      const img = c.getContext('2d').getImageData(0, 0, W, H);
      const { nums, seps } = detectQuestions(img, W, H);
      nums.forEach((ny, i) => {
        const next = i + 1 < nums.length ? nums[i + 1] : Math.floor(0.965 * H);
        const above = seps.filter(sp => sp.e < ny && (i === 0 || sp.s > nums[i - 1]));
        const top = above.length ? above[above.length - 1].e : ny - 0.012 * H;
        const below = seps.filter(sp => sp.s > ny && sp.s < next);
        const bottom = below.length ? below[0].s : next - 0.006 * H;
        s.questions.push({ page: pn, ny: ny / H, top: Math.max(0, top / H), bottom: Math.min(1, bottom / H) });
      });
      onProgress && onProgress(++done / totalPages);
    }
    const kb = keyBlocks.find(k => k.num === s.num);
    s.key = kb ? kb.key : null;
    s.pilot = kb ? kb.pilot : false;
    s.count = s.key ? s.key.length : s.questions.length;
    s.inlineOk = s.questions.length === s.count && s.count > 0;
    s.minutes = DEFAULT_SECTION_MIN;
  }
  const ext = extractTables(pages.map(p => p.t));
  return { essayPages, sections, keyFound: keyBlocks.length > 0, scoringFound, ext };
}

// ---------- scoring ----------
function computeScores(st) {
  const per = st.sections.map((s, i) => {
    const ans = st.answers[i] || {};
    let correct = 0, answered = 0;
    if (s.key) s.key.forEach((k, q) => { const a = ans[q + 1]; if (a) answered++; if (a && a === k) correct++; });
    return { num: s.num, domain: s.domain, pilot: s.pilot, correct, total: s.count, answered, hasKey: !!s.key };
  });
  if (per.some(p => !p.hasKey)) return { per, complete: false };
  const vRaw = per.filter(p => p.domain === 'verbal' && !p.pilot).reduce((a, p) => a + p.correct, 0);
  const qRaw = per.filter(p => p.domain === 'quant' && !p.pilot).reduce((a, p) => a + p.correct, 0);
  return { per, complete: true, ...scoreFromRaw(vRaw, qRaw, tablesFor(st)), table: tableInfo(st) };
}
// which conversion table an exam (state or history entry) uses
function tablesFor(o) { return o.tableSource === 'exam' || o.tableSource === 'manual' ? o.tables : null; }
function tableInfo(o) {
  const src = o.tableSource === 'exam' || o.tableSource === 'manual' ? o.tableSource : 'general';
  const label = src === 'general' ? DEFAULT_LABEL : `טבלת המבחן${o.examLabel ? ' · ' + o.examLabel : ''}${src === 'manual' ? ' (הוזנה ידנית)' : ' (חולצה מהקובץ)'}`;
  return { source: src, label, exam: o.examLabel || null };
}
// recompute a saved report's scores from its per-section correct counts
function rescoreReport(r) {
  const hasKey = r.sections && r.sections.every(s => Number.isFinite(s.correct) && (s.questions || []).every(q => q.correct != null));
  if (!hasKey) return r; // no answer key yet: nothing to score
  const vRaw = r.sections.filter(s => s.domain === 'verbal' && !s.pilot).reduce((a, s) => a + s.correct, 0);
  const qRaw = r.sections.filter(s => s.domain === 'quant' && !s.pilot).reduce((a, s) => a + s.correct, 0);
  const sc = scoreFromRaw(vRaw, qRaw, tablesFor(r));
  r.scores = { vRaw, qRaw, V: sc.V, Q: sc.Q, two: sc.two, verbalEmphasis: sc.verbalW, quantEmphasis: sc.quantW, percentBelow: sc.percentBelow, table: tableInfo(r) };
  return r;
}

// ---------- screens ----------
function render() {
  renderGen++;
  clearInterval(tickTimer); tickTimer = null;
  if (lockedOut) return renderLocked();
  document.body.classList.remove('in-exam');
  if (revisit) return renderRevisit();
  if (historyView) return renderHistoryResults();
  if (homeView && state && state.phase === 'done') return renderHome();
  if (!state || state.phase === 'setup') return state ? renderSetup() : renderHome();
  if (state.phase === 'done') return renderReview();
  if (state.phase === 'entry') return renderEntry();
  if (state.live) return renderLive();
  return renderExam();
}

function renderHome() {
  const hist = history();
  const el = h(`
  <div class="page home">
    <h1>סימולטור פסיכומטרי</h1>
    ${state && state.phase === 'done' ? `<div class="row"><button class="btn small secondary" id="backReview">→ חזרה לתחקור של ${esc(state.exam)}</button></div>` : ''}
    <p class="muted">מעלים את קובץ הסימולציה (PDF). האתר מחלק אותו לפרקים, מציג אותם לפי הסדר עם זמן נעול, ובסוף מנקד לפי מפתח התשובות.</p>
    <label class="drop" id="drop">
      <input type="file" accept="application/pdf" id="file" hidden>
      <div class="drop-title">בחר קובץ בחינה</div>
      <div class="muted small">או גרור לכאן</div>
    </label>
    <div id="progress" class="progress hidden"><div class="bar"></div><div class="small muted label">מעבד את הקובץ…</div></div>
    <div id="err" class="error hidden"></div>
    ${hist.length ? `<h2>סימולציות קודמות</h2>
    <table class="hist"><thead><tr><th>תאריך</th><th>קובץ</th><th>V</th><th>Q</th><th>דו-תחומי</th><th></th></tr></thead><tbody>
    ${hist.map((r, i) => `<tr><td>${new Date(r.finishedAt).toLocaleDateString('he-IL')}</td><td class="fname">${esc(r.exam)}${r.examLabel ? ' · ' + esc(r.examLabel) : ''}${r.paper ? ' <span class="tag">נייר</span>' : ''}${r.live ? ' <span class="tag">מודפס</span>' : ''}${r.scores && (r.tableSource || 'general') === 'general' ? ' <span class="tag warn-tag" title="הציון חושב לפי טבלה כללית">טבלה כללית</span>' : ''}</td><td>${r.scores?.V ?? '—'}</td><td>${r.scores?.Q ?? '—'}</td><td>${r.scores?.two ? rng(r.scores.two.lo, r.scores.two.hi) : '—'}</td><td><button class="link" data-res="${i}">תוצאות</button> <button class="link" data-open="${i}">פתח מבחן</button> <button class="link" data-exp="${i}">ייצוא</button> <button class="link" data-recalc="${i}">טבלת ציון</button> <button class="link danger" data-del="${i}">מחק</button></td></tr>`).join('')}
    </tbody></table>
    <button class="btn secondary" id="expAll">ייצוא כל התחקורים (JSON)</button>` : ''}
    <div class="row"><label class="btn secondary">ייבוא תחקור ישן (JSON)<input type="file" accept="application/json,.json" id="importJson" hidden></label>
    <span class="small muted">מוסיף את התחקור להיסטוריה ומחשב אותו מחדש לפי טבלת המבחן שלו.</span></div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  const br = el.querySelector('#backReview');
  if (br) br.onclick = () => { homeView = false; render(); };
  const input = el.querySelector('#file');
  input.onchange = () => { const f = input.files[0]; input.value = ''; if (f) startUpload(f); };
  const drop = el.querySelector('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) startUpload(f); };
  el.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => { const r = history()[+b.dataset.exp]; download(`tahkir-${r.finishedAt.slice(0, 10)}.json`, JSON.stringify(r, null, 2)); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('למחוק את התחקור הזה מההיסטוריה?')) return;
    const hh = history(); const [gone] = hh.splice(+b.dataset.del, 1); saveHistory(hh);
    if (gone && gone.id && (!state || state.id !== gone.id)) await delPdf(gone.id);
    render();
  });
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openRevisit(history()[+b.dataset.open], 'home'));
  el.querySelectorAll('[data-res]').forEach(b => b.onclick = () => { historyView = { id: history()[+b.dataset.res].id }; render(); });
  el.querySelectorAll('[data-recalc]').forEach(b => b.onclick = () => recalcEntry(history()[+b.dataset.recalc].id));
  const ij = el.querySelector('#importJson');
  ij.onchange = async () => {
    const f = ij.files[0]; ij.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast('הקובץ הזה לא JSON תקין'); return; }
    const list = (Array.isArray(data) ? data : [data]).filter(r => r && Array.isArray(r.sections) && r.sections.length);
    if (!list.length) { toast('לא נמצא בקובץ תחקור של סימולציה'); return; }
    const hh = history();
    let added = 0, lastId = null;
    for (const r of list) {
      const existing = r.id && hh.find(x => x.id === r.id);
      if (existing) { lastId = existing.id; continue; }
      r.id = r.id || ('imp' + Date.now() + '_' + added);
      if (!r.tableSource) r.tableSource = 'general'; // exports from before per-exam tables
      if (!r.finishedAt) r.finishedAt = new Date().toISOString();
      hh.unshift(rescoreReport(r)); added++; lastId = r.id;
    }
    saveHistory(hh);
    render();
    toast(added ? `נוסף${added > 1 ? 'ו ' + added + ' תחקורים' : ' תחקור'} להיסטוריה` : 'התחקור כבר נמצא בהיסטוריה', 3000);
    if (list.length === 1 && lastId) recalcEntry(lastId);
  };
  const ea = el.querySelector('#expAll');
  if (ea) ea.onclick = () => download(`tahkirim-all-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(history(), null, 2));
}

async function startUpload(file) {
  if (busy) return;
  busy = true;
  const prog = document.getElementById('progress'), err = document.getElementById('err');
  err.classList.add('hidden'); prog.classList.remove('hidden');
  const bar = prog.querySelector('.bar');
  try {
    const buf = await file.arrayBuffer();
    try { pdfDoc = await pdfjs.getDocument({ data: buf.slice(0) }).promise; }
    catch (e) { throw new Error(e && e.name === 'PasswordException' ? 'הקובץ מוגן בסיסמה. צריך גרסה בלי סיסמה.' : 'זה לא קובץ PDF תקין.'); }
    const res = await analyzeExam(p => { bar.style.width = Math.round(p * 100) + '%'; });
    const id = 'x' + Date.now();
    await putPdf(id, buf);
    state = {
      id, exam: file.name.replace(/\.pdf$/i, ''), createdAt: new Date().toISOString(),
      essay: { pages: res.essayPages, minutes: DEFAULT_ESSAY_MIN },
      sections: res.sections, keyFound: res.keyFound, scoringFound: res.scoringFound, numPages: pdfDoc.numPages,
      tables: res.ext ? res.ext.tables : null, tableSource: res.ext && res.ext.ok ? 'exam' : 'general',
      examLabel: res.ext ? res.ext.label : null, tableProblems: res.ext ? res.ext.problems : ['בקובץ אין דף "חישוב אומדן ציוני הבחינה"'],
      phase: 'setup', current: null, phaseStart: 0, phaseEnd: 0, warned: false,
      answers: {}, log: [], qtime: {}, phases: [],
    };
    homeView = false;
    save(); render();
  } catch (e) {
    console.error(e);
    prog.classList.add('hidden');
    err.textContent = e.message || 'שגיאה בקריאת הקובץ';
    err.classList.remove('hidden');
    pdfDoc = null;
  } finally {
    busy = false;
  }
}

function renderSetup() {
  const s = state;
  const el = h(`
  <div class="page setup">
    <h1>${esc(s.exam)}</h1>
    <p class="muted">זה מה שזוהה בקובץ. לא מוצג כאן תוכן, כדי שלא תראה שאלות לפני הזמן.</p>
    <table class="setup-table">
      <thead><tr><th>חלק</th><th>שאלות</th><th>זמן (דקות)</th><th>סימון ליד כל שאלה</th></tr></thead>
      <tbody>
        ${s.essay.pages.length ? `<tr><td>מטלת כתיבה</td><td>—</td><td><input type="number" min="1" max="120" value="${s.essay.minutes}" data-essay></td><td>—</td></tr>` : ''}
        ${s.sections.map((x, i) => `<tr><td>פרק ${x.num} · ${domainName(x.domain)}</td><td>${x.count}</td>
        <td><input type="number" min="1" max="120" value="${x.minutes}" data-sec="${i}"></td>
        <td>${x.inlineOk ? '<span class="ok">✓</span>' : `<span class="warn">חלקי (${x.questions.length}/${x.count}) · סימון דרך הסרגל למטה</span>`}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="checks">
      <div>${s.keyFound ? '<span class="ok">✓</span> מפתח תשובות נמצא בקובץ' : '<span class="warn">✗</span> לא נמצא מפתח תשובות. תוכל להעלות אותו בסוף.'}</div>
      <div>${s.tableSource === 'exam' ? `<span class="ok">✓</span> טבלת המעבר של המבחן${s.examLabel ? ' (' + esc(s.examLabel) + ')' : ''} חולצה מהקובץ` : s.tableSource === 'manual' ? '<span class="ok">✓</span> טבלת המעבר הוזנה ידנית' : `<span class="warn">⚠</span> לא הצלחתי לחלץ את טבלת המעבר של המבחן (${esc((s.tableProblems || [])[0] || '')}). הציון יחושב לפי טבלה כללית.`}
        <button class="link" id="editTable">${s.tableSource === 'general' ? 'הזן טבלה' : 'הצג / ערוך טבלה'}</button></div>
    </div>
    <div class="howto">
      <b>איך זה עובד</b>
      <ul>
        <li>הפרקים מוצגים לפי הסדר. שעון לא מוצג. כשנשארות 5 דקות תקפוץ הודעה קטנה.</li>
        <li>כשהזמן נגמר, הפרק ננעל והבא מתחיל אוטומטית. אי אפשר לחזור לפרק קודם.</li>
        <li>מסמנים תשובה בעיגולים שליד כל שאלה או בסרגל שלמטה. לחיצה נוספת על אותה תשובה מוחקת אותה.</li>
        <li>כל השאלות מוצגות באפור. לוחצים על שאלה כדי להתחיל לספור לה זמן, וכשעוברים לשאלה אחרת הקודמת חוזרת לאפור. לחיצה על קטע קריאה סופרת זמן קטע.</li>
        <li>אם סימנת תשובה לשאלה בלי ללחוץ עליה קודם, הזמן מאז הפעולה הקודמת נזקף לה.</li>
      </ul>
    </div>
    <div class="row">
      <button class="btn" id="start">התחל בחינה</button>
      <button class="btn secondary" id="live">מבחן מודפס · טופס תשובות בזמן אמת</button>
      <button class="btn secondary" id="paper">הזן תשובות ממבחן על נייר</button>
      <button class="btn secondary" id="cancel">בטל וחזור</button>
    </div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  el.querySelectorAll('[data-sec]').forEach(inp => inp.onchange = () => { s.sections[+inp.dataset.sec].minutes = Math.max(1, +inp.value || DEFAULT_SECTION_MIN); save(); });
  const ei = el.querySelector('[data-essay]'); if (ei) ei.onchange = () => { s.essay.minutes = Math.max(1, +ei.value || DEFAULT_ESSAY_MIN); save(); };
  el.querySelector('#cancel').onclick = async () => { await delPdf(s.id); state = null; localStorage.removeItem(STATE_KEY); render(); };
  el.querySelector('#editTable').onclick = () => openTableEditor(s, () => { save(); render(); });
  el.querySelector('#live').onclick = () => {
    s.live = true; s.announced = 0; s.entryCursor = { si: 0, q: 1 };
    unlockAudio();
    beginPhase(s.essay.pages.length ? -1 : 0, Date.now());
    render();
  };
  el.querySelector('#paper').onclick = () => { s.paper = true; s.phase = 'entry'; s.entryCursor = { si: 0, q: 1 }; save(); render(); };
  el.querySelector('#start').onclick = () => {
    const first = s.essay.pages.length ? -1 : 0;
    beginPhase(first, Date.now());
    render();
  };
}

function phaseMinutes(idx) { return idx === -1 ? state.essay.minutes : state.sections[idx].minutes; }
function beginPhase(idx, start) {
  state.phase = idx === -1 ? 'essay' : 'section';
  state.current = idx;
  state.phaseStart = start;
  state.phaseEnd = start + phaseMinutes(idx) * 60000;
  state.warned = phaseMinutes(idx) * 60000 <= WARN_MS; // no "5 minutes left" for a phase that short
  state.phases.push({ idx, start, end: null, endedBy: null });
  if (idx >= 0 && !state.qtime[idx]) state.qtime[idx] = {};
  save();
}
function endPhase(at, by) {
  const ph = state.phases[state.phases.length - 1];
  if (ph) { ph.end = at; ph.endedBy = by; }
  const next = state.current + 1;
  if (next >= state.sections.length) {
    state.phase = 'done';
    state.finishedAt = new Date(at).toISOString();
    save();
    archive();
    return false;
  }
  beginPhase(next, at);
  return true;
}
// catch up after a reload / closed tab: time keeps running like a real exam
function catchUp() {
  let moved = 0;
  while ((state.phase === 'essay' || state.phase === 'section') && Date.now() >= state.phaseEnd) {
    moved++;
    if (!endPhase(state.phaseEnd, 'time')) break;
  }
  return moved;
}

// ---------- exam screen ----------
async function renderExam() {
  const skipped = catchUp();
  if (skipped) {
    toast(skipped === 1 ? 'הזמן של הפרק נגמר בזמן שהדף לא היה פתוח. עוברים לבא.' : `${skipped} פרקים נגמרו בזמן שהדף לא היה פתוח.`, 7000);
    render(); return;
  }
  const gen = renderGen;
  document.body.classList.add('in-exam');
  const idx = state.current;
  const isEssay = idx === -1;
  const sec = isEssay ? null : state.sections[idx];
  selectedQ = 1;
  if (!isEssay && (!state.active || state.active.s !== idx)) { state.active = { s: idx, key: 'none' }; state.pend = {}; save(); }
  if (!isEssay && /^\d+$/.test(state.active.key)) selectedQ = +state.active.key;

  const el = h(`
  <div class="exam">
    <div class="booklet" id="booklet"></div>
    <div class="answerbar" id="answerbar"></div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  const booklet = el.querySelector('#booklet');
  const bar = el.querySelector('#answerbar');

  const pages = isEssay ? state.essay.pages : sec.pages;
  const narrow = window.innerWidth <= 760; // side column with bubbles is hidden on phones
  const width = Math.max(280, Math.min(900, booklet.clientWidth - (isEssay || narrow ? 12 : 170)));
  const pageEls = {};
  for (const pn of pages) {
    const wrap = h(`<div class="pagewrap"><div class="side"></div><div class="pagebox" data-page="${pn}"><div class="loading">טוען…</div></div></div>`);
    wrap.querySelector('.pagebox').style.width = width + 'px';
    if (isEssay) wrap.querySelector('.side').remove();
    booklet.appendChild(wrap);
    pageEls[pn] = wrap;
  }
  // render pages
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  (async () => {
    for (const pn of pages) {
      const c = await renderPageCanvas(pn, Math.round(width * dpr));
      if (gen !== renderGen) return; // screen changed while rendering
      c.style.width = width + 'px';
      const box = pageEls[pn].querySelector('.pagebox');
      box.innerHTML = ''; box.appendChild(c);
      if (!isEssay) placeInline(sec, pn, pageEls[pn], c);
    }
    // after a reload, return to the question that was active
    if (!isEssay && sec.inlineOk && /^\d+$/.test(activeKey())) selectQ(+activeKey(), true);
  })();

  if (isEssay) {
    bar.innerHTML = `<div class="bar-title">מטלת כתיבה · כתוב במחברת</div><div class="spacer"></div><button class="btn small" id="finish">סיימתי, לפרק הבא</button>`;
  } else {
    drawBar(bar, sec, idx);
  }
  bar.querySelector('#finish').onclick = () => {
    if (!confirm(isEssay ? 'לעבור לפרק הראשון? לא תוכל לחזור למטלת הכתיבה.' : 'לסיים את הפרק? לא תוכל לחזור אליו.')) return;
    if (gen !== renderGen || state.phase === 'done') return; // the phase already ended while the dialog was open
    const now = Date.now();
    if (now >= state.phaseEnd) endPhase(state.phaseEnd, 'time'); else endPhase(now, 'user');
    render();
  };

  // ticking: time accounting + warnings + auto advance
  lastTick = Date.now();
  state.owner = TAB_ID; save(); // claim the exam: another open tab sees this write and steps aside
  tickTimer = setInterval(() => tick(booklet), 500);
  window.onresize = null;
}

function placeInline(sec, pn, wrap, canvas) {
  if (!sec.inlineOk) return;
  const side = wrap.querySelector('.side');
  const hpx = parseFloat(canvas.style.width) * canvas.height / canvas.width;
  side.style.height = hpx + 'px';
  const box = wrap.querySelector('.pagebox');
  sec.questions.forEach((q, i) => {
    if (q.page !== pn) return;
    const qn = i + 1;
    const shade = h(`<div class="qshade" data-q="${qn}"></div>`);
    shade.style.top = (q.top * 100) + '%';
    shade.style.height = ((q.bottom - q.top) * 100) + '%';
    box.appendChild(shade);
    const g = h(`<div class="bubbles" data-q="${qn}"><span class="qn">${qn}</span>${[1, 2, 3, 4].map(a => `<button data-a="${a}">${a}</button>`).join('')}</div>`);
    g.style.top = (q.ny * hpx - 6) + 'px';
    g.querySelectorAll('button').forEach(b => b.onclick = () => setAnswer(qn, +b.dataset.a));
    side.appendChild(g);
  });
  // a click anywhere on the page activates the question under it (or the passage/instructions)
  box.onclick = (e) => {
    const r = box.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const i = sec.questions.findIndex(q => q.page === pn && y >= q.top && y <= q.bottom);
    activate(i >= 0 ? String(i + 1) : 'passage');
  };
  refreshMarks();
}

// Only one thing is "active" at a time; its time runs. pend = time since the last activation/answer.
function activate(key) {
  const idx = state.current;
  if (state.phase !== 'section') return;
  if (/^\d+$/.test(key)) selectedQ = +key;
  if (state.active && state.active.s === idx && state.active.key === key) { refreshMarks(); return; }
  state.active = { s: idx, key };
  state.pend = {};
  state.log.push({ t: Date.now(), s: idx, type: 'activate', key });
  save();
  refreshMarks();
}

function drawBar(bar, sec, idx) {
  bar.innerHTML = `
    <div class="bar-title">פרק ${sec.num}</div>
    <div class="grid">${Array.from({ length: sec.count }, (_, i) => `<button class="cell" data-q="${i + 1}"><span class="n">${i + 1}</span><span class="a"></span></button>`).join('')}</div>
    <div class="current"><span class="cur-label"></span>${[1, 2, 3, 4].map(a => `<button class="ans" data-a="${a}">${a}</button>`).join('')}</div>
    <button class="btn small" id="finish">סיום פרק</button>`;
  bar.querySelectorAll('.cell').forEach(c => c.onclick = () => { selectQ(+c.dataset.q, true); activate(c.dataset.q); });
  bar.querySelectorAll('.ans').forEach(b => b.onclick = () => setAnswer(selectedQ, +b.dataset.a));
  refreshMarks();
}

function selectQ(q, scroll) {
  selectedQ = q;
  const sec = state.sections[state.current];
  if (scroll && sec.inlineOk) {
    const qq = sec.questions[q - 1];
    const box = document.querySelector(`.pagebox[data-page="${qq.page}"]`);
    const booklet = document.getElementById('booklet');
    if (box) {
      const target = box.offsetTop + qq.top * box.offsetHeight - booklet.clientHeight * SCROLL_TO;
      booklet.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
  refreshMarks();
}

function setAnswer(q, a) {
  const idx = state.current;
  if (state.phase !== 'section' || q < 1) return;
  const ans = state.answers[idx] || (state.answers[idx] = {});
  const prev = ans[q] || null;
  const next = prev === a ? null : a;
  if (next) ans[q] = next; else delete ans[q];
  const now = Date.now();
  const key = String(q);
  // answered without clicking the question first: the time since the last activation/answer belongs to it
  if (next && (!state.active || state.active.s !== idx || state.active.key !== key)) {
    const qt = state.qtime[idx] || (state.qtime[idx] = {});
    let moved = 0;
    for (const [k, ms] of Object.entries(state.pend || {})) {
      if (k === 'passage') continue; // reading a passage you clicked on stays passage time
      qt[k] = Math.max(0, (qt[k] || 0) - ms); moved += ms;
    }
    qt[key] = (qt[key] || 0) + moved;
    state.log.push({ t: now, s: idx, type: 'auto', key, ms: moved });
    state.active = { s: idx, key };
  }
  state.pend = {};
  state.log.push({ t: now, s: idx, q, a: next, prev });
  selectedQ = q;
  save();
  refreshMarks();
}

function refreshMarks() {
  if (state.phase !== 'section') return;
  const idx = state.current;
  const ans = state.answers[idx] || {};
  document.querySelectorAll('.bubbles').forEach(g => {
    const q = +g.dataset.q;
    g.querySelectorAll('button').forEach(b => b.classList.toggle('on', ans[q] === +b.dataset.a));
    g.classList.toggle('active', activeKey() === String(q));
  });
  document.querySelectorAll('.qshade').forEach(sh => sh.classList.toggle('on', activeKey() === sh.dataset.q));
  document.querySelectorAll('.answerbar .cell').forEach(c => {
    const q = +c.dataset.q;
    c.querySelector('.a').textContent = ans[q] || '';
    c.classList.toggle('done', !!ans[q]);
    c.classList.toggle('sel', q === selectedQ);
  });
  const lab = document.querySelector('.answerbar .cur-label');
  if (lab) lab.textContent = `שאלה ${selectedQ}:`;
  document.querySelectorAll('.answerbar .ans').forEach(b => b.classList.toggle('on', ans[selectedQ] === +b.dataset.a));
}

function activeKey() {
  return state.active && state.active.s === state.current ? state.active.key : 'none';
}

function tick(booklet) {
  if (lockedOut) return;
  const now = Date.now();
  // count only time inside the phase; cap long gaps (laptop asleep) at a minute
  const d = Math.max(0, Math.min(now, state.phaseEnd) - lastTick);
  lastTick = now;
  if (state.phase === 'section' && d > 0 && !state.live) {
    const idx = state.current;
    const key = activeKey();
    const dd = Math.min(d, 65000);
    const qt = state.qtime[idx] || (state.qtime[idx] = {});
    qt[key] = (qt[key] || 0) + dd;
    const pend = state.pend || (state.pend = {});
    pend[key] = (pend[key] || 0) + dd;
  }
  if (!state.warned && state.phaseEnd - now <= WARN_MS && state.phaseEnd - now > 0) {
    state.warned = true; save();
    toast('נותרו 5 דקות', 8000);
    if (state.live) { beep('warn'); speak('נותרו חמש דקות'); }
  }
  if (state.live) updateClock();
  if (now >= state.phaseEnd) {
    const wasEssay = state.phase === 'essay';
    endPhase(state.phaseEnd, 'time');
    if (state.phase !== 'done' && !state.live) toast(wasEssay ? 'הזמן למטלת הכתיבה נגמר. עוברים לפרק הבא.' : 'הזמן נגמר. הפרק ננעל ועוברים לפרק הבא.', 5000);
    if (state.phase === 'done' && state.live) { beep('end'); speak('הבחינה הסתיימה'); }
    render();
    return;
  }
  if (now % 5000 < 600) save();
}

// ---------- printed exam, answer sheet filled in real time ----------
let audioCtx = null, wakeLock = null;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
  try { speechSynthesis.getVoices(); } catch {}
}
function beep(kind) {
  if (!audioCtx) return;
  try {
    audioCtx.resume();
    const tones = kind === 'section' ? [[880, 0], [880, 0.28], [1175, 0.56]] : kind === 'end' ? [[1175, 0], [880, 0.3], [660, 0.6]] : [[660, 0], [660, 0.25]];
    for (const [f, t] of tones) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      const t0 = audioCtx.currentTime + t;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.25);
    }
  } catch {}
}
function speak(text) {
  try {
    const voices = speechSynthesis.getVoices();
    const he = voices.find(v => /^he|^iw/i.test(v.lang));
    if (!he) return; // no Hebrew voice on this device: beep + flash only
    const u = new SpeechSynthesisUtterance(text); u.lang = he.lang; u.voice = he;
    setTimeout(() => speechSynthesis.speak(u), 900); // after the beep
  } catch {}
}
async function keepAwake() {
  try { if ('wakeLock' in navigator && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state && state.live && (state.phase === 'essay' || state.phase === 'section')) keepAwake(); });
function flash(title, sub) {
  const f = h(`<div class="flash"><div class="flash-title">${esc(title)}</div>${sub ? `<div class="flash-sub">${esc(sub)}</div>` : ''}</div>`);
  document.body.appendChild(f);
  f.onclick = () => f.remove();
  setTimeout(() => f.remove(), 4500);
}
function phaseTitle(idx) { return idx === -1 ? 'מטלת כתיבה' : `פרק ${state.sections[idx].num} · ${domainName(state.sections[idx].domain)}`; }
function updateClock() {
  const c = document.getElementById('liveClock');
  if (c) c.textContent = fmt(Math.max(0, state.phaseEnd - Date.now()));
}

function renderLive() {
  const skipped = catchUp();
  if (state.phase === 'done') { render(); return; }
  const st = state;
  document.body.classList.remove('in-exam');
  const idx = st.current;
  // announce a phase once (not again after a reload)
  if ((st.announced || 0) < st.phases.length) {
    st.announced = st.phases.length;
    st.lastMarkAt = st.phaseStart;
    if (idx >= 0) st.entryCursor = { si: idx, q: 1 };
    save();
    const title = idx === -1 ? 'מטלת כתיבה' : `פרק ${st.sections[idx].num} התחיל`;
    const sub = idx === -1 ? `${st.essay.minutes} דקות` : `${domainName(st.sections[idx].domain)} · ${st.sections[idx].minutes} דקות`;
    flash(title, sub); beep('section');
    speak(idx === -1 ? 'מטלת הכתיבה התחילה' : `פרק ${st.sections[idx].num} התחיל, ${domainName(st.sections[idx].domain)}`);
  }
  if (skipped) toast(`${skipped} פרקים נגמרו בזמן שהדף לא היה פתוח.`, 7000);
  keepAwake();
  const cur = st.entryCursor || (st.entryCursor = { si: Math.max(0, idx), q: 1 });
  const el = h(`<div class="page entry live">
    <div class="livebar">
      <div><div class="live-phase">${esc(phaseTitle(idx))}</div>
      <div class="small muted">${idx === -1 ? 'כותבים במחברת. אפשר כבר לסמן בגיליון אם צריך.' : 'מסמנים כל תשובה ברגע שעונים עליה. הזמן לשאלה נמדד מהסימון הקודם.'}</div></div>
      <div class="spacer"></div>
      <span id="liveClock" class="live-clock ${st.showClock ? '' : 'hidden'}"></span>
      <button class="link" id="clockBtn">${st.showClock ? 'הסתר שעון' : 'הצג שעון'}</button>
      <button class="btn small" id="finish">${idx === -1 ? 'סיימתי, לפרק הראשון' : idx === st.sections.length - 1 ? 'סיום הבחינה' : 'סיום פרק'}</button>
    </div>
    ${st.sections.map((s, si) => `<section class="entry-sec ${si === idx ? 'now' : ''}">
      <h2>פרק ${s.num} · ${domainName(s.domain)} ${si === idx ? '<span class="tag now-tag">עכשיו</span>' : ''} <span class="muted small" data-cnt="${si}"></span></h2>
      <div class="sheet" style="--rows:${Math.ceil(s.count / 4)}">${Array.from({ length: s.count }, (_, k) => `<div class="srow" data-si="${si}" data-q="${k + 1}"><span class="sn">${k + 1}</span>${[1, 2, 3, 4].map(a => `<button data-a="${a}">${a}</button>`).join('')}</div>`).join('')}</div>
    </section>`).join('')}
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  updateClock();

  const refresh = (scroll) => {
    st.sections.forEach((s, si) => { el.querySelector(`[data-cnt="${si}"]`).textContent = `${Object.keys(st.answers[si] || {}).length}/${s.count}`; });
    el.querySelectorAll('.srow').forEach(r => {
      const si = +r.dataset.si, q = +r.dataset.q, a = (st.answers[si] || {})[q];
      r.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.a === a));
      const isCur = si === cur.si && q === cur.q;
      r.classList.toggle('cur', isCur);
      if (isCur && scroll) r.scrollIntoView({ block: 'nearest' });
    });
  };
  const mark = (si, q, a) => {
    const ans = st.answers[si] || (st.answers[si] = {});
    const prev = ans[q] || null;
    const now = Date.now();
    if (a) {
      ans[q] = a;
      // time for this answer = time since the previous mark (or since the phase started)
      const since = Math.max(0, Math.min(now - (st.lastMarkAt || st.phaseStart), 30 * 60000));
      const qt = st.qtime[si] || (st.qtime[si] = {});
      qt[q] = (qt[q] || 0) + since;
      st.lastMarkAt = now;
    } else delete ans[q];
    st.log.push({ t: now, s: si, q, a: a || null, prev });
    save();
  };
  const move = (d) => {
    let { si, q } = cur; q += d;
    if (q > st.sections[si].count) { if (si + 1 < st.sections.length) { si++; q = 1; } else q = st.sections[si].count; }
    if (q < 1) { if (si > 0) { si--; q = st.sections[si].count; } else q = 1; }
    cur.si = si; cur.q = q; save();
  };
  el.querySelectorAll('.srow').forEach(r => r.onclick = (e) => {
    const si = +r.dataset.si, q = +r.dataset.q;
    cur.si = si; cur.q = q;
    const b = e.target.closest('button');
    if (b) { const a = +b.dataset.a; mark(si, q, (st.answers[si] || {})[q] === a ? null : a); move(1); }
    save(); refresh(false);
  });
  document.onkeydown = (e) => {
    if (state !== st || !st.live || !(st.phase === 'essay' || st.phase === 'section')) { document.onkeydown = null; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (/^[1-4]$/.test(k)) { mark(cur.si, cur.q, +k); move(1); }
    else if (k === '0' || k === ' ') { mark(cur.si, cur.q, null); move(1); }
    else if (k === 'Backspace') { move(-1); mark(cur.si, cur.q, null); }
    else if (k === 'ArrowLeft' || k === 'ArrowDown') move(1);
    else if (k === 'ArrowRight' || k === 'ArrowUp') move(-1);
    else return;
    e.preventDefault(); refresh(true);
  };
  el.querySelector('#clockBtn').onclick = () => { st.showClock = !st.showClock; save(); render(); };
  const gen = renderGen;
  el.querySelector('#finish').onclick = () => {
    unlockAudio();
    if (!confirm(idx === -1 ? 'לעבור לפרק הראשון?' : idx === st.sections.length - 1 ? 'לסיים את הבחינה?' : 'לסיים את הפרק ולעבור לבא?')) return;
    if (gen !== renderGen || state.phase === 'done') return;
    const now = Date.now();
    if (now >= st.phaseEnd) endPhase(st.phaseEnd, 'time'); else endPhase(now, 'user');
    if (st.phase === 'done') { document.onkeydown = null; beep('end'); }
    render();
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  lastTick = Date.now();
  st.owner = TAB_ID; save();
  tickTimer = setInterval(() => tick(null), 500);
  refresh(true);
}

// ---------- answers from a paper exam ----------
function renderEntry() {
  const st = state;
  const cur = st.entryCursor || (st.entryCursor = { si: 0, q: 1 });
  const el = h(`<div class="page entry">
    <h1>הזנת תשובות · ${esc(st.exam)}</h1>
    <p class="muted">לוחצים על העיגולים, או מקלידים: <b>1–4</b> מסמן ומתקדם לשאלה הבאה, <b>0</b> או <b>רווח</b> = ללא תשובה, <b>Backspace</b> חוזר אחורה ומוחק. החצים זזים בין שאלות.</p>
    ${st.sections.map((s, si) => `<section class="entry-sec">
      <h2>פרק ${s.num} · ${domainName(s.domain)} <span class="muted small" data-cnt="${si}"></span></h2>
      <div class="sheet" style="--rows:${Math.ceil(s.count / 4)}">${Array.from({ length: s.count }, (_, k) => `<div class="srow" data-si="${si}" data-q="${k + 1}"><span class="sn">${k + 1}</span>${[1, 2, 3, 4].map(a => `<button data-a="${a}">${a}</button>`).join('')}</div>`).join('')}</div>
    </section>`).join('')}
    <div class="row entry-actions">
      <button class="btn" id="check">בדוק</button>
      <button class="btn secondary" id="back">${st.finishedAt ? 'ביטול' : 'חזרה'}</button>
    </div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);

  const refresh = (scroll) => {
    st.sections.forEach((s, si) => {
      const ans = st.answers[si] || {};
      const n = Object.keys(ans).length;
      el.querySelector(`[data-cnt="${si}"]`).textContent = `${n}/${s.count}`;
    });
    el.querySelectorAll('.srow').forEach(r => {
      const si = +r.dataset.si, q = +r.dataset.q, a = (st.answers[si] || {})[q];
      r.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.a === a));
      const isCur = si === cur.si && q === cur.q;
      r.classList.toggle('cur', isCur);
      if (isCur && scroll) r.scrollIntoView({ block: 'nearest' });
    });
  };
  const setA = (si, q, a) => {
    const ans = st.answers[si] || (st.answers[si] = {});
    if (a) ans[q] = a; else delete ans[q];
    save();
  };
  const move = (d) => {
    let { si, q } = cur; q += d;
    if (q > st.sections[si].count) { if (si + 1 < st.sections.length) { si++; q = 1; } else q = st.sections[si].count; }
    if (q < 1) { if (si > 0) { si--; q = st.sections[si].count; } else q = 1; }
    cur.si = si; cur.q = q; save();
  };
  el.querySelectorAll('.srow').forEach(r => {
    r.onclick = (e) => {
      const si = +r.dataset.si, q = +r.dataset.q;
      cur.si = si; cur.q = q;
      const b = e.target.closest('button');
      if (b) { const a = +b.dataset.a; setA(si, q, (st.answers[si] || {})[q] === a ? null : a); move(1); }
      save(); refresh(false);
    };
  });
  document.onkeydown = (e) => {
    if (state !== st || st.phase !== 'entry') { document.onkeydown = null; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (/^[1-4]$/.test(k)) { setA(cur.si, cur.q, +k); move(1); }
    else if (k === '0' || k === ' ') { setA(cur.si, cur.q, null); move(1); }
    else if (k === 'Backspace') { move(-1); setA(cur.si, cur.q, null); }
    else if (k === 'ArrowLeft' || k === 'ArrowDown') move(1);
    else if (k === 'ArrowRight' || k === 'ArrowUp') move(-1);
    else return;
    e.preventDefault();
    refresh(true);
  };
  el.querySelector('#back').onclick = () => {
    document.onkeydown = null;
    if (st.finishedAt) { st.phase = 'done'; save(); archive(); }
    else { st.phase = 'setup'; st.paper = false; save(); }
    render();
  };
  el.querySelector('#check').onclick = () => {
    const missing = st.sections.reduce((a, s, si) => a + s.count - Object.keys(st.answers[si] || {}).length, 0);
    if (missing && !confirm(`יש ${missing} שאלות בלי תשובה. לבדוק בכל זאת?`)) return;
    document.onkeydown = null;
    st.phase = 'done';
    if (!st.finishedAt) st.finishedAt = new Date().toISOString();
    save(); archive(); render();
  };
  refresh(true);
}

// ---------- results / review ----------
function buildReport(st) {
  const scores = computeScores(st);
  const sections = st.sections.map((s, i) => {
    const ans = st.answers[i] || {};
    const qt = st.qtime[i] || {};
    const ph = st.phases.find(p => p.idx === i);
    const evs = st.log.filter(e => e.s === i && e.q);
    const qs = Array.from({ length: s.count }, (_, k) => {
      const q = k + 1;
      const my = evs.filter(e => e.q === q);
      const correct = s.key ? s.key[k] : null;
      return {
        q, answer: ans[q] || null, correct, isCorrect: s.key ? (ans[q] || null) === correct : null,
        timeSec: st.paper ? null : Math.round((qt[q] || 0) / 1000),
        changes: Math.max(0, my.length - 1),
        firstAnswerSec: my.length && ph && my[0].t >= ph.start ? Math.round((my[0].t - ph.start) / 1000) : null,
        lastAnswerSec: my.length && ph && my[my.length - 1].t >= ph.start ? Math.round((my[my.length - 1].t - ph.start) / 1000) : null,
        autoAssignedSec: Math.round(st.log.filter(e => e.s === i && e.type === 'auto' && e.key === String(q)).reduce((a, e) => a + e.ms, 0) / 1000),
      };
    });
    return {
      num: s.num, domain: s.domain, pilot: s.pilot, minutes: s.minutes,
      timeUsedSec: ph && ph.end ? Math.round((ph.end - ph.start) / 1000) : null,
      endedBy: ph ? ph.endedBy : null,
      passageTimeSec: Math.round((qt.passage || 0) / 1000),
      unassignedTimeSec: Math.round(((qt.none || 0) + (qt.other || 0)) / 1000),
      timeMeasured: st.live ? 'by-mark' : 'by-click',
      correct: scores.per[i].correct, total: s.count, answered: scores.per[i].answered,
      questions: qs,
    };
  });
  const essayPh = st.phases.find(p => p.idx === -1);
  return {
    exam: st.exam, paper: !!st.paper, live: !!st.live, startedAt: st.phases[0] ? new Date(st.phases[0].start).toISOString() : null, finishedAt: st.finishedAt,
    essay: essayPh ? { minutes: st.essay.minutes, timeUsedSec: essayPh.end ? Math.round((essayPh.end - essayPh.start) / 1000) : null } : null,
    scores: scores.complete ? { vRaw: scores.vRaw, qRaw: scores.qRaw, V: scores.V, Q: scores.Q, two: scores.two, verbalEmphasis: scores.verbalW, quantEmphasis: scores.quantW, percentBelow: scores.percentBelow, table: scores.table } : null,
    examLabel: st.examLabel || null, tableSource: tableInfo(st).source, tables: tablesFor(st),
    sections,
    notes: 'timeSec = זמן שהשאלה הייתה פעילה (נלחצה). autoAssignedSec = זמן שנזקף לשאלה כי סומנה בלי שנלחצה קודם. passageTimeSec = זמן על קטעי קריאה/הוראות. unassignedTimeSec = זמן בלי שאלה פעילה. פרק פיילוט לא נכלל בציון.',
  };
}

function archive() {
  const rep = buildReport(state);
  const hh = history();
  const i = hh.findIndex(r => r.id === state.id);
  rep.id = state.id;
  rep.numPages = state.numPages || (pdfDoc ? pdfDoc.numPages : null);
  rep.layout = layoutOf(state.sections);
  if (i >= 0) hh[i] = rep; else hh.unshift(rep);
  saveHistory(hh);
}

function toCSV(rep) {
  const rows = [['פרק', 'תחום', 'פיילוט', 'שאלה', 'תשובה שלי', 'נכונה', 'צדקתי', 'זמן (שנ׳)', 'שינויים']];
  rep.sections.forEach(s => s.questions.forEach(q => rows.push([s.num, domainName(s.domain), s.pilot ? 'כן' : '', q.q, q.answer ?? '', q.correct ?? '', q.isCorrect == null ? '' : q.isCorrect ? '✓' : '✗', q.timeSec ?? '', q.changes])));
  return '﻿' + rows.map(r => r.join(',')).join('\n');
}

function scoreBlock(sc, sections) {
  return `
    <div class="scorecards">
      <div class="card"><div class="lbl">חשיבה מילולית</div><div class="big">${sc.V}</div><div class="small muted">${sc.vRaw} נכונות (גלם)</div></div>
      <div class="card"><div class="lbl">חשיבה כמותית</div><div class="big">${sc.Q}</div><div class="small muted">${sc.qRaw} נכונות (גלם)</div></div>
      <div class="card main"><div class="lbl">אומדן דו-תחומי</div><div class="big">${rng(sc.two.lo, sc.two.hi)}</div><div class="small muted">משוקלל ${sc.two.weighted} · אמצע הטווח ${sc.two.mid} · כ-${sc.percentBelow}% מהנבחנים מתחת לטווח</div></div>
    </div>
    ${sc.table.source === 'general'
      ? `<div class="warnbox"><b>⚠ ציון משוער לפי טבלה כללית.</b> החישוב נעשה לפי ${DEFAULT_LABEL} ולא לפי טבלת המעבר של המבחן הזה. לכל מועד יש טבלה משלו, אז הציון יכול לסטות בכמה נקודות. <button class="link" id="editTable">הזן את טבלת המבחן</button></div>`
      : `<div class="small muted tablesrc">חושב לפי: <b>${esc(sc.table.label)}</b> · <button class="link" id="editTable">הצג / ערוך טבלה</button></div>`}
    ${(() => { const cnt = (d) => sections.filter(x => x.domain === d && !x.pilot).length; return cnt('verbal') !== 2 || cnt('quant') !== 2 ? `<div class="warnbox">הציון מחושב לפי 2 פרקים מילוליים ו-2 כמותיים. כרגע נספרים ${cnt('verbal')} מילוליים ו-${cnt('quant')} כמותיים. סמן את פרק הפיילוט ליד שם הפרק.</div>` : ''; })()}
    <div class="small muted">דגש מילולי: ${rng(sc.verbalW.lo, sc.verbalW.hi)} · דגש כמותי: ${rng(sc.quantW.lo, sc.quantW.hi)}. האומדן מניח שהציון במטלת הכתיבה ברמה של החשיבה המילולית, כמו בהסבר שבקובץ הבחינה.</div>`;
}

function sectionsBlock(rep, paper, inline) {
  let out = '';
  rep.sections.forEach((s, i) => {
    const times = s.questions.map(q => q.timeSec || 0);
    const answeredQs = s.questions.filter(q => q.isCorrect != null);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const avgOk = avg(answeredQs.filter(q => q.isCorrect).map(q => q.timeSec));
    const avgBad = avg(answeredQs.filter(q => !q.isCorrect && q.answer).map(q => q.timeSec));
    const maxT = Math.max(1, ...times);
    const slow = [...s.questions].sort((a, b) => b.timeSec - a.timeSec).slice(0, 3).map(q => q.q);
    out += `
    <section class="sec-review">
      <h2>פרק ${s.num} · ${domainName(s.domain)} ${s.pilot ? '<span class="tag">פיילוט · לא נכלל בציון</span>' : ''}
        <label class="pilot-toggle"><input type="checkbox" data-pilot="${i}" ${s.pilot ? 'checked' : ''}> פרק פיילוט</label></h2>
      <div class="sec-summary">
        <span><b>${s.correct}/${s.total}</b> נכונות</span>
        <span>ללא תשובה: <b>${s.total - s.answered}</b></span>
        ${paper ? '' : `<span>זמן בפועל: <b>${s.timeUsedSec != null ? fmt(s.timeUsedSec * 1000) : '—'}</b> מתוך ${s.minutes}:00 ${s.endedBy === 'user' ? '(סיימת מוקדם)' : ''}</span>
        <span>ממוצע לשאלה נכונה: <b>${fmt(avgOk * 1000)}</b> · לשאלה שגויה: <b>${fmt(avgBad * 1000)}</b></span>`}
        ${s.passageTimeSec > 5 ? `<span>קטעי קריאה/הוראות: <b>${fmt(s.passageTimeSec * 1000)}</b></span>` : ''}
        ${s.unassignedTimeSec > 5 ? `<span>לא משויך: <b>${fmt(s.unassignedTimeSec * 1000)}</b></span>` : ''}
        ${maxT >= 5 ? `<span>האיטיות ביותר: <b>${slow.join(', ')}</b></span>` : ''}
      </div>
      <table class="qtable"><thead><tr><th>#</th><th>שלי</th><th>נכונה</th><th></th>${paper ? '' : '<th>זמן</th><th class="barcol"></th><th>שינויים</th>'}</tr></thead><tbody>
      ${s.questions.map(q => `<tr class="${q.isCorrect == null ? '' : !q.answer ? 'blank' : q.isCorrect ? 'right' : 'wrong'}" data-s="${i}" data-q="${q.q}">
        <td>${q.q}</td><td>${q.answer ?? '—'}</td><td>${q.correct ?? '?'}</td><td>${q.isCorrect == null ? '' : !q.answer ? 'ללא' : q.isCorrect ? '✓' : '✗'}</td>
        ${paper ? '' : `<td>${fmt(q.timeSec * 1000)}${q.autoAssignedSec ? '<span class="auto" title="נזקף אוטומטית: סומנה בלי לחיצה">*</span>' : ''}</td><td class="barcol"><div class="tbar" style="width:${Math.round(100 * q.timeSec / maxT)}%"></div></td><td>${q.changes || ''}</td>`}</tr>`).join('')}
      </tbody></table>
      <div class="small muted">${inline[i] ? 'לחץ על שורה כדי לראות את השאלה. ' : ''}${paper ? '' : '* = זמן שנזקף לשאלה כי סומנה בלי שנלחצה קודם.'}</div>
    </section>`;
  });
  return out;
}

function renderReview() {
  const st = state;
  const rep = buildReport(st);
  const sc = computeScores(st);
  const el = h(`<div class="page review"></div>`);
  let html = `<h1>תחקור · ${esc(st.exam)}</h1>`;
  if (sc.complete) {
    html += scoreBlock(sc, st.sections);
  } else {
    html += `<div class="keybox"><b>חסר מפתח תשובות.</b> העלה את הקובץ עם המפתח, או הקלד אותו ידנית.
      <div class="row"><label class="btn secondary">העלאת PDF עם מפתח<input type="file" accept="application/pdf" id="keyfile" hidden></label></div>
      ${st.sections.map((s, i) => s.key ? '' : `<div class="manual">פרק ${s.num} (${s.count} שאלות): <input data-mk="${i}" placeholder="למשל 4312214..." dir="ltr"></div>`).join('')}
      <button class="btn" id="mkSave">שמור מפתח</button></div>`;
  }
  html += `<div class="row exports">
      <button class="btn" id="openRev">פתח את המבחן לחזרה</button>
      ${st.paper ? '<button class="btn secondary" id="editAns">ערוך תשובות</button>' : ''}
      <button class="btn secondary" id="expJson">ייצוא תחקור (JSON)</button>
      <button class="btn secondary" id="expCsv">ייצוא לטבלה (CSV)</button>
      <button class="btn secondary" id="copy">העתק סיכום</button>
      <button class="btn secondary" id="newExam">סימולציה חדשה</button>
      <button class="btn secondary" id="goHome">היסטוריה</button>
    </div>`;
  const paper = !!st.paper;
  html += sectionsBlock(rep, paper, st.sections.map(x => x.inlineOk));
  el.innerHTML = html;
  $app.innerHTML = ''; $app.appendChild(el);

  el.querySelector('#expJson').onclick = () => download(`tahkir-${safeName(st.exam)}-${(st.finishedAt || '').slice(0, 10)}.json`, JSON.stringify(rep, null, 2));
  el.querySelector('#expCsv').onclick = () => download(`tahkir-${(st.finishedAt || '').slice(0, 10)}.csv`, toCSV(rep), 'text/csv');
  el.querySelector('#copy').onclick = () => copySummary(rep, sc.complete ? sc : null);
  el.querySelector('#newExam').onclick = async () => {
    if (!confirm('להתחיל סימולציה חדשה? התחקור הזה כבר שמור בהיסטוריה.')) return;
    state = null; localStorage.removeItem(STATE_KEY); pdfDoc = null; render(); // the PDF stays saved, for reopening from history
  };
  el.querySelector('#goHome').onclick = () => { homeView = true; render(); };
  const et = el.querySelector('#editTable');
  if (et) et.onclick = () => openTableEditor(st, () => { save(); archive(); render(); });
  const ea = el.querySelector('#editAns');
  if (ea) ea.onclick = () => { st.phase = 'entry'; st.entryCursor = { si: 0, q: 1 }; save(); render(); };
  el.querySelector('#openRev').onclick = () => { archive(); openRevisit(history().find(r => r.id === st.id), 'review'); };
  el.querySelectorAll('[data-pilot]').forEach(cb => cb.onchange = () => { st.sections[+cb.dataset.pilot].pilot = cb.checked; save(); archive(); render(); });
  el.querySelectorAll('.qtable tr[data-q]').forEach(tr => tr.onclick = () => showQuestion(+tr.dataset.s, +tr.dataset.q));

  const kf = el.querySelector('#keyfile');
  if (kf) kf.onchange = async () => {
    try {
      const buf = await kf.files[0].arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      const texts = [];
      for (let p = 1; p <= doc.numPages; p++) { const t = await pageText(await doc.getPage(p)); if (/מפתח תשובות/.test(t.header + ' ' + t.body)) texts.push(t); }
      const blocks = parseKey(texts);
      if (!blocks.length) { toast('לא נמצא מפתח תשובות בקובץ הזה'); return; }
      st.sections.forEach(s => { const b = blocks.find(k => k.num === s.num); if (b) { s.key = b.key; s.pilot = b.pilot; s.count = b.key.length; s.inlineOk = s.inlineOk && s.questions.length === s.count; } });
      save(); archive(); render();
    } catch (e) { toast('שגיאה בקריאת הקובץ'); }
  };
  const mk = el.querySelector('#mkSave');
  if (mk) mk.onclick = () => {
    el.querySelectorAll('[data-mk]').forEach(inp => {
      const digits = inp.value.replace(/[^1-4]/g, '').split('').map(Number);
      const s = st.sections[+inp.dataset.mk];
      if (digits.length === s.count) s.key = digits;
      else if (digits.length) toast(`בפרק ${s.num} צריך ${s.count} ספרות (הוקלדו ${digits.length})`);
    });
    save(); archive(); render();
  };
}

async function copySummary(rep, sc) {
  const paper = !!rep.paper;
  const lines = [`סימולציה: ${rep.exam}${paper ? ' (על נייר)' : ''} (${(rep.finishedAt || '').slice(0, 10)})`];
  if (sc) lines.push(`V ${sc.V} (${sc.vRaw} גלם) · Q ${sc.Q} (${sc.qRaw} גלם) · דו-תחומי ${sc.two.lo}–${sc.two.hi} · לפי ${sc.table.label}`);
  rep.sections.forEach(s => lines.push(`פרק ${s.num} ${domainName(s.domain)}${s.pilot ? ' (פיילוט)' : ''}: ${s.correct}/${s.total}${paper ? '' : `, זמן ${s.timeUsedSec != null ? fmt(s.timeUsedSec * 1000) : '—'}`}, שגויות: ${s.questions.filter(q => q.isCorrect === false).map(q => q.q).join(',') || 'אין'}`));
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('הסיכום הועתק', 2500); } catch { modal(h(`<pre class="copybox">${esc(lines.join('\n'))}</pre>`)); }
}

// results screen for a saved simulation from the history
function saveEntry(entry) {
  const hh = history(); const k = hh.findIndex(r => r.id === entry.id);
  if (k < 0) return;
  hh[k] = rescoreReport(entry); saveHistory(hh);
  if (state && state.id === entry.id) {
    state.tables = entry.tables; state.tableSource = entry.tableSource; state.examLabel = entry.examLabel;
    entry.sections.forEach((x, i) => { if (state.sections[i]) state.sections[i].pilot = x.pilot; });
    save();
  }
}
function renderHistoryResults() {
  const entry = history().find(r => r.id === historyView.id);
  if (!entry) { historyView = null; return render(); }
  const S = entry.scores;
  const sc = S ? { complete: true, V: S.V, Q: S.Q, vRaw: S.vRaw, qRaw: S.qRaw, two: S.two, verbalW: S.verbalEmphasis, quantW: S.quantEmphasis, percentBelow: S.percentBelow, table: S.table || tableInfo(entry) } : null;
  const inline = (entry.layout || []).map(l => l.inlineOk);
  const el = h(`<div class="page review"></div>`);
  let html = `<div class="row"><button class="btn small secondary" id="backHome">→ חזרה</button></div>
    <h1>תחקור · ${esc(entry.exam)}${entry.examLabel ? ' · ' + esc(entry.examLabel) : ''}</h1>
    <div class="small muted">${new Date(entry.finishedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}${entry.paper ? ' · נייר' : ''}${entry.live ? ' · מודפס' : ''}</div>`;
  html += sc ? scoreBlock(sc, entry.sections) : `<div class="warnbox">בסימולציה הזאת לא היה מפתח תשובות, אז אין ציון.</div>`;
  html += `<div class="row exports">
      <button class="btn" id="openRev">פתח את המבחן לחזרה</button>
      <button class="btn secondary" id="expJson">ייצוא תחקור (JSON)</button>
      <button class="btn secondary" id="expCsv">ייצוא לטבלה (CSV)</button>
      <button class="btn secondary" id="copy">העתק סיכום</button>
    </div>`;
  html += sectionsBlock(entry, !!entry.paper, inline);
  el.innerHTML = html;
  $app.innerHTML = ''; $app.appendChild(el);
  window.scrollTo(0, 0);
  el.querySelector('#backHome').onclick = () => { historyView = null; render(); };
  el.querySelector('#openRev').onclick = () => openRevisit(entry, 'history');
  el.querySelector('#expJson').onclick = () => download(`tahkir-${safeName(entry.exam)}-${(entry.finishedAt || '').slice(0, 10)}.json`, JSON.stringify(entry, null, 2));
  el.querySelector('#expCsv').onclick = () => download(`tahkir-${(entry.finishedAt || '').slice(0, 10)}.csv`, toCSV(entry), 'text/csv');
  el.querySelector('#copy').onclick = () => copySummary(entry, sc);
  const et = el.querySelector('#editTable');
  if (et) et.onclick = () => openTableEditor(entry, () => { saveEntry(entry); render(); });
  el.querySelectorAll('[data-pilot]').forEach(cb => cb.onchange = () => { entry.sections[+cb.dataset.pilot].pilot = cb.checked; saveEntry(entry); render(); });
  el.querySelectorAll('.qtable tr[data-q]').forEach(tr => tr.onclick = () => showQuestionFromEntry(entry, +tr.dataset.s, +tr.dataset.q));
}
async function showQuestionFromEntry(entry, si, q) {
  const L = entry.layout && entry.layout[si];
  const buf = await getPdf(entry.id).catch(() => null);
  if (!L || !buf) { openRevisit(entry, 'history'); return; } // asks for the PDF, then opens the exam
  if (!L.inlineOk || !L.questions[q - 1]) return;
  const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  const qq = L.questions[q - 1];
  const c = await renderPageCanvas(qq.page, 1400, doc);
  const top = Math.max(0, Math.floor(qq.top * c.height) - 4), bot = Math.min(c.height, Math.ceil(qq.bottom * c.height) + 4);
  const out = document.createElement('canvas');
  out.width = c.width; out.height = bot - top;
  out.getContext('2d').drawImage(c, 0, top, c.width, out.height, 0, 0, c.width, out.height);
  out.className = 'qcrop';
  const Q = entry.sections[si].questions[q - 1];
  const box = h(`<div><div class="qhead">פרק ${entry.sections[si].num} · שאלה ${q} · סימנת: <b>${Q.answer ?? '—'}</b> · נכונה: <b>${Q.correct ?? '?'}</b>${Q.timeSec != null ? ` · זמן: <b>${fmt(Q.timeSec * 1000)}</b>` : ''}</div></div>`);
  box.appendChild(out);
  modal(box);
}

async function showQuestion(si, q) {
  const s = state.sections[si];
  if (!s.inlineOk || !pdfDoc) return;
  const qq = s.questions[q - 1];
  const c = await renderPageCanvas(qq.page, 1400);
  const top = Math.max(0, Math.floor(qq.top * c.height) - 4), bot = Math.min(c.height, Math.ceil(qq.bottom * c.height) + 4);
  const out = document.createElement('canvas');
  out.width = c.width; out.height = bot - top;
  out.getContext('2d').drawImage(c, 0, top, c.width, out.height, 0, 0, c.width, out.height);
  out.className = 'qcrop';
  const ans = (state.answers[si] || {})[q];
  const box = h(`<div><div class="qhead">פרק ${s.num} · שאלה ${q} · סימנת: <b>${ans ?? '—'}</b> · נכונה: <b>${s.key ? s.key[q - 1] : '?'}</b></div></div>`);
  box.appendChild(out);
  modal(box);
}

// ---------- per-exam conversion tables ----------
async function docPagesText(doc) {
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push(await pageText(await doc.getPage(p)));
  return out;
}

// edit the raw -> V/Q table of `target` (the current state or a history entry); onSave() persists it
function openTableEditor(target, onSave) {
  const base = tablesFor(target) || target.tables || {};
  let V = (base.V && base.V.length === 47 ? base.V : DEFAULT_TABLES.V).slice();
  let Q = (base.Q && base.Q.length === 41 ? base.Q : DEFAULT_TABLES.Q).slice();
  let general = base.general || null, pct = base.pct || null;
  let source = target.tableSource === 'exam' || target.tableSource === 'manual' ? target.tableSource : null;
  let label = target.examLabel || null;
  const box = h(`<div class="tbl-editor">
    <h2>טבלת מעבר: ציון גלם ← ציון בסולם האחיד</h2>
    <p class="small muted status"></p>
    <div class="row">
      <label class="btn secondary small">חלץ מ-PDF (דף "חישוב אומדן")<input type="file" accept="application/pdf" hidden></label>
      <button class="btn secondary small" id="pasteBtn">הדבקה מהירה</button>
      <button class="btn secondary small" id="useGeneral">השתמש בטבלה הכללית</button>
    </div>
    <div class="paste hidden">
      <div class="small muted">הדבק את העמודה של כל תחום לפי הסדר מציון גלם 0, מופרדת ברווחים, פסיקים או שורות.</div>
      <label>מילולי (47 מספרים)<textarea id="pV" rows="2" dir="ltr"></textarea></label>
      <label>כמותי (41 מספרים)<textarea id="pQ" rows="2" dir="ltr"></textarea></label>
      <button class="btn small" id="pasteApply">מלא את הטבלה</button>
    </div>
    <div class="tbl-grid"></div>
    <div class="error hidden"></div>
    <div class="row"><button class="btn" id="saveTbl">שמור טבלה</button></div>
  </div>`);
  const grid = box.querySelector('.tbl-grid'), err = box.querySelector('.error'), status = box.querySelector('.status');
  const showStatus = () => {
    status.textContent = source === 'exam' ? `הטבלה חולצה מהקובץ${label ? ' (' + label + ')' : ''}. אפשר לתקן ידנית.` : source === 'manual' ? 'טבלה שהוזנה ידנית.' : `כרגע מוצגת ${DEFAULT_LABEL}. תקן לפי דף האומדן של המבחן, או חלץ אותו מ-PDF.`;
  };
  const draw = () => {
    grid.innerHTML = `<div class="tg-head"><span>גלם</span><span>מילולי</span><span>כמותי</span></div>` +
      Array.from({ length: 47 }, (_, i) => `<div class="tg-row"><span class="raw">${i}</span><input data-v="${i}" type="number" value="${V[i] ?? ''}">${i <= 40 ? `<input data-q="${i}" type="number" value="${Q[i] ?? ''}">` : '<span></span>'}</div>`).join('');
    grid.querySelectorAll('input').forEach(inp => inp.oninput = () => {
      const v = inp.value === '' ? null : +inp.value;
      if (inp.dataset.v != null) V[+inp.dataset.v] = v; else Q[+inp.dataset.q] = v;
      if (source === 'exam') { source = 'manual'; showStatus(); }
    });
  };
  draw(); showStatus();
  modal(box);
  box.querySelector('input[type=file]').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    err.classList.add('hidden');
    try {
      const doc = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
      const ext = extractTables(await docPagesText(doc));
      if (!ext) throw new Error('לא נמצא בקובץ דף "חישוב אומדן ציוני הבחינה".');
      if (ext.tables.V) V = ext.tables.V.slice();
      if (ext.tables.Q) Q = ext.tables.Q.slice();
      general = ext.tables.general || general; pct = ext.tables.pct || pct;
      label = ext.label || label;
      source = ext.ok ? 'exam' : 'manual';
      draw(); showStatus();
      if (!ext.ok) { err.textContent = 'החילוץ לא הושלם: ' + ext.problems.join(' · ') + '. השלם את התאים החסרים ידנית.'; err.classList.remove('hidden'); }
    } catch (e2) { err.textContent = e2.message || 'שגיאה בקריאת הקובץ'; err.classList.remove('hidden'); }
  };
  box.querySelector('#pasteBtn').onclick = () => box.querySelector('.paste').classList.toggle('hidden');
  box.querySelector('#pasteApply').onclick = () => {
    const nums = (t) => (t.match(/\d+/g) || []).map(Number);
    const pv = nums(box.querySelector('#pV').value), pq = nums(box.querySelector('#pQ').value);
    if (pv.length) { if (pv.length !== 47) { err.textContent = `במילולי צריך 47 מספרים (הודבקו ${pv.length})`; err.classList.remove('hidden'); return; } V = pv; }
    if (pq.length) { if (pq.length !== 41) { err.textContent = `בכמותי צריך 41 מספרים (הודבקו ${pq.length})`; err.classList.remove('hidden'); return; } Q = pq; }
    err.classList.add('hidden'); source = 'manual'; draw(); showStatus();
  };
  box.querySelector('#useGeneral').onclick = () => {
    if (!confirm('לחשב את המבחן הזה לפי הטבלה הכללית?')) return;
    target.tableSource = 'general';
    document.getElementById('modal').classList.add('hidden');
    onSave();
  };
  box.querySelector('#saveTbl').onclick = () => {
    const errs = validateVQ(V, Q);
    if (errs.length) { err.textContent = errs.join(' · '); err.classList.remove('hidden'); return; }
    target.tables = { V, Q, general, pct };
    target.tableSource = source || 'manual';
    target.examLabel = label;
    document.getElementById('modal').classList.add('hidden');
    onSave();
  };
}

// recompute a history entry with its exam's own table: from the saved PDF, an uploaded PDF, or manual entry
async function recalcEntry(id) {
  const find = () => { const hh = history(); return { hh, k: hh.findIndex(r => r.id === id) }; };
  const persist = (entry) => {
    saveEntry(entry);
    render();
    const { hh, k } = find();
    if (k < 0) return;
    const sc = hh[k].scores;
    toast(sc ? `חושב מחדש: V ${sc.V} · Q ${sc.Q} · ${sc.two.lo}–${sc.two.hi} (${sc.table.label})` : 'נשמר', 6000);
  };
  const { hh, k } = find(); if (k < 0) return;
  const entry = hh[k];
  const buf = await getPdf(id).catch(() => null);
  const tryDoc = async (data) => {
    const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
    return extractTables(await docPagesText(doc));
  };
  if (buf && entry.tableSource !== 'exam') {
    const ext = await tryDoc(buf).catch(() => null);
    if (ext && ext.ok) { Object.assign(entry, { tables: ext.tables, tableSource: 'exam', examLabel: ext.label || entry.examLabel }); persist(entry); return; }
  }
  const box = h(`<div class="reupload">
    <h2>טבלת הציון של ${esc(entry.exam)}</h2>
    <p class="muted">${tableInfo(entry).source === 'general' ? 'הציון של הסימולציה הזאת חושב לפי טבלה כללית.' : 'חושב לפי: ' + esc(tableInfo(entry).label) + '.'} כדי לחשב לפי טבלת המבחן, העלה את קובץ הבחינה (ה-PDF עם דף "חישוב אומדן"), או הזן את הטבלה ידנית.</p>
    <div class="row"><label class="btn">העלה PDF של המבחן<input type="file" accept="application/pdf" hidden></label>
    <button class="btn secondary" id="manual">הזנה ידנית</button></div>
    <div class="error hidden"></div></div>`);
  modal(box);
  const err = box.querySelector('.error');
  box.querySelector('#manual').onclick = () => openTableEditor(entry, () => persist(entry));
  box.querySelector('input').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const data = await f.arrayBuffer();
      let ext;
      try { ext = await tryDoc(data); } catch { throw new Error('זה לא קובץ PDF תקין.'); }
      if (!ext) throw new Error('לא נמצא בקובץ דף "חישוב אומדן ציוני הבחינה".');
      if (!ext.ok) { Object.assign(entry, { tables: ext.tables, examLabel: ext.label }); openTableEditor(entry, () => persist(entry)); return; }
      Object.assign(entry, { tables: ext.tables, tableSource: 'exam', examLabel: ext.label || entry.examLabel });
      if (!(await getPdf(id).catch(() => null)) && (!entry.numPages || entry.numPages === (await pdfjs.getDocument({ data: data.slice(0) }).promise).numPages)) await putPdf(id, data);
      document.getElementById('modal').classList.add('hidden');
      persist(entry);
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
  };
}

// ---------- reopen the exam in review mode ----------
function layoutOf(sections) {
  return sections.map(s => ({ pages: s.pages, inlineOk: s.inlineOk, questions: s.questions.map(q => ({ page: q.page, ny: +q.ny.toFixed(4), top: +q.top.toFixed(4), bottom: +q.bottom.toFixed(4) })) }));
}

async function openRevisit(entry, back) {
  if (!entry) return;
  let layout = entry.layout;
  const buf = await getPdf(entry.id).catch(() => null);
  if (buf && layout) {
    const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    revisit = { rep: entry, layout, doc, si: 0, back };
    render(); return;
  }
  // the PDF isn't saved on this device (or the entry is from before layouts were stored): ask for it again
  const box = h(`<div class="reupload">
    <h2>צריך את קובץ הבחינה</h2>
    <p class="muted">הקובץ של <b>${esc(entry.exam)}</b> לא שמור במכשיר הזה. העלה אותו שוב, את אותו PDF שעליו עשית את הסימולציה.</p>
    <label class="btn">בחר קובץ<input type="file" accept="application/pdf" hidden></label>
    <div class="progress hidden"><div class="bar"></div><div class="small muted">מעבד…</div></div>
    <div class="error hidden"></div></div>`);
  modal(box);
  const inp = box.querySelector('input'), err = box.querySelector('.error'), prog = box.querySelector('.progress');
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = '';
    if (!f) return;
    err.classList.add('hidden');
    try {
      const b2 = await f.arrayBuffer();
      let doc;
      try { doc = await pdfjs.getDocument({ data: b2.slice(0) }).promise; } catch { throw new Error('זה לא קובץ PDF תקין.'); }
      if (entry.numPages && doc.numPages !== entry.numPages) throw new Error(`זה לא אותו קובץ: לבחינה היו ${entry.numPages} עמודים ולקובץ הזה ${doc.numPages}.`);
      if (!layout) {
        prog.classList.remove('hidden');
        const res = await analyzeExam(p => { prog.querySelector('.bar').style.width = Math.round(p * 100) + '%'; }, doc);
        const same = res.sections.length === entry.sections.length && res.sections.every((s, i) => s.num === entry.sections[i].num);
        if (!same) throw new Error('המבנה של הקובץ לא תואם לסימולציה הזאת. בדוק שזה אותו קובץ.');
        res.sections.forEach((s, i) => { s.inlineOk = s.questions.length === entry.sections[i].total; });
        layout = layoutOf(res.sections);
      }
      await putPdf(entry.id, b2);
      const hh = history(); const k = hh.findIndex(r => r.id === entry.id);
      if (k >= 0) { hh[k].layout = layout; hh[k].numPages = doc.numPages; saveHistory(hh); }
      document.getElementById('modal').classList.add('hidden');
      revisit = { rep: { ...entry, layout }, layout, doc, si: 0, back };
      render();
    } catch (e) {
      prog.classList.add('hidden');
      err.textContent = e.message || 'שגיאה בקריאת הקובץ'; err.classList.remove('hidden');
    }
  };
}

function resultOf(q) { return !q.answer ? 'blank' : q.isCorrect ? 'right' : q.isCorrect === false ? 'wrong' : 'unknown'; }

function renderRevisit() {
  const gen = renderGen;
  const { rep: R, layout, doc } = revisit;
  const si = revisit.si;
  const S = R.sections[si], L = layout[si];
  document.body.classList.add('in-exam');
  const el = h(`
  <div class="exam revisit">
    <div class="revbar">
      <button class="btn small secondary" id="back">→ חזרה לתחקור</button>
      <div class="tabs">${R.sections.map((x, i) => `<button class="tab ${i === si ? 'on' : ''}" data-si="${i}">פרק ${x.num}<span class="tabdom"> · ${domainName(x.domain)}</span> <span class="tabscore">${x.correct}/${x.total}</span>${x.pilot ? ' <span class="tag">פיילוט</span>' : ''}</button>`).join('')}</div>
    </div>
    <div class="booklet" id="booklet"></div>
    <div class="answerbar">
      <div class="bar-title">פרק ${S.num}</div>
      <div class="grid">${S.questions.map(q => `<button class="cell res-${resultOf(q)}" data-q="${q.q}" title="שלי: ${q.answer ?? '—'} · נכונה: ${q.correct ?? '?'}${q.timeSec == null ? '' : ` · זמן: ${fmt(q.timeSec * 1000)}`}"><span class="n">${q.q}</span><span class="a">${q.answer ?? ''}</span>${q.timeSec == null ? '' : `<span class="t">${fmt(q.timeSec * 1000)}</span>`}</button>`).join('')}</div>
      <div class="current"><button class="btn small secondary" id="prevWrong">→ השגויה הקודמת</button><button class="btn small secondary" id="nextWrong">השגויה הבאה ←</button></div>
    </div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  el.querySelector('#back').onclick = () => { revisit = null; render(); };
  el.querySelectorAll('.tab').forEach(t => t.onclick = () => { revisit.si = +t.dataset.si; render(); });

  const booklet = el.querySelector('#booklet');
  const narrow = window.innerWidth <= 760;
  const width = Math.max(280, Math.min(900, booklet.clientWidth - (narrow ? 12 : 190)));
  const boxes = {};
  for (const pn of L.pages) {
    const wrap = h(`<div class="pagewrap"><div class="side rev"></div><div class="pagebox" data-page="${pn}"><div class="loading">טוען…</div></div></div>`);
    wrap.querySelector('.pagebox').style.width = width + 'px';
    booklet.appendChild(wrap);
    boxes[pn] = wrap;
  }
  if (!L.inlineOk) booklet.insertBefore(h(`<div class="warnbox" style="max-width:${width}px;margin:0 auto 12px">בפרק הזה לא זוהה המיקום של כל שאלה, אז הסימון מופיע רק בסרגל שלמטה.</div>`), booklet.firstChild);
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  (async () => {
    for (const pn of L.pages) {
      const c = await renderPageCanvas(pn, Math.round(width * dpr), doc);
      if (gen !== renderGen) return;
      c.style.width = width + 'px';
      const wrap = boxes[pn], box = wrap.querySelector('.pagebox');
      box.innerHTML = ''; box.appendChild(c);
      if (!L.inlineOk) continue;
      const hpx = width * c.height / c.width;
      const side = wrap.querySelector('.side'); side.style.height = hpx + 'px';
      L.questions.forEach((q, i) => {
        if (q.page !== pn) return;
        const Q = S.questions[i]; if (!Q) return;
        const res = resultOf(Q);
        const sh = h(`<div class="qshade rev res-${res}" data-q="${Q.q}"></div>`);
        sh.style.top = (q.top * 100) + '%'; sh.style.height = ((q.bottom - q.top) * 100) + '%';
        const tm = Q.timeSec == null ? '' : fmt(Q.timeSec * 1000) + (Q.autoAssignedSec ? '*' : '');
        const label = (res === 'right' ? '✓' : res === 'wrong' ? `✗ סימנת ${Q.answer}, נכונה ${Q.correct}` : res === 'blank' ? `ללא תשובה, נכונה ${Q.correct ?? '?'}` : '') + (tm ? ` · ⏱ ${tm}` : '');
        sh.appendChild(h(`<span class="corner res-${res}">${label}</span>`));
        box.appendChild(sh);
        const g = h(`<div class="bubbles rev" data-q="${Q.q}"><span class="qn">${Q.q}</span>${[1, 2, 3, 4].map(a => `<span class="b ${a === Q.correct ? 'correct' : ''} ${a === Q.answer ? 'mine' : ''}">${a}</span>`).join('')}
          <div class="meta"><span class="st res-${res}">${res === 'right' ? '✓ נכון' : res === 'wrong' ? '✗ שגוי' : res === 'blank' ? 'ללא תשובה' : ''}</span>${tm ? `<span class="tm" title="${Q.autoAssignedSec ? 'כולל זמן שנזקף אוטומטית (סומנה בלי לחיצה)' : 'זמן על השאלה'}">⏱ ${tm}</span>` : ''}</div></div>`);
        g.style.top = (q.ny * hpx - 6) + 'px';
        side.appendChild(g);
      });
    }
  })();

  const jump = (qn) => {
    if (!L.inlineOk) return;
    const q = L.questions[qn - 1]; if (!q) return;
    const box = booklet.querySelector(`.pagebox[data-page="${q.page}"]`); if (!box) return;
    booklet.scrollTo({ top: Math.max(0, box.offsetTop + q.top * box.offsetHeight - booklet.clientHeight * SCROLL_TO), behavior: 'smooth' });
    el.querySelectorAll('.cell').forEach(c => c.classList.toggle('sel', +c.dataset.q === qn));
    revisit.cur = qn;
  };
  el.querySelectorAll('.cell').forEach(c => c.onclick = () => jump(+c.dataset.q));
  const wrongs = S.questions.filter(q => resultOf(q) === 'wrong' || resultOf(q) === 'blank').map(q => q.q);
  const step = (dir) => {
    if (!wrongs.length) { toast('אין שגויות בפרק הזה', 2500); return; }
    const cur = revisit.cur || 0;
    const next = dir > 0 ? (wrongs.find(q => q > cur) ?? wrongs[0]) : ([...wrongs].reverse().find(q => q < cur) ?? wrongs[wrongs.length - 1]);
    jump(next);
  };
  revisit.cur = 0;
  el.querySelector('#nextWrong').onclick = () => step(1);
  el.querySelector('#prevWrong').onclick = () => step(-1);
}

// ---------- other tabs / leaving the page ----------
function renderLocked() {
  document.body.classList.remove('in-exam');
  $app.innerHTML = '';
  $app.appendChild(h(`<div class="page"><h1>הבחינה פתוחה בלשונית אחרת</h1>
    <p class="muted">כדי שהתשובות לא יידרסו, אפשר להמשיך רק בלשונית אחת. סגור את הלשונית הזאת, או לחץ כאן כדי להמשיך מכאן.</p>
    <button class="btn" id="takeover">המשך בלשונית הזאת</button></div>`));
  document.getElementById('takeover').onclick = () => location.reload();
}
window.addEventListener('storage', (e) => {
  if (e.key !== STATE_KEY || lockedOut) return;
  if (state && (state.phase === 'essay' || state.phase === 'section')) {
    let other = null; try { other = JSON.parse(e.newValue); } catch {}
    if (other && other.owner === TAB_ID) return;
    lockedOut = true; render();
  }
  else { state = loadState(); if (!state) pdfDoc = null; boot(); }
});
const flush = () => { if (!lockedOut && state && (state.phase === 'essay' || state.phase === 'section')) save(); };
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

// ---------- boot ----------
async function boot() {
  state = loadState();
  if (state && state.id) {
    try {
      const buf = await getPdf(state.id);
      if (!buf) throw new Error('pdf missing');
      pdfDoc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    } catch (e) {
      console.warn(e);
      if (state.phase !== 'done') { state = null; localStorage.removeItem(STATE_KEY); }
    }
  }
  if (state && state.phase === 'done') archive();
  render();
}
boot();
