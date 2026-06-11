/* 노무 판례 검색기 — 정적(브라우저 전용) 버전.
 * 백엔드 없음: data/cases.json 을 한 번 받아 메모리에서 검색한다.
 * 자연어 분석(parse_query)은 파이썬 nl_search.py 를 그대로 옮긴 것이며,
 * 동의어·불용어·어휘 사전은 cases.json 의 nl 필드에서 주입된다. */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => (s || '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// cases.json 컬럼 인덱스 (publish_web.py COLS 와 일치)
const C = { s:0, d:1, c:2, n:3, t:4, k:5, i:6, m:7, h:8, p:9, ty:10, j:11, l:12 };

const PAGE = 30;
let ROWS = [];          // 원본 행 + 검색용 소문자 필드
let NL = null;          // 검색 사전
let SYN_KEYS = [];      // 동의어 키(긴 것 우선)
let VOCAB = null;       // Set
let STOP = null;        // Set
let PART = [];          // 조사(긴 것 우선)
let VEND = [];          // 동사 어미
let DROP = [];          // 버릴 접미사

const state = { q: '', mode: 'smart', cat: '', court: '', from: '', to: '',
                sort: 'auto', shown: 0, results: [], terms: [] };

/* ── 날짜 표기 ── */
function fmtDate(d) {
  d = (d || '').trim();
  if (d === '00010101') return '(미상)';
  if (d.length === 8 && /^\d+$/.test(d)) return `${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6,8)}`;
  return d;
}

/* ── 자연어 분석 (nl_search.parse_query 포팅) ── */
function vocabPrefix(tok) {
  for (let ln = Math.min(tok.length, 7); ln > 1; ln--) {
    if (VOCAB.has(tok.slice(0, ln))) return tok.slice(0, ln);
  }
  return '';
}
function stripParticles(tok) {
  for (const p of PART) {
    if (tok.endsWith(p) && tok.length - p.length >= 2) return tok.slice(0, tok.length - p.length);
  }
  return tok;
}
function parseQuery(q) {
  const terms = [];
  const add = t => { if (t && !terms.includes(t)) terms.push(t); };
  const toks = (q || '').match(/[0-9A-Za-z가-힣]+/g) || [];
  for (const tok of toks) {
    if (tok.length < 2 || STOP.has(tok)) continue;
    if (/^\d+$/.test(tok) && tok.length < 5) continue;
    // 1) 동의어
    let matched = false;
    for (const key of SYN_KEYS) {
      if (tok === key || tok.startsWith(key)) { for (const t of NL.syn[key]) add(t); matched = true; break; }
    }
    if (matched) continue;
    // 2) 도메인 어휘 접두사
    let v = vocabPrefix(tok);
    if (v) { add(v); if (v.length > 2 && VOCAB.has(v.slice(0, 2))) add(v.slice(0, 2)); continue; }
    // 3) 조사 → 동사 어미 제거 후 재시도
    let cand = stripParticles(tok);
    for (const end of VEND) {
      if (cand.endsWith(end) && cand.length - end.length >= 2) { cand = cand.slice(0, cand.length - end.length); break; }
    }
    if (STOP.has(cand) || cand.length < 2) continue;
    v = vocabPrefix(cand);
    if (v) { add(v); if (v.length > 2 && VOCAB.has(v.slice(0, 2))) add(v.slice(0, 2)); continue; }
    // 4) 모르는 단어: 동사 냄새면 버리고 아니면 그대로
    if (DROP.some(suf => cand.endsWith(suf))) continue;
    add(cand);
  }
  return terms.slice(0, 10);
}

/* ── 검색 ── */
function passFilters(r) {
  if (state.cat && r[C.k] !== state.cat) return false;
  if (state.court === '대법원' && !(r[C.c] || '').includes('대법원')) return false;
  if (state.court === '하급심' && ((r[C.c] || '').includes('대법원') || !r[C.c])) return false;
  const d = r[C.d] || '';
  if (state.from && !(d.length === 8 && d >= state.from)) return false;
  if (state.to && !(d.length === 8 && d <= state.to)) return false;
  return true;
}

// 필드 가중치 (파이썬 BM25 의도와 동일 순서: 사건번호>사건명>이슈>요지>판시)
function scoreRow(r, terms) {
  let score = 0, hit = false;
  for (const term of terms) {
    let s = 0;
    if (r._t.includes(term)) s += 8;
    if (r._n.includes(term)) s += 10;
    if (r._i.includes(term)) s += 6;
    if (r._m.includes(term)) s += 5;
    if (r._h.includes(term)) s += 5;
    if (r._p.includes(term)) s += 5;
    if (s > 0) { hit = true; score += s; }
  }
  if (!hit) return -1;
  const d = r[C.d] || '';
  if (d === '00010101' || d === '') score -= 2;
  else if (d >= '20200101') score += 2;
  else if (d >= '20100101') score += 1;
  return score;
}

function runSearch() {
  const q = state.q.trim();
  let results, terms = [], sort = state.sort;

  if (!q) {
    terms = [];
    results = ROWS.filter(passFilters);
    if (sort === 'auto') sort = 'date';
  } else if (state.mode === 'exact') {
    const ql = q.toLowerCase();
    results = ROWS.filter(r => passFilters(r) && r._hay.includes(ql));
    if (sort === 'auto') sort = 'date';
  } else {
    terms = parseQuery(q);
    if (sort === 'auto') sort = terms.length ? 'rel' : 'date';
    const lower = terms.map(t => t.toLowerCase());
    results = [];
    for (const r of ROWS) {
      if (!passFilters(r)) continue;
      const sc = scoreRow(r, lower);
      if (sc >= 0) { r._score = sc; results.push(r); }
    }
  }

  if (sort === 'rel') results.sort((a, b) => (b._score - a._score) || ((b[C.d] || '') > (a[C.d] || '') ? 1 : -1));
  else results.sort((a, b) => ((b[C.d] || '') > (a[C.d] || '') ? 1 : (b[C.d] || '') < (a[C.d] || '') ? -1 : 0));

  state.results = results;
  state.terms = terms;
  state.shown = 0;
  state.effSort = sort;

  renderChips(terms);
  $('total').textContent = `총 ${results.length.toLocaleString()}건`;
  $('totalDesc').textContent = sort === 'rel' ? '관련도순 (질문과 가까운 판례부터)' : '최신 선고일순';
  $('list').innerHTML = '';
  if (results.length === 0) {
    $('list').innerHTML = '<div class="empty">결과가 없습니다.<br>표현을 바꾸거나(<b>스마트 검색</b> 추천) 필터를 풀어보세요.</div>';
    $('btnMore').style.display = 'none';
    return;
  }
  appendPage();
}

function appendPage() {
  const frag = document.createDocumentFragment();
  const slice = state.results.slice(state.shown, state.shown + PAGE);
  slice.forEach(r => frag.appendChild(card(r)));
  $('list').appendChild(frag);
  state.shown += slice.length;
  $('btnMore').style.display = state.shown < state.results.length ? 'block' : 'none';
}

function renderChips(terms) {
  $('chips').innerHTML = (terms && terms.length)
    ? '인식된 키워드 → ' + terms.map(t => `<span class="chip">${esc(t)}</span>`).join('')
    : '';
}

function card(r) {
  const d = document.createElement('div');
  d.className = 'card';
  const sup = (r[C.c] || '').includes('대법원');
  d.innerHTML = `
    <div class="badges">
      <span class="badge b-date">${esc(fmtDate(r[C.d]))}</span>
      <span class="badge b-court ${sup ? 'sup' : ''}">${esc(r[C.c] || '법원 미상')}</span>
      ${r[C.j] ? `<span class="badge b-court">${esc(r[C.j])}</span>` : ''}
      <span class="badge b-cat">${esc(r[C.k])}${r[C.i] ? ' · ' + esc(r[C.i]) : ''}</span>
    </div>
    <h3>${esc(r[C.t] || '(사건명 없음)')}</h3>
    <div class="sub">${esc(r[C.n])}</div>
    ${r[C.m] ? `<div class="summ">${esc(r[C.m])}</div>` : ''}`;
  d.onclick = () => openCase(r);
  return d;
}

/* ── 상세 드로어 ── */
function openCase(r) {
  $('overlay').classList.add('on'); $('drawer').classList.add('on');
  $('dTitle').textContent = r[C.t] || '(사건명 없음)';
  $('dMeta').textContent = [r[C.c], r[C.n], r[C.d] ? '선고 ' + fmtDate(r[C.d]) : '', r[C.ty], r[C.j]]
    .filter(Boolean).join('  ·  ');
  $('dLink').style.display = r[C.l] ? '' : 'none';
  $('dLink').href = r[C.l] || '#';
  let h = '';
  if (r[C.m]) h += `<div class="d-summline"><b>한줄 요약</b> · ${esc(r[C.m])}</div>`;
  const sec = (t, x) => x ? `<div class="d-sec"><h4>${t}</h4><div class="tx">${esc(x)}</div></div>` : '';
  h += sec('판시사항', r[C.p]);
  h += sec('판결요지', r[C.h]);
  if (!r[C.p] && !r[C.h]) {
    h += `<div class="d-note">이 판례는 요지가 아직 수록되지 않았습니다. 아래 <b>[원문 열기]</b>로 법제처에서 전체 판결문을 확인하세요.</div>`;
  } else {
    h += `<div class="d-note">전체 판결문은 <b>[원문 열기]</b>로 법제처에서 볼 수 있습니다.</div>`;
  }
  $('dBody').innerHTML = h;
}
function closeCase() { $('overlay').classList.remove('on'); $('drawer').classList.remove('on'); }

/* ── CSV 내보내기 (현재 검색 결과 전체) ── */
function exportCsv() {
  if (!state.results.length) { alert('내보낼 검색 결과가 없습니다.'); return; }
  const head = ['선고일자', '법원', '사건번호', '사건명', '카테고리', '이슈', '요약', '원문링크'];
  const cell = v => {
    v = (v == null ? '' : String(v)).replace(/"/g, '""');
    return /[",\n]/.test(v) ? `"${v}"` : v;
  };
  const lines = [head.join(',')];
  for (const r of state.results) {
    lines.push([fmtDate(r[C.d]), r[C.c], r[C.n], r[C.t], r[C.k], r[C.i], r[C.m], r[C.l]]
      .map(cell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '노무판례.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── 데이터 로드 ── */
async function load() {
  let data;
  try {
    const r = await fetch('./data/cases.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    $('list').innerHTML = `<div class="empty">데이터를 불러오지 못했습니다 — ${esc(e.message)}<br>data/cases.json 파일이 함께 업로드됐는지 확인해 주세요.</div>`;
    return;
  }
  NL = data.nl;
  VOCAB = new Set(NL.vocab);
  STOP = new Set(NL.stop);
  PART = [...NL.part].sort((a, b) => b.length - a.length);
  VEND = NL.vend;
  DROP = NL.drop;
  SYN_KEYS = Object.keys(NL.syn).sort((a, b) => b.length - a.length);

  ROWS = data.rows.map(r => {
    r._t = (r[C.t] || '').toLowerCase();
    r._n = (r[C.n] || '').toLowerCase();
    r._i = (r[C.i] || '').toLowerCase();
    r._m = (r[C.m] || '').toLowerCase();
    r._h = (r[C.h] || '').toLowerCase();
    r._p = (r[C.p] || '').toLowerCase();
    r._hay = r._t + ' ' + r._n + ' ' + r._i + ' ' + r._m + ' ' + r._h + ' ' + r._p;
    return r;
  });

  // 카테고리 옵션 + 통계
  const counts = {};
  data.cats.forEach(c => counts[c] = 0);
  ROWS.forEach(r => { if (r[C.k] in counts) counts[r[C.k]]++; });
  const fcat = $('fCat');
  data.cats.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = `${c} (${(counts[c] || 0).toLocaleString()})`;
    fcat.appendChild(o);
  });
  $('stats').innerHTML = `판례 <b>${data.count.toLocaleString()}</b>건 · 데이터 기준일 ${esc(data.generated)}`;

  bindEvents();
  runSearch();
}

/* ── 이벤트 ── */
function setMode(m) {
  state.mode = m;
  $('mSmart').classList.toggle('on', m === 'smart');
  $('mExact').classList.toggle('on', m === 'exact');
  if (state.q) runSearch();
}
function bindEvents() {
  $('btnSearch').onclick = () => { state.q = $('q').value.trim(); runSearch(); };
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnSearch').click(); });
  $('mSmart').onclick = () => setMode('smart');
  $('mExact').onclick = () => setMode('exact');
  ['fCat', 'fCourt', 'fSort'].forEach(id => $(id).onchange = () => {
    state.cat = $('fCat').value; state.court = $('fCourt').value; state.sort = $('fSort').value;
    runSearch();
  });
  ['fFrom', 'fTo'].forEach(id => $(id).onchange = () => {
    state.from = $('fFrom').value.replace(/-/g, '');
    state.to = $('fTo').value.replace(/-/g, '');
    runSearch();
  });
  $('btnReset').onclick = () => {
    ['fCat', 'fCourt', 'fFrom', 'fTo'].forEach(id => $(id).value = '');
    $('fSort').value = 'auto'; $('q').value = '';
    Object.assign(state, { q: '', cat: '', court: '', from: '', to: '', sort: 'auto' });
    runSearch();
  };
  $('btnMore').onclick = appendPage;
  $('btnCsv').onclick = exportCsv;
  $('overlay').onclick = closeCase;
  $('dClose').onclick = closeCase;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCase(); });
}

load();
