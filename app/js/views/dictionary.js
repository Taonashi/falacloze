import { State, TENSE_GROUPS, appActions, contentStore, deepClone, el, foldMarks, formatSlot, isHttpOrigin, makeSpeakerIcon, navState, normNFC, session, showToast, userStore } from '../state.js';
import { createBlankCardRecord, sanitizeRetention } from '../fsrs.js';
import { getCellClass, getCellStat, getEligibleExamples, getLemmaBucket, getLemmaStatusBadge, getStudiedBaseLemmaIds, idbBatchCards, idbDelete, idbPut, isCardDueNow, isPackLoadedOrAvailable, isSlotUnlocked, saveCellStats, saveSettings } from '../storage.js';
import { buildGenderPill, buildNumberPill, buildPosPill, buildSlotPill, formatLexiconDisplayLemma, getCombinedNoteText, mountExample, renderHighlightedEnglish, renderRichGrammarNote, resolveEntryBaseGender, resolveGrammaticalTags } from '../grading.js';
import { bindProgressiveExampleBtn, getCurrentCardPitch, getPtVoices, speakPT } from '../tts.js';
import { renderHome } from './home.js';
import { focusAnswerInput, getActiveFinaleModes, seedCardKnown, startVerbDrill, syncDiacriticsBarVisibility } from './session.js';

/* ==========================================================================
   14. VOCABULARY BROWSER: BULK SELECTION, SURFACE SEARCH & WORD DETAILS
   ========================================================================== */
export function speakVocabWord(entry) {
  const surface = String((entry && entry.lemma) || '').trim();
  if (surface) speakPT(surface, { rate: 0.96, keepVoice: false });
}

export function getFilteredVocabEntries() {
  const rawSearch = el('vocab-search').value;
  const q = normNFC(rawSearch);
  const fq = foldMarks(rawSearch);
  const bucket = navState.vocabBucket;

  // Inflected-form surfaceIndex lookup ("fazem" -> "fazer")
  const surfaceHits = fq ? contentStore.surfaceIndex.get(fq) : null;
  const studiedSet = bucket === 'studied' ? new Set(getStudiedBaseLemmaIds()) : null;

  return contentStore.orderedEntries.filter(entry => {
    if (q) {
      const hay = `${foldMarks(entry.lemma)} ${foldMarks(entry.en_gloss)}`;
      const hitSurface = Boolean(surfaceHits && surfaceHits.has(entry.id));
      if (!hay.includes(fq) && !hitSurface) return false;
    }
    const b = getLemmaBucket(entry);
    const rec = userStore.cards.get(entry.id);
    if (bucket === 'studied') return studiedSet.has(entry.id);
    if (bucket === 'due') return Boolean(rec && isPackLoadedOrAvailable(entry.packId) && isCardDueNow(rec, Date.now()));
    if (bucket === 'to_learn') return b === 'to_learn';
    if (bucket === 'learning') return b === 'learning';
    if (bucket === 'review') return b === 'review';
    if (bucket === 'known') return b === 'known';
    if (bucket === 'assumed') return b === 'assumed';
    if (bucket === 'suspended') return b === 'suspended';
    if (bucket === 'leeches') return Boolean(rec && rec.leech);
    if (bucket === 'verbs') return entry.pos === 'VERB';
    return true;
  });
}

export function toggleVocabSelection(lemmaId, forceChecked = null) {
  const prevSize = State.vocabSelected.size;
  const willAdd = forceChecked !== null ? Boolean(forceChecked) : !State.vocabSelected.has(lemmaId);
  if (willAdd) State.vocabSelected.add(lemmaId);
  else State.vocabSelected.delete(lemmaId);
  if (prevSize > 0 && State.vocabSelected.size === 0) {
    State.vocabSelectMode = false;
  }
  renderVocabList();
}

export function updateBulkBarUI() {
  const bar = el('vocab-bulk-bar');
  bar.classList.toggle('hidden', !State.vocabSelectMode);
  el('btn-toggle-bulk').textContent = State.vocabSelectMode ? 'Done' : 'Select';
  el('btn-toggle-bulk').className = State.vocabSelectMode ? 'btn btn-primary' : 'btn btn-primary-soft';
  el('bulk-selected-count').textContent = `${State.vocabSelected.size} selected`;
  el('bulk-confirm-row').classList.add('hidden');
  State.pendingBulkAction = null;
}

export async function executeBulkAction(action, confirmed = false) {
  const ids = Array.from(State.vocabSelected);
  if (ids.length === 0) { showToast('Select at least one word first.'); return; }
  if (ids.length > 50 && !confirmed) {
    State.pendingBulkAction = action;
    el('bulk-confirm-msg').textContent = `Apply "${action}" to ${ids.length} words?`;
    el('bulk-confirm-row').classList.remove('hidden');
    return;
  }

  const puts = [], deletes = [];
  const now = Date.now();
  for (const lid of ids) {
    if (action === 'known') {
      const rec = userStore.cards.has(lid) ? deepClone(userStore.cards.get(lid)) : createBlankCardRecord(lid);
      rec.assumed = false; rec.suspended = false; rec.status = 'known';
      rec.stability = 21; rec.difficulty = 4.5; rec.interval = 21;
      rec.due = now + 21 * 86400000; rec.last_review = now; rec.updatedAt = now;
      userStore.cards.set(lid, rec); puts.push(rec);
    } else if (action === 'to_learn') {
      userStore.cards.delete(lid); deletes.push(lid);
    } else if (action === 'suspend') {
      const rec = userStore.cards.has(lid) ? deepClone(userStore.cards.get(lid)) : createBlankCardRecord(lid);
      rec.suspended = true; rec.status = 'suspended'; rec.updatedAt = now;
      userStore.cards.set(lid, rec); puts.push(rec);
    }
  }

  await idbBatchCards(puts, deletes);
  State.vocabSelected.clear();
  State.vocabSelectMode = false;
  updateBulkBarUI();
  renderVocabList();
  showToast(`Updated ${ids.length} word${ids.length === 1 ? '' : 's'}`);
}

export const VOCAB_FILTER_DESCRIPTIONS = {
  studied: 'Words you have actively practiced in sessions (Learning, Review, or Known).',
  due: 'Studied words ready for review right now based on your FSRS schedule.',
  learning: 'New or recently missed words currently in short-term learning steps.',
  review: 'Graduated words scheduled at longer spaced-repetition intervals.',
  known: 'Words you mastered or marked as Already know (excluded from new queue).',
  to_learn: 'Unseen curriculum words waiting in your upcoming study queue.',
  assumed: 'Words estimated as known from your Placement Test - tap any to verify.',
  leeches: 'Tricky words missed repeatedly that may benefit from focused practice.',
  verbs: 'All verbs in the curriculum - open any verb to launch a targeted Verb Drill.',
  suspended: 'Words manually paused from appearing in study sessions.',
  all: 'Complete 5,000-word Brazilian Portuguese frequency curriculum.'
};

export function renderVocabList() {
  const rawSearch = el('vocab-search').value;
  el('btn-vocab-clear').classList.toggle('hidden', rawSearch.length === 0);
  const bucket = navState.vocabBucket;

  el('vocab-tabs').querySelectorAll('.chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bucket === bucket);
  });
  const descEl = el('vocab-filter-desc');
  if (descEl) descEl.textContent = VOCAB_FILTER_DESCRIPTIONS[bucket] || '';
  updateBulkBarUI();

  const filtered = getFilteredVocabEntries();
  el('vocab-count').textContent = String(filtered.length);
  const list = el('vocab-list');
  list.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card stack'; empty.style.textAlign = 'center';
    const p = document.createElement('p');
    p.className = 'muted-xs'; p.style.margin = '0';
    p.textContent = bucket === 'studied'
      ? 'No studied words yet. Start a session or browse To Learn.'
      : 'No matching words in this filter.';
    empty.appendChild(p);
    if (bucket === 'studied' && contentStore.orderedEntries.length > 0) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-primary-soft btn-sm'; btn.style.margin = '0 auto';
      btn.textContent = `View To Learn (${contentStore.orderedEntries.length})`;
      btn.addEventListener('click', () => openVocab({ bucket: 'to_learn' }));
      empty.appendChild(btn);
    }
    list.appendChild(empty);
    return;
  }

  const maxShow = rawSearch ? 200 : 120;
  const slice = filtered.slice(0, maxShow);
  const frag = document.createDocumentFragment();

  slice.forEach(entry => {
    const st = getLemmaStatusBadge(entry);
    const rec = userStore.cards.get(entry.id);
    const isSel = State.vocabSelected.has(entry.id);

    const cardEl = document.createElement('div');
    cardEl.className = `vocab-card vocab-row ${isSel && State.vocabSelectMode ? 'selected' : ''}`;
    let lpTimer = null, lpX = 0, lpY = 0;
    cardEl.addEventListener('pointerdown', e => {
      if (State.vocabSelectMode) return;
      lpX = e.clientX || 0; lpY = e.clientY || 0;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        State.vocabSelectMode = true;
        State.vocabSelected.add(entry.id);
        State.suppressNextClickUntil = Date.now() + 350;
        try { if (navigator.vibrate) navigator.vibrate(18); } catch (_) {}
        renderVocabList();
      }, 450);
    });
    cardEl.addEventListener('pointermove', e => {
      if (!lpTimer) return;
      if (Math.hypot((e.clientX || 0) - lpX, (e.clientY || 0) - lpY) > 10) { clearTimeout(lpTimer); lpTimer = null; }
    });
    const cancelLP = () => { clearTimeout(lpTimer); lpTimer = null; };
    cardEl.addEventListener('pointerup', cancelLP);
    cardEl.addEventListener('pointercancel', cancelLP);

    const headRow = document.createElement('div');
    headRow.className = 'vocab-head-row';

    if (State.vocabSelectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'vocab-check'; cb.checked = isSel;
      cb.addEventListener('change', () => {
        toggleVocabSelection(entry.id, cb.checked);
      });
      headRow.appendChild(cb);
    }

    const spkBtn = document.createElement('button');
    spkBtn.type = 'button'; spkBtn.className = 'vocab-speaker-btn';
    spkBtn.setAttribute('aria-label', `Pronounce ${entry.lemma}`); spkBtn.appendChild(makeSpeakerIcon(15));
    spkBtn.addEventListener('click', e => { e.stopPropagation(); speakVocabWord(entry); });

    const headToggle = document.createElement('button');
    headToggle.type = 'button'; headToggle.className = 'vocab-head-toggle';

    const left = document.createElement('div');
    left.style.minWidth = '0';
    const line1 = document.createElement('div');
    line1.className = 'row-wrap';
    const orderEl = document.createElement('span');
    orderEl.className = 'muted-xs'; orderEl.style.fontWeight = '700'; orderEl.textContent = `#${entry.curriculumIndex + 1}`;
    const lemEl = document.createElement('strong');
    lemEl.style.fontSize = '15px'; lemEl.textContent = formatLexiconDisplayLemma(entry);
    const posEl = buildPosPill(entry.pos, true);
    line1.append(orderEl, lemEl, posEl);
    const baseGender = resolveEntryBaseGender(entry);
    if (baseGender) {
      const gBadge = buildGenderPill(baseGender, true);
      if (gBadge) line1.appendChild(gBadge);
    }
    if (rawSearch) {
      const fqSearch = foldMarks(rawSearch);
      const directHay = `${foldMarks(entry.lemma)} ${foldMarks(entry.en_gloss)}`;
      const sHits = contentStore.surfaceIndex.get(fqSearch);
      if (!directHay.includes(fqSearch) && sHits && sHits.has(entry.id)) {
        const fmBadge = document.createElement('span');
        fmBadge.className = 'badge badge-primary';
        fmBadge.textContent = 'form';
        line1.appendChild(fmBadge);
      }
    }
    if (rec && rec.leech) {
      const lb = document.createElement('span'); lb.className = 'badge badge-rose'; lb.textContent = 'Leech';
      line1.appendChild(lb);
    }
    const glossEl = document.createElement('div');
    glossEl.className = 'muted-xs'; glossEl.style.marginTop = '2px'; glossEl.textContent = entry.en_gloss;
    left.append(line1, glossEl);

    const right = document.createElement('div');
    right.style.display = 'flex'; right.style.alignItems = 'center'; right.style.gap = '6px'; right.style.flexShrink = '0';
    const stBadge = document.createElement('span');
    stBadge.className = st.cls; stBadge.textContent = st.label;
    right.appendChild(stBadge);

    headToggle.append(left, right);
    headToggle.addEventListener('click', () => {
      if (Date.now() < State.suppressNextClickUntil) return;
      if (State.vocabSelectMode) {
        toggleVocabSelection(entry.id);
        return;
      }
      State.vocabScrollTop = list.scrollTop;
      openWordDetailsModal(entry);
    });

    headRow.append(spkBtn, headToggle);
    cardEl.appendChild(headRow);
    frag.appendChild(cardEl);
  });

  if (filtered.length > maxShow) {
    const note = document.createElement('div');
    note.className = 'muted-xs'; note.style.textAlign = 'center'; note.style.padding = '10px';
    note.textContent = `Showing first ${maxShow} of ${filtered.length} words. Use search to narrow down.`;
    frag.appendChild(note);
  }
  list.appendChild(frag);
}

// Word Details Sheet: Infinitivo/Gerundio/Participio pills, Tap-to-Speak Conjugation Grid with 3✓/1✗ counts, FSRS metrics, Verb Drill, Examples with speaker+0.75x
export async function openWordDetail(lemmaId) {
  const entry = typeof lemmaId === 'string' ? contentStore.entriesById.get(lemmaId) : lemmaId;
  if (entry) {
    pushHistory('word_detail');
    await openWordDetailsModal(entry);
  }
}

export const SPOKEN_VERB_PARENTS = {
  'tô': 'estar',
  'tá': 'estar',
  'tão': 'estar',
  'tava': 'estar',
  'tavam': 'estar',
  'tamo': 'estar',
  'tamos': 'estar'
};

export function getSpokenParentEntry(entry) {
  if (!entry) return null;
  const normLem = normNFC(entry.lemma);
  const parentLemma = SPOKEN_VERB_PARENTS[normLem];
  if (!parentLemma) return null;
  // Guard against adverb "tão" ("so") matching verb "estar"
  if (normLem === 'tão' && String(entry.pos || '').toUpperCase() !== 'VERB') return null;
  return contentStore.orderedEntries.find(e => normNFC(e.lemma) === parentLemma && String(e.pos || '').toUpperCase() === 'VERB') || null;
}

export async function resolveVerbDrillTarget(entry) {
  if (!entry) return null;
  const parent = getSpokenParentEntry(entry);
  const targetEntry = parent || entry;
  if (String(targetEntry.pos || '').toUpperCase() !== 'VERB') return null;
  const targetEligible = await getEligibleExamples(targetEntry);
  const merged = [...targetEligible];
  if (parent && parent.id !== entry.id) {
    const childEligible = await getEligibleExamples(entry);
    const seenExIds = new Set(merged.map(e => e.exId));
    for (const ce of childEligible) {
      if (!seenExIds.has(ce.exId)) {
        seenExIds.add(ce.exId);
        merged.push(ce);
      }
    }
  }
  const distinctForms = new Set(merged.map(e => normNFC(e.answer)).filter(Boolean));
  if (distinctForms.size < 2) return null;
  return { targetEntry, eligible: merged, distinctForms: distinctForms.size };
}

export async function openWordDetailsModal(entry) {
  if (!entry) return;
  el('wd-title').textContent = `${formatLexiconDisplayLemma(entry)} - ${entry.en_gloss}`;
  el('modal-word-details').classList.remove('hidden');
  const body = el('wd-body');
  body.textContent = '';

  const stack = document.createElement('div');
  stack.className = 'stack';
  const rec = userStore.cards.get(entry.id);
  const eligible = await getEligibleExamples(entry);
  const spokenParent = getSpokenParentEntry(entry);
  const drillTarget = await resolveVerbDrillTarget(entry);

  // 0. Semantic Header Badges (POS + Gender with SVG icon)
  const headerBadges = document.createElement('div');
  headerBadges.className = 'wd-header-badges';
  headerBadges.appendChild(buildPosPill(entry.pos, false));
  const entryBaseGender = resolveEntryBaseGender(entry);
  if (entryBaseGender) {
    const gPill = buildGenderPill(entryBaseGender, false);
    if (gPill) headerBadges.appendChild(gPill);
  }
  stack.appendChild(headerBadges);

  // 0b. Entry-level linguistic / false-friend note via renderRichGrammarNote
  const entryNoteText = getCombinedNoteText(entry, null);
  if (entryNoteText) {
    const entryNoteBox = document.createElement('div');
    entryNoteBox.className = 'wd-note-box';
    renderRichGrammarNote(entryNoteBox, entryNoteText, entry.id);
    stack.appendChild(entryNoteBox);
  }

  if (spokenParent) {
    const parentRow = document.createElement('div');
    parentRow.className = 'spoken-parent-banner';
    const lbl = document.createElement('span');
    lbl.textContent = 'Colloquial spoken form of';
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'badge pill-verb';
    pill.style.cursor = 'pointer';
    pill.setAttribute('data-open-word-detail', spokenParent.id);
    pill.textContent = spokenParent.lemma;
    pill.addEventListener('click', e => {
      e.stopPropagation();
      openWordDetail(spokenParent.id);
    });
    parentRow.append(lbl, pill);
    stack.appendChild(parentRow);
  }

  // 1. Actions Row
  const actions = document.createElement('div');
  actions.className = 'row-wrap';
  if (drillTarget) {
    const drillBtn = document.createElement('button');
    drillBtn.type = 'button'; drillBtn.className = 'btn btn-primary btn-xs'; drillBtn.textContent = 'Verb Drill';
    drillBtn.addEventListener('click', () => {
      el('modal-word-details').classList.add('hidden');
      startVerbDrill(drillTarget.targetEntry, drillTarget.eligible);
    });
    actions.appendChild(drillBtn);
  }
  const knowBtn = document.createElement('button');
  knowBtn.type = 'button'; knowBtn.className = 'btn btn-emerald-soft btn-xs'; knowBtn.textContent = 'Mark Known';
  knowBtn.addEventListener('click', async () => {
    await seedCardKnown(entry.id, entry, null, false);
    if (navState.view === 'vocab') renderVocabList();
    showToast(`"${entry.lemma}" marked Known`);
    openWordDetailsModal(entry);
  });
  actions.appendChild(knowBtn);

  if (rec && (rec.leech || (rec.lapses || 0) > 0)) {
    const resetLapseBtn = document.createElement('button');
    resetLapseBtn.type = 'button'; resetLapseBtn.className = 'btn btn-amber btn-xs'; resetLapseBtn.textContent = 'Reset Lapses';
    resetLapseBtn.addEventListener('click', async () => {
      rec.lapses = 0; rec.leech = false; rec.updatedAt = Date.now();
      userStore.cards.set(entry.id, rec);
      await idbPut('cards', rec);
      if (navState.view === 'vocab') renderVocabList();
      showToast(`Reset lapses for "${entry.lemma}"`);
      openWordDetailsModal(entry);
    });
    actions.appendChild(resetLapseBtn);
  }

  if (rec) {
    const toLearnBtn = document.createElement('button');
    toLearnBtn.type = 'button'; toLearnBtn.className = 'btn btn-neutral btn-xs'; toLearnBtn.textContent = 'Reset Word';
    toLearnBtn.addEventListener('click', async () => {
      userStore.cards.delete(entry.id); delete userStore.cellStats[entry.id];
      await idbDelete('cards', entry.id); await saveCellStats();
      if (navState.view === 'vocab') renderVocabList();
      showToast(`Moved "${entry.lemma}" back to To Learn`);
      openWordDetailsModal(entry);
    });
    actions.appendChild(toLearnBtn);
  }
  stack.appendChild(actions);

  // 2. FSRS Metrics
  if (rec) {
    const fg = document.createElement('div');
    fg.className = 'fsrs-grid';
    [
      ['Memory', `${(rec.stability || 0).toFixed(1)}d`],
      ['Difficulty', `${(rec.difficulty || 0).toFixed(1)}`],
      ['Reviews', String(rec.reps || 0)],
      ['Forgotten', String(rec.lapses || 0)]
    ].forEach(([lbl, val]) => {
      const b = document.createElement('div'); b.className = 'fsrs-box';
      const v = document.createElement('div'); v.className = 'fsrs-val'; v.textContent = val;
      const l = document.createElement('div'); l.className = 'fsrs-lbl'; l.textContent = lbl;
      b.append(v, l); fg.appendChild(b);
    });
    stack.appendChild(fg);
  }

  // 3. Clean v2.4-style 2-column visual form progress list (.conj-list / .conj-row + .strength-bar)
  const getStrengthVis = st => {
    const tot = (st.ok || 0) + (st.fail || 0);
    if (tot === 0) return { color: '#CBD5E1', pct: 0, label: 'Unpracticed' };
    const ratio = (st.ok || 0) / tot;
    if (ratio >= 0.75 && st.ok >= 2) return { color: '#10B981', pct: 100, label: 'Strong' };
    if (ratio >= 0.45) return { color: '#F59E0B', pct: Math.max(22, Math.round(ratio * 100)), label: 'Learning' };
    return { color: '#EF4444', pct: Math.max(18, Math.round(ratio * 100)), label: 'Weak' };
  };

  const buildFormListGroup = (title, items) => {
    if (!items || items.length === 0) return null;
    const sec = document.createElement('div');
    const h = document.createElement('div'); h.className = 'section-title'; h.textContent = title;
    sec.appendChild(h);
    const listBox = document.createElement('div'); listBox.className = 'conj-list';
    items.forEach(({ slot, label, form }) => {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'conj-row';
      const pWrap = document.createElement('div');
      pWrap.className = 'conj-label-pills';
      if (String(entry.pos || '').toUpperCase() === 'VERB') {
        const sp = buildSlotPill(label, true, slot);
        if (sp) pWrap.appendChild(sp);
      } else {
        const fTags = resolveGrammaticalTags(entry, { answer: form, slot, pt: form, hint_en: entry.en_gloss });
        if (fTags.gender) {
          const gp = buildGenderPill(fTags.gender, true);
          if (gp) pWrap.appendChild(gp);
        }
        if (fTags.number) {
          const np = buildNumberPill(fTags.number, true);
          if (np) pWrap.appendChild(np);
        }
        if (pWrap.children.length === 0) {
          const pEl = document.createElement('span'); pEl.className = 'conj-pronoun'; pEl.textContent = label;
          pWrap.appendChild(pEl);
        }
      }
      const right = document.createElement('div'); right.className = 'conj-right';
      const fEl = document.createElement('span'); fEl.className = 'conj-form'; fEl.textContent = form;
      const cc = getCellClass(slot);
      const isFormKnown = Boolean(rec && (rec.status === 'known' || (rec.knownCells && rec.knownCells[cc]) || (rec.knownAnswers && rec.knownAnswers[normNFC(form)])));
      const vis = isFormKnown ? { color: '#059669', pct: 100, label: 'Known' } : getStrengthVis(getCellStat(entry.id, cc));
      const ind = document.createElement('span'); ind.className = 'strength-indicator'; ind.title = vis.label;
      const dot = document.createElement('span'); dot.className = 'strength-dot'; dot.style.background = vis.color;
      const bar = document.createElement('span'); bar.className = 'strength-bar conj-bar';
      const fill = document.createElement('span'); fill.className = 'strength-fill conj-bar-fill';
      fill.style.width = `${vis.pct}%`; fill.style.background = vis.color;
      bar.appendChild(fill);
      ind.append(dot, bar);
      right.append(fEl, ind);
      if (isFormKnown) {
        const knTag = document.createElement('span');
        knTag.className = 'badge badge-emerald';
        knTag.style.fontSize = '10px';
        knTag.textContent = 'Known';
        right.appendChild(knTag);
      }
      row.append(pWrap, right);
      row.addEventListener('click', () => speakPT(form, { rate: 0.96, keepVoice: false }));
      listBox.appendChild(row);
    });
    sec.appendChild(listBox);
    return sec;
  };

  const fbs = entry.formsBySlot || {};
  if (entry.pos === 'VERB') {
    const nonFinite = [
      fbs.inf ? { slot: 'inf', label: 'Infinitive', form: fbs.inf } : null,
      fbs.ger ? { slot: 'ger', label: 'Gerund', form: fbs.ger } : null,
      fbs.part ? { slot: 'part', label: 'Participle', form: fbs.part } : null
    ].filter(Boolean);
    const nfSec = buildFormListGroup('Non-Finite Forms', nonFinite);
    if (nfSec) stack.appendChild(nfSec);

    const tenseGroups = [
      { title: 'Present', slots: ['pres.1sg', 'pres.3sg', 'pres.1pl', 'pres.3pl'] },
      { title: 'Past (Perfect)', slots: ['perf.1sg', 'perf.3sg', 'perf.1pl', 'perf.3pl'] },
      { title: 'Past (Imperfect)', slots: ['impf.1sg', 'impf.3sg', 'impf.1pl', 'impf.3pl'] },
      { title: 'Conditional', slots: ['cond.1sg', 'cond.3sg', 'cond.1pl', 'cond.3pl'] },
      { title: 'Future Subjunctive', slots: ['fut_subj.1sg', 'fut_subj.3sg', 'fut_subj.1pl', 'fut_subj.3pl'] },
      { title: 'Present Subjunctive', slots: ['pres_subj.1sg', 'pres_subj.3sg', 'pres_subj.1pl', 'pres_subj.3pl'] },
      { title: 'Imperfect Subjunctive', slots: ['impf_subj.1sg', 'impf_subj.3sg', 'impf_subj.1pl', 'impf_subj.3pl'] },
      { title: 'Imperative', slots: ['imp.3sg', 'imp.3pl'] }
    ];
    tenseGroups.forEach(tg => {
      const rows = tg.slots
        .filter(sl => fbs[sl] && isSlotUnlocked(sl))
        .map(sl => ({ slot: sl, label: formatSlot(sl).personLabel, form: fbs[sl] }));
      const sec = buildFormListGroup(tg.title, rows);
      if (sec) stack.appendChild(sec);
    });
  } else {
    const nomRows = Object.entries(fbs).map(([sl, form]) => ({ slot: sl, label: formatSlot(sl).personLabel, form }));
    if (nomRows.length > 1) {
      const sec = buildFormListGroup('Forms', nomRows);
      if (sec) stack.appendChild(sec);
    }
  }

  // 5. Examples with speaker + 0.75x
  const exSec = document.createElement('div');
  exSec.className = 'stack'; exSec.style.gap = '7px';
  const exHead = document.createElement('div'); exHead.className = 'section-title'; exHead.style.marginBottom = '0';
  exHead.textContent = `Examples (${eligible.length})`;
  exSec.appendChild(exHead);

  eligible.forEach(ex => {
    const row = document.createElement('div'); row.className = 'vocab-ex-card';
    const col = document.createElement('div'); col.style.flex = '1'; col.style.minWidth = '0';
    const pt = document.createElement('div'); pt.className = 'vocab-ex-pt'; mountExample(pt, ex, { revealed: true });
    const en = document.createElement('div'); en.className = 'vocab-ex-en'; renderHighlightedEnglish(en, ex.en, ex.clean_hint_en || ex.hint_en, entry.en_gloss, ex.answer);
    col.append(pt, en);
    const exNoteText = getCombinedNoteText(null, ex);
    if (exNoteText && exNoteText !== entryNoteText) {
      const exNoteEl = document.createElement('div');
      exNoteEl.className = 'wd-ex-note';
      renderRichGrammarNote(exNoteEl, exNoteText, entry.id);
      col.appendChild(exNoteEl);
    }

    const btns = document.createElement('div'); btns.style.display = 'flex'; btns.style.gap = '4px';
    const pBtn = document.createElement('button'); pBtn.type = 'button'; pBtn.className = 'btn btn-primary-soft btn-xs'; pBtn.setAttribute('aria-label', 'Hear sentence');
    bindProgressiveExampleBtn(pBtn, ex.pt, 14);
    btns.append(pBtn);
    row.append(col, btns);
    exSec.appendChild(row);
  });
  stack.appendChild(exSec);
  body.appendChild(stack);

  const resetWdScroll = () => {
    const modal = el('modal-word-details');
    if (modal) {
      modal.scrollTop = 0;
      const mbox = modal.querySelector ? modal.querySelector('.modal-box') : null;
      if (mbox) mbox.scrollTop = 0;
    }
    if (body) body.scrollTop = 0;
  };
  resetWdScroll();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resetWdScroll);
}


/* ==========================================================================
   15. NAVIGATION, POPSTATE HARDWARE BACK, SETTINGS & FILE IMPORT
   ========================================================================== */


export function pushHistory(tag) {
  if (!isHttpOrigin()) return;
  try { window.history.pushState({ tag }, '', `#${tag}`); } catch (_) {}
}

export function renderRoute(view, settingsOpen) {
  navState.view = view;
  navState.settingsOpen = settingsOpen;
  const domView = (view === 'drill') ? 'session' : view;
  ['home', 'session', 'finale', 'vocab', 'drills'].forEach(v => el(`view-${v}`).classList.toggle('hidden', v !== domView));
  el('overlay-settings').classList.toggle('hidden', !settingsOpen);
  el('sheet-session-menu').classList.add('hidden');

  if (settingsOpen) { renderSettings(); return; }
  if (view === 'home') renderHome();
  else if (view === 'vocab') { renderVocabList(); el('vocab-list').scrollTop = State.vocabScrollTop; }
  else if (view === 'drills' && typeof appActions.renderDrillsHub === 'function') appActions.renderDrillsHub();
  else if (view === 'session' || view === 'drill') syncDiacriticsBarVisibility();
}

export function navigateTo(view) {
  pushHistory(view);
  renderRoute(view, false);
}

export function openVocab({ bucket = 'studied' } = {}) {
  navState.vocabBucket = bucket;
  State.vocabSelectMode = false;
  State.vocabSelected.clear();
  State.vocabScrollTop = 0;
  el('vocab-search').value = '';
  el('btn-vocab-clear').classList.add('hidden');
  navigateTo('vocab');
}


export function renderSettings() {
  el('toggle-strict-diacritics').classList.toggle('on', userStore.settings.strictDiacritics);
  el('toggle-hide-diacritics').classList.toggle('on', Boolean(userStore.settings.hideDiacriticsBar));
  const defColEl = el('toggle-defer-colloquial');
  if (defColEl) { defColEl.classList.toggle('on', Boolean(userStore.settings.deferColloquial)); defColEl.setAttribute('aria-checked', String(Boolean(userStore.settings.deferColloquial))); }
  el('max-attempts-group').querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', String(btn.dataset.attempts) === String(userStore.settings.maxAttempts));
  });
  const activeModes = getActiveFinaleModes();
  el('finale-mode-group').querySelectorAll('.seg-btn').forEach(btn => {
    const m = btn.dataset.finale;
    const isOn = activeModes.includes(m);
    btn.classList.toggle('active', isOn);
    btn.textContent = (isOn ? '✓ ' : '') + (m === 'blind' ? 'Blind Audio' : 'Recall Tiles');
  });
  el('toggle-autoplay').classList.toggle('on', userStore.settings.autoPlay);
  el('toggle-rotate-voices').classList.toggle('on', userStore.settings.rotateVoices);
  el('toggle-vary-pitch').classList.toggle('on', userStore.settings.varyPitch !== false);
  el('toggle-vary-pitch').setAttribute('aria-checked', String(userStore.settings.varyPitch !== false));
  if (el('toggle-fix-round')) {
    const fixOn = userStore.settings.enableFixRound !== false;
    el('toggle-fix-round').classList.toggle('on', fixOn);
    el('toggle-fix-round').setAttribute('aria-checked', String(fixOn));
  }
  if (el('toggle-sound-effects')) {
    const sfxOn = userStore.settings.soundEffects !== false;
    el('toggle-sound-effects').classList.toggle('on', sfxOn);
    el('toggle-sound-effects').setAttribute('aria-checked', String(sfxOn));
  }
  el('pitch-range-wrap').classList.toggle('hidden', userStore.settings.varyPitch === false);
  el('pitch-range-group').querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pitchRange === (userStore.settings.pitchRange || 'subtle'));
  });
  el('set-new-lemmas').value = String(userStore.settings.dailyNewLimit);
  const safeRet = sanitizeRetention(userStore.settings.desiredRetention, 0.85);
  userStore.settings.desiredRetention = safeRet;
  el('set-retention').value = safeRet.toFixed(2);
  el('set-retention-val').textContent = safeRet.toFixed(2);
  renderVoicesSettings();

  const tBox = el('settings-tenses');
  tBox.textContent = '';
  TENSE_GROUPS.forEach(g => {
    const row = document.createElement('div'); row.className = 'setting-row';
    const lbl = document.createElement('span'); lbl.style.fontSize = '13.5px'; lbl.style.fontWeight = '600'; lbl.textContent = g.label;
    const on = userStore.settings.unlockedTenses.includes(g.id);
    const sw = document.createElement('button'); sw.type = 'button'; sw.className = `switch ${on ? 'on' : ''}`; sw.disabled = g.locked;
    const knob = document.createElement('span'); knob.className = 'switch-knob'; sw.appendChild(knob);
    if (!g.locked) {
      sw.addEventListener('click', () => {
        const arr = userStore.settings.unlockedTenses;
        const idx = arr.indexOf(g.id);
        if (idx === -1) arr.push(g.id); else arr.splice(idx, 1);
        saveSettings(); renderSettings();
      });
    }
    row.append(lbl, sw); tBox.appendChild(row);
  });
  el('settings-packs-info').textContent = `${contentStore.orderedEntries.length} lexicon entries · ${userStore.cards.size} tracked cards · ${contentStore.customFiles.size} imported files`;
  const repCount = Array.isArray(userStore.reports) ? userStore.reports.length : 0;
  const repBadge = el('settings-reports-count');
  if (repBadge) {
    repBadge.textContent = `${repCount} pending`;
    repBadge.className = `badge ${repCount > 0 ? 'badge-amber' : 'badge-slate'}`;
  }
}

export function renderVoicesSettings() {
  const list = el('settings-voices-list');
  list.textContent = '';
  el('tts-missing-note').classList.toggle('hidden', getPtVoices().length > 0);
  if (getPtVoices().length === 0) return;
  const saved = userStore.settings.enabledVoices || [];
  getPtVoices().forEach(voice => {
    const row = document.createElement('div'); row.className = 'voice-row';
    const lbl = document.createElement('label'); lbl.className = 'voice-label';
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = saved.some(s => s.voiceURI === voice.voiceURI || s.name === voice.name);
    cb.style.accentColor = 'var(--primary)';
    cb.addEventListener('change', () => {
      let cur = userStore.settings.enabledVoices.filter(s => s.voiceURI !== voice.voiceURI && s.name !== voice.name);
      if (cb.checked) cur.push({ voiceURI: voice.voiceURI, name: voice.name });
      userStore.settings.enabledVoices = cur; saveSettings();
    });
    const nm = document.createElement('span'); nm.className = 'voice-name'; nm.textContent = `${voice.name} (${voice.lang})`;
    lbl.append(cb, nm);
    const testBtn = document.createElement('button'); testBtn.type = 'button'; testBtn.className = 'btn btn-primary-soft btn-xs'; testBtn.textContent = 'Test';
    testBtn.addEventListener('click', () => { speakPT('Olá! Tudo bem com você hoje?', { keepVoice: false, explicitVoice: voice }); showToast(`Test voice · pitch ${getCurrentCardPitch().toFixed(2)}`); });
    row.append(lbl, testBtn); list.appendChild(row);
  });
}


export function closeWordDetailModal() {
  el('modal-word-details').classList.add('hidden');
  if (navState.view === 'vocab') el('vocab-list').scrollTop = State.vocabScrollTop;
  else if ((navState.view === 'session' || navState.view === 'drill') && !userStore.settings.walkMode && session.activeItem) focusAnswerInput();
}
