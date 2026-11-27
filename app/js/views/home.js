import { TENSE_GROUPS, appActions, contentStore, el, foldMarks, isHttpOrigin, makeUUID, normNFC, parseCardKey, placementState, session, showToast, userStore } from '../state.js';
import { createBlankCardRecord, fnvHash } from '../fsrs.js';
import { ensureDailyRollover, getLemmaBucket, getStudiedBaseLemmaIds, idbBatchCards, idbPut, isCardDueNow, isPackLoadedOrAvailable, pickBestExample, saveMeta, saveSettings } from '../storage.js';

/* ==========================================================================
   13. HOME RENDERING, PLACEMENT TEST & CHECK KNOWN (20)
   ========================================================================== */
export function renderHomeFileChecklist() {
  const box = el('home-file-checklist');
  box.textContent = '';

  const rows = [];
  const hasManifest = Boolean(contentStore.manifest);
  const hasLexicon = Boolean(contentStore.lexicon && contentStore.orderedEntries.length > 0);
  const hasCurriculum = Boolean(contentStore.curriculum);
  const hasAmbiguous = Boolean(contentStore.ambiguous);

  rows.push({ name: 'manifest.json', ok: hasManifest, meta: hasManifest ? `schema ${contentStore.manifest.schema || 3} · v${contentStore.manifest.manifestVersion || '3.1'}` : 'Missing' });
  rows.push({ name: 'lexicon.json', ok: hasLexicon, meta: hasLexicon ? `${contentStore.orderedEntries.length} words` : 'Missing' });
  rows.push({ name: 'curriculum.json', ok: hasCurriculum, meta: hasCurriculum ? `${(contentStore.curriculum.units || []).length} units` : 'Missing' });
  rows.push({ name: 'ambiguous.json', ok: hasAmbiguous, meta: hasAmbiguous ? `${Object.keys(contentStore.ambiguous.diacriticCollisions || {}).length} diacritic · ${Object.keys(contentStore.ambiguous.phoneticCollisions || {}).length} phonetic` : 'Missing' });

  const packDefs = (contentStore.manifest && contentStore.manifest.packs) || [];
  const shownPacks = new Set();
  for (const p of packDefs) {
    const path = p.file || `packs/${p.id}.json`;
    const uploaded = contentStore.customFiles.has(path) || contentStore.availablePackIds.has(p.id);
    if (!p.hash && !uploaded) continue;
    shownPacks.add(p.id);
    const cached = contentStore.customFiles.get(path) || (contentStore.packCache.get(path) && contentStore.packCache.get(path).data);
    const cnt = (cached && cached.examples && cached.examples.length) || p.exampleCount || 0;
    rows.push({ name: path, ok: uploaded || (Boolean(p.hash) && isHttpOrigin()), meta: cnt ? `${cnt} ex` : 'Ready' });
  }
  for (const [path, data] of contentStore.customFiles.entries()) {
    if (path.startsWith('packs/') && data && data.packId && !shownPacks.has(data.packId)) {
      rows.push({ name: path, ok: true, meta: `${(data.examples || []).length} ex` });
    }
  }

  const extDefs = (contentStore.manifest && contentStore.manifest.extensions) || [];
  for (const e of extDefs) {
    const path = e.file || `extensions/${e.id}.json`;
    const uploaded = contentStore.customFiles.has(path) || contentStore.availableExtIds.has(e.id);
    if (!e.hash && !uploaded) continue;
    const cached = contentStore.customFiles.get(path) || (contentStore.packCache.get(path) && contentStore.packCache.get(path).data);
    const cnt = (cached && cached.examples && cached.examples.length) || e.exampleCount || 0;
    rows.push({ name: path, ok: uploaded || (Boolean(e.hash) && isHttpOrigin()), meta: cnt ? `${cnt} ex` : 'Ready' });
  }

  let okCount = 0;
  rows.forEach(r => {
    if (r.ok) okCount++;
    const rowEl = document.createElement('div');
    rowEl.className = 'file-row';
    const left = document.createElement('div');
    left.className = 'file-row-left';
    const dot = document.createElement('span');
    dot.className = `file-dot ${r.ok ? 'ok' : 'miss'}`;
    const nm = document.createElement('span');
    nm.className = 'file-name'; nm.textContent = r.name;
    left.append(dot, nm);
    const meta = document.createElement('span');
    meta.className = 'file-meta'; meta.textContent = r.meta;
    rowEl.append(left, meta);
    box.appendChild(rowEl);
  });

  const badge = el('home-files-status');
  const canStudy = hasLexicon && (contentStore.legacyMode || contentStore.availablePackIds.size > 0 || Array.from(contentStore.customFiles.keys()).some(k => k.startsWith('packs/')) || (hasManifest && isHttpOrigin() && packDefs.some(p => p.hash)));
  if (canStudy && okCount === rows.length) { badge.className = 'badge badge-emerald'; badge.textContent = 'Ready'; }
  else if (canStudy) { badge.className = 'badge badge-amber'; badge.textContent = 'Partial'; }
  else { badge.className = 'badge badge-rose'; badge.textContent = 'Missing Files'; }
}

export const SESSION_PRESETS = [10, 20, 30];

export function normalizeSessionSize(raw) {
  const n = Number(raw);
  return SESSION_PRESETS.includes(n) ? n : 20;
}

export function computeSessionDurationEstimate(cardCount, opts = {}) {
  const n = Math.max(1, Number(cardCount) || 20);
  const fixOn = opts.enableFixRound !== undefined ? Boolean(opts.enableFixRound) : (userStore.settings.enableFixRound !== false);
  const modes = Array.isArray(opts.finaleModes)
    ? opts.finaleModes
    : (Array.isArray(userStore.settings.finaleModes) ? userStore.settings.finaleModes : ['blind', 'recall']);
  const recallOn = modes.includes('recall');
  const blindOn = modes.includes('blind');
  const walk = opts.walkMode !== undefined ? Boolean(opts.walkMode) : Boolean(userStore.settings.walkMode);
  const baseMinSec = walk ? 11 : 17;
  const baseMaxSec = walk ? 16 : 24;
  let minSec = n * baseMinSec;
  let maxSec = n * baseMaxSec;
  if (fixOn) { minSec += n * 3.5; maxSec += n * 6; }
  if (recallOn) { minSec += n * 4; maxSec += n * 6.5; }
  if (blindOn) { minSec += Math.min(n, 8) * 5.5; maxSec += Math.min(n, 8) * 8; }
  const minMins = Math.max(1, Math.round(minSec / 60));
  const maxMins = Math.max(minMins + 1, Math.round(maxSec / 60));
  const approxMins = Math.max(1, Math.round((minSec + maxSec) / 120));
  return { minMins, maxMins, approxMins, label: `~${minMins}-${maxMins} min`, approxLabel: `~${approxMins} min` };
}

let segThumbInitialized = false;

export function syncSessionSegThumb(animate = true) {
  const track = el('home-len-chips');
  const thumb = el('home-len-thumb');
  if (!track || !thumb) return;
  const active = Array.from(track.querySelectorAll('.chip')).find(b => b.classList.contains('active'));
  if (!active) return;
  const w = Number(active.offsetWidth) || 0;
  const x = Number(active.offsetLeft) || 0;
  if (w <= 0) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => syncSessionSegThumb(false));
    }
    return;
  }
  if (!animate) {
    thumb.style.transition = 'none';
  }
  thumb.style.width = `${w}px`;
  thumb.style.transform = `translateX(${x}px)`;
  if (!animate) {
    void thumb.offsetWidth;
    thumb.style.transition = '';
  }
  segThumbInitialized = true;
}

let afterPillRanges = [null, null];
let afterPillsInitialized = false;
let prevAfterTuple = null;
let afterAnimGen = 0;
let afterNormalizeTimer = null;

function placeAfterPill(pill, btns, startIdx, endIdx, snap) {
  const first = btns[startIdx];
  const last = btns[endIdx];
  const left = Number(first.offsetLeft) || 0;
  const lastW = Number(last.offsetWidth) || 0;
  const width = lastW > 0 ? ((Number(last.offsetLeft) || 0) + lastW - left) : 0;
  pill.dataset.range = `${startIdx}-${endIdx}`;
  if (width <= 0) {
    pill.style.opacity = '1';
    return false;
  }
  if (snap) pill.style.transition = 'none';
  pill.style.width = `${width}px`;
  pill.style.transform = `translateX(${left}px)`;
  if (snap) {
    void pill.offsetWidth;
    pill.style.transition = '';
  }
  pill.style.opacity = '1';
  return true;
}

export function updateAfterPills(animate = true) {
  const track = el('home-post-toggles');
  const pills = [el('after-pill-0'), el('after-pill-1')];
  if (!track || !pills[0] || !pills[1]) return;
  const btns = Array.from(track.querySelectorAll('[data-post-mode]'));
  if (!btns.length) return;

  if (afterNormalizeTimer) {
    clearTimeout(afterNormalizeTimer);
    afterNormalizeTimer = null;
  }
  const gen = ++afterAnimGen;

  const curTuple = btns.map(b => b.classList.contains('active'));
  const curKey = curTuple.map(Number).join('');
  const prevKey = prevAfterTuple ? prevAfterTuple.map(Number).join('') : null;

  // Case A: Center-fill merge (101 -> 111) - both sides meet in the middle symmetrically
  if (animate && prevKey === '101' && curKey === '111') {
    const ok0 = placeAfterPill(pills[0], btns, 0, 1, false);
    const ok1 = placeAfterPill(pills[1], btns, 1, 2, false);
    afterPillRanges = [[0, 1], [1, 2]];
    prevAfterTuple = curTuple;
    if (!ok0 || !ok1) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => updateAfterPills(false));
    } else if (typeof setTimeout === 'function' && typeof pills[0].getBoundingClientRect === 'function') {
      afterNormalizeTimer = setTimeout(() => {
        afterNormalizeTimer = null;
        if (gen !== afterAnimGen) return;
        placeAfterPill(pills[0], btns, 0, 2, true);
        pills[1].style.opacity = '0';
        pills[1].dataset.range = '';
        afterPillRanges = [[0, 2], null];
      }, 300);
    }
    afterPillsInitialized = true;
    return;
  }

  // Case B: Center-split (111 -> 101) - seed both halves at center and split outward symmetrically
  if (animate && prevKey === '111' && curKey === '101') {
    const okSeed0 = placeAfterPill(pills[0], btns, 0, 1, true);
    const okSeed1 = placeAfterPill(pills[1], btns, 1, 2, true);
    if (typeof track.getBoundingClientRect === 'function') void track.offsetWidth;
    const ok0 = placeAfterPill(pills[0], btns, 0, 0, false);
    const ok1 = placeAfterPill(pills[1], btns, 2, 2, false);
    afterPillRanges = [[0, 0], [2, 2]];
    prevAfterTuple = curTuple;
    if ((!okSeed0 || !okSeed1 || !ok0 || !ok1) && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => updateAfterPills(false));
    }
    afterPillsInitialized = true;
    return;
  }

  const runs = [];
  let curStart = null;
  curTuple.forEach((on, i) => {
    if (on && curStart === null) curStart = i;
    else if (!on && curStart !== null) {
      runs.push([curStart, i - 1]);
      curStart = null;
    }
  });
  if (curStart !== null) runs.push([curStart, btns.length - 1]);

  const assigned = [null, null];
  const remaining = [];
  const overlaps = (a, b) => a && b && a[0] <= b[1] && b[0] <= a[1];

  for (const run of runs) {
    let matched = -1;
    for (let p = 0; p < 2; p++) {
      if (assigned[p] === null && overlaps(afterPillRanges[p], run)) {
        matched = p;
        break;
      }
    }
    if (matched !== -1) assigned[matched] = run;
    else remaining.push(run);
  }
  for (const run of remaining) {
    const freeIdx = assigned[0] === null ? 0 : (assigned[1] === null ? 1 : -1);
    if (freeIdx !== -1) assigned[freeIdx] = run;
  }

  let needsReflowRetry = false;
  for (let p = 0; p < 2; p++) {
    const pill = pills[p];
    const run = assigned[p];
    const wasVisible = afterPillRanges[p] !== null;
    if (!run) {
      pill.style.opacity = '0';
      pill.dataset.range = '';
      afterPillRanges[p] = null;
      continue;
    }
    const snap = !animate || !wasVisible;
    const ok = placeAfterPill(pill, btns, run[0], run[1], snap);
    afterPillRanges[p] = run;
    if (!ok) needsReflowRetry = true;
  }
  prevAfterTuple = curTuple;
  if (needsReflowRetry && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => updateAfterPills(false));
  }
  afterPillsInitialized = true;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    syncSessionSegThumb(false);
    updateAfterPills(false);
  });
}

export function openSessionOptionsSheet() {
  const sheet = el('sheet-session-options');
  if (!sheet) return;
  const panel = typeof sheet.querySelector === 'function' ? sheet.querySelector('.session-options-sheet') : null;
  if (panel) {
    panel.style.transition = '';
    panel.style.transform = '';
  }
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  if (typeof sheet.getBoundingClientRect === 'function') {
    void sheet.offsetWidth;
  }
  sheet.classList.add('is-open');
  syncSessionSegThumb(false);
  updateAfterPills(false);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      syncSessionSegThumb(false);
      updateAfterPills(false);
    });
  }
}

export function closeSessionOptionsSheet() {
  const sheet = el('sheet-session-options');
  if (!sheet) return;
  const panel = typeof sheet.querySelector === 'function' ? sheet.querySelector('.session-options-sheet') : null;
  if (panel) {
    panel.style.transition = '';
    if (panel.style.transform) {
      if (typeof panel.getBoundingClientRect === 'function') void panel.offsetWidth;
      panel.style.transform = '';
    }
  }
  sheet.classList.remove('is-open');
  sheet.setAttribute('aria-hidden', 'true');
}

export function bindSessionOptionsDrag() {
  const sheet = el('sheet-session-options');
  const zone = el('session-options-drag-zone');
  if (!sheet || !zone || typeof zone.addEventListener !== 'function') return;
  let startY = null;
  let lastDy = 0;
  let snapTimer = null;
  const getPanel = () => (typeof sheet.querySelector === 'function' ? sheet.querySelector('.session-options-sheet') : null);
  zone.addEventListener('touchstart', e => {
    if (!e.touches || e.touches.length !== 1) return;
    if (e.target && (e.target.id === 'btn-session-options-done' || (typeof e.target.closest === 'function' && e.target.closest('button')))) return;
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
    startY = e.touches[0].clientY;
    lastDy = 0;
  }, { passive: true });
  zone.addEventListener('touchmove', e => {
    if (startY === null || !e.touches || e.touches.length !== 1) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    lastDy = dy;
    if (dy <= 4) return;
    const panel = getPanel();
    if (panel) {
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });
  const finishDrag = () => {
    if (startY === null) return;
    const dy = lastDy;
    startY = null;
    lastDy = 0;
    const panel = getPanel();
    if (dy > 80) {
      closeSessionOptionsSheet();
    } else if (dy > 4 && panel) {
      panel.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
      panel.style.transform = 'translateY(0)';
      if (typeof setTimeout === 'function') {
        snapTimer = setTimeout(() => {
          snapTimer = null;
          panel.style.transition = '';
          panel.style.transform = '';
        }, 290);
      }
    }
  };
  zone.addEventListener('touchend', finishDrag);
  zone.addEventListener('touchcancel', finishDrag);
}

export function renderHome() {
  ensureDailyRollover();
  renderHomeFileChecklist();

  const total = contentStore.orderedEntries.length;
  const hasPlayable = total > 0 && (contentStore.legacyMode || contentStore.availablePackIds.size > 0 ||
    Array.from(contentStore.customFiles.keys()).some(k => k.startsWith('packs/')) ||
    (contentStore.manifest && isHttpOrigin() && (contentStore.manifest.packs || []).some(p => p.hash)));

  el('home-dashboard').classList.toggle('hidden', !hasPlayable);

  const paused = hasPlayable ? userStore.activeSession : null;
  if (paused && paused.activeCardKey && contentStore.entriesById.has(parseCardKey(paused.activeCardKey).lemmaId)) {
    el('home-resume-card').classList.remove('hidden');
    const goalTxt = `${paused.targetCount || 20} cards`;
    el('home-resume-sub').textContent = `${paused.reviewedCount} done of ${goalTxt}`;
  } else {
    el('home-resume-card').classList.add('hidden');
  }

  if (!hasPlayable) return;

  let toLearn = 0, learning = 0, reviewCount = 0, knownCount = 0, assumedCount = 0, dueNow = 0;
  const now = Date.now();
  for (const entry of contentStore.orderedEntries) {
    const b = getLemmaBucket(entry);
    if (b === 'to_learn') toLearn++;
    else if (b === 'learning') learning++;
    else if (b === 'review') reviewCount++;
    else if (b === 'known') knownCount++;
    else if (b === 'assumed') assumedCount++;
    const rec = userStore.cards.get(entry.id);
    if (rec && isPackLoadedOrAvailable(entry.packId) && isCardDueNow(rec, now)) dueNow++;
  }

  const studiedIds = getStudiedBaseLemmaIds();
  const studiedTotal = studiedIds.length;
  el('val-due').textContent = String(dueNow);
  el('val-learning').textContent = String(reviewCount);
  el('val-mastered').textContent = String(knownCount);
  const pct = total > 0 ? Math.min(100, Math.round((studiedTotal / total) * 100)) : 0;
  const cpTxt = el('home-course-progress-text');
  const cpFill = el('home-course-progress-fill');
  if (cpTxt) cpTxt.textContent = `${studiedTotal.toLocaleString()} / ${total.toLocaleString()}`;
  if (cpFill) cpFill.style.width = `${pct}%`;
  renderCoverageCurve(studiedTotal, studiedTotal, true);

  const dailyGoal = Math.max(1, Number(userStore.settings.dailyNewLimit) || 10);
  const newDone = Number(userStore.today.newLemmas || 0);
  const dailyPct = Math.min(100, Math.round((newDone / dailyGoal) * 100));
  el('home-due-line').textContent = 'New today';
  if (el('home-daily-goal-rem')) {
    el('home-daily-goal-rem').textContent = `${newDone} / ${dailyGoal}`;
  }
  if (el('home-daily-goal-bar')) el('home-daily-goal-bar').setAttribute('aria-valuenow', String(dailyPct));
  if (el('home-daily-goal-fill')) {
    el('home-daily-goal-fill').style.width = `${dailyPct}%`;
    el('home-daily-goal-fill').classList.toggle('complete', dailyPct >= 100);
  }

  const len = normalizeSessionSize(userStore.settings.sessionSize);
  userStore.settings.sessionSize = len;
  el('btn-start-label').textContent = 'Start Session';
  el('home-len-chips').querySelectorAll('.chip').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.len) === len);
  });
  syncSessionSegThumb(segThumbInitialized);

  const activeModes = Array.isArray(userStore.settings.finaleModes) ? userStore.settings.finaleModes : ['blind', 'recall'];
  const postToggles = el('home-post-toggles');
  if (postToggles) {
    const modeStates = {
      fix: userStore.settings.enableFixRound !== false,
      recall: activeModes.includes('recall'),
      blind: activeModes.includes('blind')
    };
    const btns = Array.from(postToggles.querySelectorAll('[data-post-mode]'));
    btns.forEach(btn => {
      const m = btn.dataset.postMode;
      const isOn = Boolean(modeStates[m]);
      btn.classList.toggle('active', isOn);
      btn.setAttribute('aria-pressed', String(isOn));
    });
    updateAfterPills(afterPillsInitialized);
  }
  const estObj = computeSessionDurationEstimate(len);
  const durEl = el('home-duration-est');
  if (durEl) durEl.textContent = estObj.label;
  const sheetEst = el('sheet-session-est');
  if (sheetEst) {
    if (sheetEst.textContent !== estObj.approxLabel) {
      sheetEst.textContent = estObj.approxLabel;
      if (typeof setTimeout === 'function' && typeof sheetEst.getBoundingClientRect === 'function') {
        sheetEst.classList.add('est-pulse');
        setTimeout(() => sheetEst.classList.remove('est-pulse'), 140);
      }
    }
  }
  if (typeof appActions.renderHomeDrillRec === 'function') appActions.renderHomeDrillRec();

  const walk = userStore.settings.walkMode;
  el('toggle-walk').classList.toggle('on', walk);
  el('toggle-walk').setAttribute('aria-checked', String(walk));

  // Show Check Known (20) when Assumed > 0
  const ckBtn = el('btn-check-known');
  ckBtn.classList.toggle('hidden', assumedCount === 0);
  if (assumedCount > 0) ckBtn.textContent = `Check Known (${Math.min(20, assumedCount)})`;
}


/* ==========================================================================
   13B. INTERACTIVE VOCABULARY COVERAGE CURVE (ZIPFIAN + ZERO-REFLOW PREVIEW)
   ========================================================================== */
export const COVERAGE_PREVIEW_PT = 'Com poucas palavras certas, você já consegue acompanhar quase tudo numa conversa comum no Brasil. Quando domina as primeiras mil expressões do dia a dia, filmes, podcasts e mensagens ficam bem mais claros. Depois de três mil termos, seu cérebro preenche lacunas sem esforço, capta gírias, nuances e ironias, e falar português vira um hábito natural e espontâneo.';

export const COV_LOG_K = 6.0;
export const COV_LOG_DENOM = Math.log(1 + 5000 / COV_LOG_K);

export function wordsToCoverageFloat(words) {
  const w = Math.max(0, Math.min(5000, Number(words) || 0));
  if (w <= 0) return 0;
  return 86 * (Math.log(1 + w / COV_LOG_K) / COV_LOG_DENOM);
}

export function wordsToCoveragePct(words) {
  return Math.round(wordsToCoverageFloat(words));
}

export const COVERAGE_LEMMA_FALLBACKS = {
  as: { lemma: 'o', maxRank: 15 },
  numa: { lemma: 'em', maxRank: 80 },
  poucas: { lemma: 'pouco', maxRank: 320 },
  primeiras: { lemma: 'primeiro', maxRank: 260 },
  certas: { lemma: 'certo', maxRank: 340 },
  claros: { lemma: 'claro', maxRank: 360 },
  brasil: { lemma: null, maxRank: 220 },
  capta: { lemma: 'captar', maxRank: 2800 },
  filmes: { lemma: 'filme', maxRank: 900 },
  mensagens: { lemma: 'mensagem', maxRank: 1100 },
  termos: { lemma: 'termo', maxRank: 1400 },
  expressoes: { lemma: 'expressao', maxRank: 1600 }
};

export let coveragePreviewBuiltLexLen = -1;
export let coverageWordSpans = [];
export let coverageLastUserWords = 0;

export function resolveCoverageTokenRank(word) {
  const norm = normNFC(word);
  const folded = foldMarks(norm);
  const lookupFolded = targetFolded => {
    let best = Infinity;
    const consider = entry => {
      if (!entry) return;
      const r = Number(entry.freqRank) || (Number(entry.curriculumIndex) + 1) || 9999;
      if (r < best) best = r;
    };
    const hitIds = contentStore.surfaceIndex.get(targetFolded);
    if (hitIds) hitIds.forEach(id => consider(contentStore.entriesById.get(id)));
    if (best === Infinity && contentStore.orderedEntries.length > 0) {
      for (const e of contentStore.orderedEntries) {
        if (foldMarks(e.lemma) === targetFolded) { consider(e); break; }
      }
    }
    return best;
  };

  let bestRank = lookupFolded(folded);
  if (bestRank < Infinity) return bestRank;

  const fb = COVERAGE_LEMMA_FALLBACKS[folded];
  if (fb) {
    if (fb.lemma) {
      const mappedRank = lookupFolded(fb.lemma);
      if (mappedRank < Infinity) return Math.min(mappedRank, fb.maxRank);
    }
    return fb.maxRank;
  }

  // Deterministic realistic > 5000 rank for advanced/loan words not in top 5,000
  return 5200 + Math.floor(fnvHash(`cov:${folded}`) * 1200);
}

export function tokenizeCoverageParagraph(text) {
  const tokens = [];
  const re = /([\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*)|([^\p{L}\p{M}]+)/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push({ isWord: true, text: m[1] });
    else tokens.push({ isWord: false, text: m[2] });
  }
  return tokens;
}

export function ensureCoverageChartPaths() {
  const strokeEl = el('cov-stroke-path');
  const areaFull = el('cov-area-full');
  const areaAct = el('cov-area-active');
  if (!strokeEl || !areaFull || !areaAct) return;
  if (strokeEl.getAttribute('d')) return;
  const x0 = 0, x1 = 300, y0 = 106, y1 = 4;
  // 130 smooth floating-point samples (extra dense in 0..500 steep rise)
  const sampleWords = [];
  for (let i = 0; i <= 50; i++) sampleWords.push((i / 50) * 500);
  for (let i = 1; i <= 80; i++) sampleWords.push(500 + (i / 80) * 4500);
  const pts = sampleWords.map(w => {
    const pct = wordsToCoverageFloat(w);
    const x = x0 + (w / 5000) * (x1 - x0);
    const y = y0 - (pct / 100) * (y0 - y1);
    return [x.toFixed(2), y.toFixed(2)];
  });
  const lineD = pts.map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt[0]} ${pt[1]}`).join(' ');
  const areaD = `${lineD} L${x1} ${y0} L${x0} ${y0} Z`;
  strokeEl.setAttribute('d', lineD);
  areaFull.setAttribute('d', areaD);
  areaAct.setAttribute('d', areaD);
}

export function ensureCoveragePreviewMounted() {
  const box = el('coverage-preview-text');
  if (!box) return;
  const curLexLen = contentStore.orderedEntries.length;
  if (coverageWordSpans.length > 0 && coveragePreviewBuiltLexLen === curLexLen) return;
  coveragePreviewBuiltLexLen = curLexLen;
  box.textContent = '';
  coverageWordSpans = [];
  const tokens = tokenizeCoverageParagraph(COVERAGE_PREVIEW_PT);
  tokens.forEach(tok => {
    if (!tok.isWord) {
      box.appendChild(document.createTextNode(tok.text));
    } else {
      const sp = document.createElement('span');
      sp.className = 'cov-word';
      const rank = resolveCoverageTokenRank(tok.text);
      sp.dataset.rank = String(rank);
      sp.textContent = tok.text;
      coverageWordSpans.push(sp);
      box.appendChild(sp);
    }
  });
}

export let coverageCurrentWords = 0;
export let coverageAnimRafId = null;

export function easeCubicBezier(t, x1 = 0.22, y1 = 1, x2 = 0.36, y2 = 1) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const sampleX = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const sampleDX = u => 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  const sampleY = u => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  let u = t;
  for (let i = 0; i < 6; i++) {
    const err = sampleX(u) - t;
    const dx = sampleDX(u);
    if (Math.abs(err) < 1e-6 || Math.abs(dx) < 1e-6) break;
    u = Math.max(0, Math.min(1, u - err / dx));
  }
  return sampleY(u);
}

export function cancelCoverageReturnAnim() {
  if (coverageAnimRafId != null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(coverageAnimRafId);
  }
  coverageAnimRafId = null;
}

export function animateCoverageReturn(targetWords, durationMs = 560) {
  cancelCoverageReturnAnim();
  const target = Math.max(0, Math.min(5000, Math.round(Number(targetWords) || 0)));
  const startWords = coverageCurrentWords;
  if (startWords === target || typeof requestAnimationFrame !== 'function') {
    renderCoverageCurve(target, target, true);
    return;
  }
  const startTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const step = nowTs => {
    const elapsed = Math.max(0, nowTs - startTs);
    const rawT = Math.min(1, elapsed / durationMs);
    const eased = easeCubicBezier(rawT, 0.22, 1, 0.36, 1);
    const cur = Math.round(startWords + (target - startWords) * eased);
    renderCoverageCurve(cur, target, true);
    if (rawT < 1) {
      coverageAnimRafId = requestAnimationFrame(step);
    } else {
      coverageAnimRafId = null;
      renderCoverageCurve(target, target, true);
    }
  };
  coverageAnimRafId = requestAnimationFrame(step);
}

export function renderCoverageCurve(words, userWords = coverageLastUserWords, syncSlider = true) {
  ensureCoverageChartPaths();
  ensureCoveragePreviewMounted();
  const clamped = Math.max(0, Math.min(5000, Math.round(Number(words) || 0)));
  coverageCurrentWords = clamped;
  coverageLastUserWords = Math.max(0, Math.round(Number(userWords) || 0));
  const covPct = wordsToCoveragePct(clamped);

  const x0 = 0, x1 = 300;
  const cx = x0 + (clamped / 5000) * (x1 - x0);

  const clipRect = el('cov-clip-rect');
  if (clipRect) clipRect.setAttribute('width', String(Math.max(0, cx - x0).toFixed(2)));

  const pill = el('coverage-words-pill');
  if (pill) pill.textContent = `${clamped.toLocaleString()} word${clamped === 1 ? '' : 's'}`;
  const h = el('coverage-pct-heading');
  if (h) h.textContent = `${covPct}% of the words in any text`;
  const uCnt = el('coverage-user-count');
  if (uCnt) uCnt.textContent = coverageLastUserWords.toLocaleString();
  const hint = el('coverage-return-hint');
  if (hint) hint.classList.toggle('hidden', clamped === coverageLastUserWords);

  if (syncSlider) {
    const sl = el('coverage-slider');
    if (sl) sl.value = String(Math.round((clamped / 5000) * 100));
  }

  // Zero-reflow update: ONLY toggle .cov-hidden on pre-mounted spans
  for (const sp of coverageWordSpans) {
    const rank = Number(sp.dataset.rank) || 9999;
    sp.classList.toggle('cov-hidden', rank > clamped);
  }
}

export const FUNCTION_POS_SET = new Set(['PRON', 'DET', 'ADP', 'CONJ', 'CONTR', 'INTJ']);
export function getCoverageLastUserWords() { return coverageLastUserWords; }



export function samplePlacementWords(count = 28, excludeIds = new Set()) {
  const entries = contentStore.orderedEntries;
  if (!entries || entries.length === 0) return [];
  const maxRank = entries.length;
  const eligible = entries.filter(e => {
    if (excludeIds.has(e.id)) return false;
    if (e.cognate) return false;
    const rank = e.curriculumIndex + 1;
    if (rank > 500 && FUNCTION_POS_SET.has(e.pos)) return false;
    return true;
  });
  if (eligible.length === 0) return [];
  const picked = [];
  const pickedIds = new Set(excludeIds);
  const posOrder = ['VERB', 'NOUN', 'ADJ', 'ADV'];
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) : 0;
    const targetRank = Math.round(Math.exp(frac * Math.log(Math.max(2, maxRank))));
    const wantPos = posOrder[i % posOrder.length];
    let best = null, bestScore = Infinity;
    for (const e of eligible) {
      if (pickedIds.has(e.id)) continue;
      const dist = Math.abs((e.curriculumIndex + 1) - targetRank);
      const posPenalty = (e.pos === wantPos) ? 0 : Math.max(40, targetRank * 0.12);
      const sc = dist + posPenalty;
      if (sc < bestScore) { bestScore = sc; best = e; }
    }
    if (best) { picked.push(best); pickedIds.add(best.id); }
  }
  return picked.sort((a, b) => a.curriculumIndex - b.curriculumIndex);
}

export function computePlacementCutoff(items, knownIds) {
  if (!items || items.length === 0) return { cutoffRank: 0, pHat: 0, lowerCI: 0 };
  const n = items.length;
  const k = items.filter(e => knownIds.has(e.id)).length;
  if (k === 0) return { cutoffRank: 0, pHat: 0, lowerCI: 0 };
  const pHat = k / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = pHat + (z * z) / (2 * n);
  const half = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * n)) / n);
  const lowerCI = Math.max(0, (center - half) / denom);
  const maxRank = Math.max(1, contentStore.orderedEntries.length);
  const cutoffRank = Math.min(maxRank, Math.floor((lowerCI * maxRank) / 100) * 100);
  return { cutoffRank, pHat, lowerCI };
}

export function renderPlacementDiagnostic() {
  const grid = el('placement-words-grid') || el('placement-diag-list');
  if (!grid) return;
  grid.textContent = '';
  placementState.items.forEach(entry => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSel = placementState.knownIds.has(entry.id);
    btn.className = `placement-pill${isSel ? ' selected' : ''}`;
    btn.dataset.lemmaId = entry.id;
    btn.setAttribute('aria-pressed', String(isSel));
    btn.textContent = entry.lemma;
    btn.addEventListener('click', () => {
      if (placementState.knownIds.has(entry.id)) {
        placementState.knownIds.delete(entry.id);
        btn.classList.remove('selected');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        placementState.knownIds.add(entry.id);
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
      }
      updatePlacementEstimateBox();
    });
    grid.appendChild(btn);
  });
  updatePlacementEstimateBox();
}

export function updatePlacementEstimateBox() {
  const cntEl = el('placement-selected-count');
  if (cntEl) cntEl.textContent = `${placementState.knownIds.size} / ${placementState.items.length} selected`;
  const estBox = el('placement-estimate-box');
  if (!estBox) return;
  const { cutoffRank, lowerCI } = computePlacementCutoff(placementState.items, placementState.knownIds);
  estBox.textContent = `Selected ${placementState.knownIds.size}/${placementState.items.length} words · Lower 95% CI: ${Math.round(lowerCI * 100)}% -> mark top ${cutoffRank} words Assumed.`;
}

export function openPlacementModal() {
  placementState.items = samplePlacementWords(28);
  placementState.knownIds = new Set();
  renderPlacementDiagnostic();
  const sel = el('placement-unit-select');
  if (sel) sel.value = '0';

  const box = el('placement-tenses');
  box.textContent = '';
  TENSE_GROUPS.filter(g => !g.locked).forEach(g => {
    const lbl = document.createElement('label');
    lbl.className = 'voice-row';
    lbl.style.cursor = 'pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = g.id;
    cb.checked = userStore.settings.unlockedTenses.includes(g.id);
    cb.style.accentColor = 'var(--primary)';
    const sp = document.createElement('span');
    sp.textContent = g.label;
    sp.style.flex = '1';
    lbl.append(cb, sp);
    box.appendChild(lbl);
  });
  el('modal-placement').classList.remove('hidden');
}

export async function applyPlacement(explicitCutoffRank = null) {
  const manualUnit = parseInt(el('placement-unit-select').value, 10) || 0;
  let cutoffIdx = 0;
  if (typeof explicitCutoffRank === 'number') cutoffIdx = explicitCutoffRank;
  else if (manualUnit > 0) cutoffIdx = (manualUnit - 1) * 100;
  else cutoffIdx = computePlacementCutoff(placementState.items, placementState.knownIds).cutoffRank;

  const puts = [];
  const now = Date.now();
  for (const entry of contentStore.orderedEntries) {
    if (entry.curriculumIndex >= cutoffIdx) break;
    if (!userStore.cards.has(entry.id)) {
      const rec = createBlankCardRecord(entry.id);
      rec.status = 'assumed'; rec.assumed = true; rec.updatedAt = now;
      userStore.cards.set(entry.id, rec);
      puts.push(rec);
    }
  }
  if (puts.length > 0) await idbBatchCards(puts, []);

  const placementEvt = { uuid: makeUUID(), type: 'placement', ts: now, cutoffRank: cutoffIdx, assumedCount: puts.length };
  const revId = await idbPut('reviews', placementEvt);
  placementEvt.id = revId;
  userStore.reviews.push(placementEvt);
  userStore.placement = { ts: now, cutoffRank: cutoffIdx, assumedCount: puts.length };
  await saveMeta('placement', userStore.placement);

  const checked = ['pres_base'];
  el('placement-tenses').querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    if (!checked.includes(cb.value)) checked.push(cb.value);
  });
  userStore.settings.unlockedTenses = checked;
  await saveSettings();
  el('modal-placement').classList.add('hidden');
  renderHome();
  showToast(`Placement saved (${puts.length} words marked Assumed)`);
}

export async function startCheckKnownSession() {
  const assumed = [];
  for (const entry of contentStore.orderedEntries) {
    const rec = userStore.cards.get(entry.id);
    if (rec && (rec.assumed || rec.status === 'assumed') && isPackLoadedOrAvailable(entry.packId)) {
      assumed.push(entry);
    }
  }
  if (assumed.length === 0) { showToast('No Assumed words to check.'); return; }
  const pick = assumed.sort(() => Math.random() - 0.5).slice(0, 20);
  const q = [];
  for (const entry of pick) {
    const ex = await pickBestExample(entry, null, entry.id, false);
    if (ex) q.push({ cardKey: entry.id, entry, ex, cellClass: null });
  }
  if (q.length === 0) { showToast('No examples loaded for Assumed words.'); return; }
  session.mode = 'check_known';
  session.drillQueue = q;
  session.targetCount = q.length;
  session.reviewedCount = 0; session.cleanCount = 0; session.hardCount = 0; session.missedCount = 0;
  session.missedIds.clear(); session.hardIds.clear(); session.newLearnedIds.clear();
  session.sessionLog.clear(); session.undoStack = [];
  el('session-title').textContent = 'Check Known';
  appActions.navigateTo('session');
  appActions.advanceStudy();
}
