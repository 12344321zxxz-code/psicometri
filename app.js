// סימולטור פסיכומטרי — מעלה PDF של סימולציה, מציג פרק אחרי פרק עם זמן נעול, ומנקד לפי מפתח התשובות.
import * as pdfjs from './vendor/pdf.min.js';
import { RAW_TO_V, RAW_TO_Q, GENERAL_TABLE, PERCENTILE_TABLE } from './tables.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;

const $app = document.getElementById('app');
const STATE_KEY = 'psy_state_v1';
const HISTORY_KEY = 'psy_history_v1';
const DEFAULT_ESSAY_MIN = 30;
const DEFAULT_SECTION_MIN = 20;
const WARN_MS = 5 * 60 * 1000;
const READ_LINE = 0.4; // which height of the screen counts as "the question being read"

let state = null;     // persisted
let pdfDoc = null;    // loaded pdf.js document
let tickTimer = null;
let lastTick = 0;
let activeQ = null;   // {s, q} or {s, other:true}
let selectedQ = 0;    // question shown in the bottom answer row

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
const rng = (lo, hi) => `<span dir="ltr">${lo}–${hi}</span>`;
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
  const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
  const header = items.filter(i => i.y > H * 0.88).map(i => i.s).join(' ');
  const body = items.filter(i => i.y <= H * 0.88).map(i => i.s).join(' ');
  return { items, header, body, H };
}

function classify(t) {
  const hd = t.header;
  const blank = /עמוד ריק/.test(t.body) || /טיוטה/.test(t.body);
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
  for (const t of pagesText) {
    const lines = [];
    for (const it of t.items) {
      let L = lines.find(l => Math.abs(l.y - it.y) < 2.5);
      if (!L) { L = { y: it.y, items: [] }; lines.push(L); }
      L.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    let cur = null;
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

async function renderPageCanvas(pageNum, width) {
  const page = await pdfDoc.getPage(pageNum);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

async function analyzeExam(onProgress) {
  const n = pdfDoc.numPages;
  const pages = [];
  for (let p = 1; p <= n; p++) {
    const page = await pdfDoc.getPage(p);
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
      const c = await renderPageCanvas(pn, 827);
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
  return { essayPages, sections, keyFound: keyBlocks.length > 0, scoringFound };
}

// ---------- scoring ----------
function weightedToGeneral(w) {
  const r = Math.round(w * 2) / 2;
  for (const row of GENERAL_TABLE) if (r <= row.max) return { weighted: r, lo: row.lo, hi: row.hi };
  return { weighted: r, lo: 800, hi: 800 };
}
function percentile(g) {
  for (const row of PERCENTILE_TABLE) if (g <= row.hi) return row;
  return PERCENTILE_TABLE[PERCENTILE_TABLE.length - 1];
}
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
  const V = RAW_TO_V[Math.min(vRaw, RAW_TO_V.length - 1)];
  const Q = RAW_TO_Q[Math.min(qRaw, RAW_TO_Q.length - 1)];
  const mk = (w) => { const g = weightedToGeneral(w); return { ...g, mid: Math.round((g.lo + g.hi) / 2) }; };
  const two = mk((V + Q) / 2), verbalW = mk((3 * V + Q) / 4), quantW = mk((3 * Q + V) / 4);
  return { per, complete: true, vRaw, qRaw, V, Q, two, verbalW, quantW, pct: percentile(two.mid) };
}

// ---------- screens ----------
function render() {
  clearInterval(tickTimer); tickTimer = null;
  document.body.classList.remove('in-exam');
  if (!state || state.phase === 'setup') return state ? renderSetup() : renderHome();
  if (state.phase === 'done') return renderReview();
  return renderExam();
}

function renderHome() {
  const hist = history();
  const el = h(`
  <div class="page home">
    <h1>סימולטור פסיכומטרי</h1>
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
    ${hist.map((r, i) => `<tr><td>${new Date(r.finishedAt).toLocaleDateString('he-IL')}</td><td class="fname">${esc(r.exam)}</td><td>${r.scores?.V ?? '—'}</td><td>${r.scores?.Q ?? '—'}</td><td>${r.scores?.two ? rng(r.scores.two.lo, r.scores.two.hi) : '—'}</td><td><button class="link" data-exp="${i}">ייצוא</button> <button class="link danger" data-del="${i}">מחק</button></td></tr>`).join('')}
    </tbody></table>
    <button class="btn secondary" id="expAll">ייצוא כל התחקורים (JSON)</button>` : ''}
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  const input = el.querySelector('#file');
  input.onchange = () => input.files[0] && startUpload(input.files[0]);
  const drop = el.querySelector('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) startUpload(f); };
  el.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => { const r = history()[+b.dataset.exp]; download(`tahkir-${r.finishedAt.slice(0, 10)}.json`, JSON.stringify(r, null, 2)); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (!confirm('למחוק את התחקור הזה מההיסטוריה?')) return; const hh = history(); hh.splice(+b.dataset.del, 1); saveHistory(hh); render(); });
  const ea = el.querySelector('#expAll');
  if (ea) ea.onclick = () => download(`tahkirim-all-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(history(), null, 2));
}

async function startUpload(file) {
  const prog = document.getElementById('progress'), err = document.getElementById('err');
  err.classList.add('hidden'); prog.classList.remove('hidden');
  const bar = prog.querySelector('.bar');
  try {
    const buf = await file.arrayBuffer();
    pdfDoc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    const res = await analyzeExam(p => { bar.style.width = Math.round(p * 100) + '%'; });
    const id = 'x' + Date.now();
    await putPdf(id, buf);
    state = {
      id, exam: file.name.replace(/\.pdf$/i, ''), createdAt: new Date().toISOString(),
      essay: { pages: res.essayPages, minutes: DEFAULT_ESSAY_MIN },
      sections: res.sections, keyFound: res.keyFound, scoringFound: res.scoringFound,
      phase: 'setup', current: null, phaseStart: 0, phaseEnd: 0, warned: false,
      answers: {}, log: [], qtime: {}, phases: [],
    };
    save(); render();
  } catch (e) {
    console.error(e);
    prog.classList.add('hidden');
    err.textContent = e.message || 'שגיאה בקריאת הקובץ';
    err.classList.remove('hidden');
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
      <div>${s.scoringFound ? '<span class="ok">✓</span> חישוב הציון לפי טבלת המעבר של הבחינה' : 'חישוב הציון לפי טבלת מעבר כללית (הפורמט הדו-תחומי)'}</div>
    </div>
    <div class="howto">
      <b>איך זה עובד</b>
      <ul>
        <li>הפרקים מוצגים לפי הסדר. שעון לא מוצג. כשנשארות 5 דקות תקפוץ הודעה קטנה.</li>
        <li>כשהזמן נגמר, הפרק ננעל והבא מתחיל אוטומטית. אי אפשר לחזור לפרק קודם.</li>
        <li>מסמנים תשובה בעיגולים שליד כל שאלה או בסרגל שלמטה. לחיצה נוספת על אותה תשובה מוחקת אותה.</li>
        <li>הזמן נמדד לפי השאלה שנמצאת בגובה הקריאה במסך.</li>
      </ul>
    </div>
    <div class="row">
      <button class="btn" id="start">התחל בחינה</button>
      <button class="btn secondary" id="cancel">בטל וחזור</button>
    </div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  el.querySelectorAll('[data-sec]').forEach(inp => inp.onchange = () => { s.sections[+inp.dataset.sec].minutes = Math.max(1, +inp.value || DEFAULT_SECTION_MIN); save(); });
  const ei = el.querySelector('[data-essay]'); if (ei) ei.onchange = () => { s.essay.minutes = Math.max(1, +ei.value || DEFAULT_ESSAY_MIN); save(); };
  el.querySelector('#cancel').onclick = async () => { await delPdf(s.id); state = null; localStorage.removeItem(STATE_KEY); render(); };
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
  state.warned = false;
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
  let moved = false;
  while ((state.phase === 'essay' || state.phase === 'section') && Date.now() >= state.phaseEnd) {
    moved = true;
    if (!endPhase(state.phaseEnd, 'time')) break;
  }
  return moved;
}

// ---------- exam screen ----------
async function renderExam() {
  if (catchUp()) { render(); return; }
  document.body.classList.add('in-exam');
  const idx = state.current;
  const isEssay = idx === -1;
  const sec = isEssay ? null : state.sections[idx];
  selectedQ = 1;
  activeQ = null;

  const el = h(`
  <div class="exam">
    <div class="booklet" id="booklet"></div>
    <div class="answerbar" id="answerbar"></div>
  </div>`);
  $app.innerHTML = ''; $app.appendChild(el);
  const booklet = el.querySelector('#booklet');
  const bar = el.querySelector('#answerbar');

  const pages = isEssay ? state.essay.pages : sec.pages;
  const width = Math.min(900, booklet.clientWidth - (isEssay ? 24 : 170));
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
      c.style.width = width + 'px';
      const box = pageEls[pn].querySelector('.pagebox');
      box.innerHTML = ''; box.appendChild(c);
      if (!isEssay) placeInline(pn, pageEls[pn], c);
    }
  })();

  if (isEssay) {
    bar.innerHTML = `<div class="bar-title">מטלת כתיבה · כתוב במחברת</div><div class="spacer"></div><button class="btn small" id="finish">סיימתי, לפרק הבא</button>`;
  } else {
    drawBar(bar, sec, idx);
  }
  bar.querySelector('#finish').onclick = () => {
    if (!confirm(isEssay ? 'לעבור לפרק הראשון? לא תוכל לחזור למטלת הכתיבה.' : 'לסיים את הפרק? לא תוכל לחזור אליו.')) return;
    endPhase(Date.now(), 'user'); render();
  };

  // ticking: time accounting + warnings + auto advance
  lastTick = Date.now();
  tickTimer = setInterval(() => tick(booklet), 500);
  booklet.onscroll = () => { if (!isEssay) updateActive(booklet); };
  window.onresize = null;
}

function placeInline(pn, wrap, canvas) {
  const idx = state.current, sec = state.sections[idx];
  if (!sec.inlineOk) return;
  const side = wrap.querySelector('.side');
  const hpx = parseFloat(canvas.style.width) * canvas.height / canvas.width;
  side.style.height = hpx + 'px';
  sec.questions.forEach((q, i) => {
    if (q.page !== pn) return;
    const qn = i + 1;
    const g = h(`<div class="bubbles" data-q="${qn}"><span class="qn">${qn}</span>${[1, 2, 3, 4].map(a => `<button data-a="${a}">${a}</button>`).join('')}</div>`);
    g.style.top = (q.ny * hpx - 6) + 'px';
    g.querySelectorAll('button').forEach(b => b.onclick = () => setAnswer(qn, +b.dataset.a));
    side.appendChild(g);
  });
  refreshMarks();
  updateActive(document.getElementById('booklet'));
}

function drawBar(bar, sec, idx) {
  bar.innerHTML = `
    <div class="bar-title">פרק ${sec.num}</div>
    <div class="grid">${Array.from({ length: sec.count }, (_, i) => `<button class="cell" data-q="${i + 1}"><span class="n">${i + 1}</span><span class="a"></span></button>`).join('')}</div>
    <div class="current"><span class="cur-label"></span>${[1, 2, 3, 4].map(a => `<button class="ans" data-a="${a}">${a}</button>`).join('')}</div>
    <button class="btn small" id="finish">סיום פרק</button>`;
  bar.querySelectorAll('.cell').forEach(c => c.onclick = () => { selectQ(+c.dataset.q, true); });
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
      const target = box.offsetTop + qq.top * box.offsetHeight - booklet.clientHeight * READ_LINE + 20;
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
  state.log.push({ t: Date.now(), s: idx, q, a: next, prev });
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
    g.classList.toggle('active', activeQ && activeQ.q === q);
  });
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

function updateActive(booklet) {
  const idx = state.current;
  if (idx == null || idx < 0) return;
  const sec = state.sections[idx];
  if (!sec.inlineOk) { activeQ = { q: selectedQ }; return; }
  const line = booklet.scrollTop + booklet.clientHeight * READ_LINE;
  let found = null;
  sec.questions.forEach((q, i) => {
    const box = booklet.querySelector(`.pagebox[data-page="${q.page}"]`);
    if (!box) return;
    const t = box.offsetTop + q.top * box.offsetHeight, b = box.offsetTop + q.bottom * box.offsetHeight;
    if (line >= t && line <= b) found = i + 1;
  });
  const prev = activeQ && activeQ.q;
  activeQ = found ? { q: found } : { other: true };
  if (found && found !== prev) selectedQ = found;
  if ((activeQ.q || null) !== (prev || null)) refreshMarks();
}

function tick(booklet) {
  const now = Date.now();
  const dt = now - lastTick; lastTick = now;
  if (state.phase === 'section') {
    const idx = state.current;
    const sec = state.sections[idx];
    if (!sec.inlineOk) activeQ = { q: selectedQ };
    const key = activeQ && activeQ.q ? String(activeQ.q) : 'other';
    const qt = state.qtime[idx] || (state.qtime[idx] = {});
    qt[key] = (qt[key] || 0) + Math.min(dt, 5000);
  }
  if (!state.warned && state.phaseEnd - now <= WARN_MS && state.phaseEnd - now > 0) {
    state.warned = true; save();
    toast('נותרו 5 דקות', 8000);
  }
  if (now >= state.phaseEnd) {
    const wasEssay = state.phase === 'essay';
    endPhase(state.phaseEnd, 'time');
    if (state.phase !== 'done') toast(wasEssay ? 'הזמן למטלת הכתיבה נגמר. עוברים לפרק הבא.' : 'הזמן נגמר. הפרק ננעל ועוברים לפרק הבא.', 5000);
    render();
    return;
  }
  if (now % 5000 < 600) save();
}

// ---------- results / review ----------
function buildReport(st) {
  const scores = computeScores(st);
  const sections = st.sections.map((s, i) => {
    const ans = st.answers[i] || {};
    const qt = st.qtime[i] || {};
    const ph = st.phases.find(p => p.idx === i);
    const evs = st.log.filter(e => e.s === i);
    const qs = Array.from({ length: s.count }, (_, k) => {
      const q = k + 1;
      const my = evs.filter(e => e.q === q);
      const correct = s.key ? s.key[k] : null;
      return {
        q, answer: ans[q] || null, correct, isCorrect: s.key ? (ans[q] || null) === correct : null,
        timeSec: Math.round((qt[q] || 0) / 1000),
        changes: Math.max(0, my.length - 1),
        firstAnswerSec: my.length && ph ? Math.round((my[0].t - ph.start) / 1000) : null,
        lastAnswerSec: my.length && ph ? Math.round((my[my.length - 1].t - ph.start) / 1000) : null,
      };
    });
    return {
      num: s.num, domain: s.domain, pilot: s.pilot, minutes: s.minutes,
      timeUsedSec: ph && ph.end ? Math.round((ph.end - ph.start) / 1000) : null,
      endedBy: ph ? ph.endedBy : null,
      otherTimeSec: Math.round((qt.other || 0) / 1000),
      timeMeasured: s.inlineOk ? 'by-scroll' : 'by-selected-question',
      correct: scores.per[i].correct, total: s.count, answered: scores.per[i].answered,
      questions: qs,
    };
  });
  const essayPh = st.phases.find(p => p.idx === -1);
  return {
    exam: st.exam, startedAt: st.phases[0] ? new Date(st.phases[0].start).toISOString() : null, finishedAt: st.finishedAt,
    essay: essayPh ? { minutes: st.essay.minutes, timeUsedSec: essayPh.end ? Math.round((essayPh.end - essayPh.start) / 1000) : null } : null,
    scores: scores.complete ? { vRaw: scores.vRaw, qRaw: scores.qRaw, V: scores.V, Q: scores.Q, two: scores.two, verbalEmphasis: scores.verbalW, quantEmphasis: scores.quantW, percentBelow: scores.pct.below } : null,
    sections,
    notes: 'timeSec = זמן שהשאלה הייתה בגובה הקריאה במסך. otherTimeSec = זמן על קטעי קריאה/הוראות. פרק פיילוט לא נכלל בציון.',
  };
}

function archive() {
  const rep = buildReport(state);
  const hh = history();
  const i = hh.findIndex(r => r.id === state.id);
  rep.id = state.id;
  if (i >= 0) hh[i] = rep; else hh.unshift(rep);
  saveHistory(hh);
}

function toCSV(rep) {
  const rows = [['פרק', 'תחום', 'פיילוט', 'שאלה', 'תשובה שלי', 'נכונה', 'צדקתי', 'זמן (שנ׳)', 'שינויים']];
  rep.sections.forEach(s => s.questions.forEach(q => rows.push([s.num, domainName(s.domain), s.pilot ? 'כן' : '', q.q, q.answer ?? '', q.correct ?? '', q.isCorrect == null ? '' : q.isCorrect ? '✓' : '✗', q.timeSec, q.changes])));
  return '﻿' + rows.map(r => r.join(',')).join('\n');
}

function renderReview() {
  const st = state;
  const rep = buildReport(st);
  const sc = computeScores(st);
  const el = h(`<div class="page review"></div>`);
  let html = `<h1>תחקור · ${esc(st.exam)}</h1>`;
  if (sc.complete) {
    html += `
    <div class="scorecards">
      <div class="card"><div class="lbl">חשיבה מילולית</div><div class="big">${sc.V}</div><div class="small muted">${sc.vRaw} נכונות (גלם)</div></div>
      <div class="card"><div class="lbl">חשיבה כמותית</div><div class="big">${sc.Q}</div><div class="small muted">${sc.qRaw} נכונות (גלם)</div></div>
      <div class="card main"><div class="lbl">אומדן דו-תחומי</div><div class="big">${rng(sc.two.lo, sc.two.hi)}</div><div class="small muted">משוקלל ${sc.two.weighted} · כ-${sc.pct.below}% מהנבחנים מתחת לטווח</div></div>
    </div>
    <div class="small muted">דגש מילולי: ${rng(sc.verbalW.lo, sc.verbalW.hi)} · דגש כמותי: ${rng(sc.quantW.lo, sc.quantW.hi)}. האומדן מניח שהציון במטלת הכתיבה ברמה של החשיבה המילולית, כמו בהסבר שבקובץ הבחינה.</div>`;
  } else {
    html += `<div class="keybox"><b>חסר מפתח תשובות.</b> העלה את הקובץ עם המפתח, או הקלד אותו ידנית.
      <div class="row"><label class="btn secondary">העלאת PDF עם מפתח<input type="file" accept="application/pdf" id="keyfile" hidden></label></div>
      ${st.sections.map((s, i) => s.key ? '' : `<div class="manual">פרק ${s.num} (${s.count} שאלות): <input data-mk="${i}" placeholder="למשל 4312214..." dir="ltr"></div>`).join('')}
      <button class="btn" id="mkSave">שמור מפתח</button></div>`;
  }
  html += `<div class="row exports">
      <button class="btn" id="expJson">ייצוא תחקור (JSON)</button>
      <button class="btn secondary" id="expCsv">ייצוא לטבלה (CSV)</button>
      <button class="btn secondary" id="copy">העתק סיכום</button>
      <button class="btn secondary" id="newExam">סימולציה חדשה</button>
    </div>`;
  rep.sections.forEach((s, i) => {
    const times = s.questions.map(q => q.timeSec);
    const answeredQs = s.questions.filter(q => q.isCorrect != null);
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const avgOk = avg(answeredQs.filter(q => q.isCorrect).map(q => q.timeSec));
    const avgBad = avg(answeredQs.filter(q => !q.isCorrect && q.answer).map(q => q.timeSec));
    const maxT = Math.max(1, ...times);
    const slow = [...s.questions].sort((a, b) => b.timeSec - a.timeSec).slice(0, 3).map(q => q.q);
    html += `
    <section class="sec-review">
      <h2>פרק ${s.num} · ${domainName(s.domain)} ${s.pilot ? '<span class="tag">פיילוט · לא נכלל בציון</span>' : ''}</h2>
      <div class="sec-summary">
        <span><b>${s.correct}/${s.total}</b> נכונות</span>
        <span>ללא תשובה: <b>${s.total - s.answered}</b></span>
        <span>זמן בפועל: <b>${s.timeUsedSec != null ? fmt(s.timeUsedSec * 1000) : '—'}</b> מתוך ${s.minutes}:00 ${s.endedBy === 'user' ? '(סיימת מוקדם)' : ''}</span>
        <span>ממוצע לשאלה נכונה: <b>${fmt(avgOk * 1000)}</b> · לשאלה שגויה: <b>${fmt(avgBad * 1000)}</b></span>
        ${s.otherTimeSec > 5 ? `<span>קטעי קריאה/הוראות: <b>${fmt(s.otherTimeSec * 1000)}</b></span>` : ''}
        <span>האיטיות ביותר: <b>${slow.join(', ')}</b></span>
      </div>
      <table class="qtable"><thead><tr><th>#</th><th>שלי</th><th>נכונה</th><th></th><th>זמן</th><th class="barcol"></th><th>שינויים</th></tr></thead><tbody>
      ${s.questions.map(q => `<tr class="${q.isCorrect == null ? '' : !q.answer ? 'blank' : q.isCorrect ? 'right' : 'wrong'}" data-s="${i}" data-q="${q.q}">
        <td>${q.q}</td><td>${q.answer ?? '—'}</td><td>${q.correct ?? '?'}</td><td>${q.isCorrect == null ? '' : !q.answer ? 'ללא' : q.isCorrect ? '✓' : '✗'}</td>
        <td>${fmt(q.timeSec * 1000)}</td><td class="barcol"><div class="tbar" style="width:${Math.round(100 * q.timeSec / maxT)}%"></div></td><td>${q.changes || ''}</td></tr>`).join('')}
      </tbody></table>
      ${st.sections[i].inlineOk ? '<div class="small muted">לחץ על שורה כדי לראות את השאלה.</div>' : '<div class="small muted">בפרק הזה הזמן נמדד לפי השאלה שנבחרה בסרגל.</div>'}
    </section>`;
  });
  el.innerHTML = html;
  $app.innerHTML = ''; $app.appendChild(el);

  el.querySelector('#expJson').onclick = () => download(`tahkir-${esc(st.exam).slice(0, 40)}-${(st.finishedAt || '').slice(0, 10)}.json`, JSON.stringify(rep, null, 2));
  el.querySelector('#expCsv').onclick = () => download(`tahkir-${(st.finishedAt || '').slice(0, 10)}.csv`, toCSV(rep), 'text/csv');
  el.querySelector('#copy').onclick = async () => {
    const lines = [`סימולציה: ${st.exam} (${(st.finishedAt || '').slice(0, 10)})`];
    if (sc.complete) lines.push(`V ${sc.V} (${sc.vRaw} גלם) · Q ${sc.Q} (${sc.qRaw} גלם) · דו-תחומי ${sc.two.lo}–${sc.two.hi}`);
    rep.sections.forEach(s => lines.push(`פרק ${s.num} ${domainName(s.domain)}${s.pilot ? ' (פיילוט)' : ''}: ${s.correct}/${s.total}, זמן ${s.timeUsedSec != null ? fmt(s.timeUsedSec * 1000) : '—'}, שגויות: ${s.questions.filter(q => q.isCorrect === false).map(q => q.q).join(',') || 'אין'}`));
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('הסיכום הועתק', 2500); } catch { modal(h(`<pre class="copybox">${esc(lines.join('\n'))}</pre>`)); }
  };
  el.querySelector('#newExam').onclick = async () => {
    if (!confirm('להתחיל סימולציה חדשה? התחקור הזה כבר שמור בהיסטוריה.')) return;
    await delPdf(st.id); state = null; localStorage.removeItem(STATE_KEY); pdfDoc = null; render();
  };
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
      st.sections.forEach(s => { const b = blocks.find(k => k.num === s.num); if (b) { s.key = b.key; s.pilot = b.pilot; } });
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
  render();
}
boot();
