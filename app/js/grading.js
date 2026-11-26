import { HOMOPHONE_GROUPS, appActions, contentStore, el, escapeRegex, foldMarks, formatPOS, formatSlot, normNFC, session, setPillWithIcon, userStore } from './state.js';
import { buildClozeSplit, getStudiedBaseLemmaIds } from './storage.js';


/* ==========================================================================
   6. VALIDATION & DAMERAU-LEVENSHTEIN TYPO ENGINE (PARTS 1 & 2)
   ========================================================================== */
export function damerauLevenshtein(a, b) {
  const s1 = Array.from(a), s2 = Array.from(b);
  const m = s1.length, n = s2.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

export function isDiacriticCollisionWord(foldedWord) {
  const amb = contentStore.ambiguous && contentStore.ambiguous.diacriticCollisions;
  if (amb && Array.isArray(amb[foldedWord]) && amb[foldedWord].length > 1) return true;
  const set = contentStore.foldedCollisionMap.get(foldedWord);
  return Boolean(set && set.size > 1);
}

export function isDiacriticOnlyDiff(input, target) {
  const ni = normNFC(input);
  const nt = normNFC(target);
  if (!ni || !nt || ni === nt) return false;
  return foldMarks(ni) === foldMarks(nt);
}

export function classifyAnswer(rawInput, entry, ex, opts = {}) {
  const strict = opts.strictDiacritics != null ? opts.strictDiacritics : userStore.settings.strictDiacritics;
  const normInput = normNFC(rawInput);
  if (!normInput) return { kind: 'empty', accepted: false };

  const acceptTargets = [ex.answer, ...(ex.accept || [])];
  const acceptNormSet = new Set(acceptTargets.map(normNFC));

  // 1. Exact match
  for (const target of acceptTargets) {
    if (normInput === normNFC(target)) {
      return { kind: 'exact', accepted: true, matched: target, typed: rawInput.trim() };
    }
  }

  // 2. Accent-folded match
  const foldedInput = foldMarks(normInput);
  for (const target of acceptTargets) {
    const normTarget = normNFC(target);
    if (foldedInput === foldMarks(normTarget)) {
      const colliding = isDiacriticCollisionWord(foldedInput);
      if (!strict) {
        // Strict Diacritics OFF: ALWAYS accept ALL accent-folded matches (zero false rejections!)
        return {
          kind: colliding ? 'diacritic_collision_accepted' : 'diacritic_accepted',
          accepted: true,
          colliding,
          matched: target,
          typed: rawInput.trim()
        };
      }
      // Strict Diacritics ON: not accepted (caller gives 1 free retry, then counts as wrong)
      return { kind: 'diacritic_strict_miss', accepted: false, colliding, expected: target, typed: rawInput.trim() };
    }
  }

  // 3. Wrong form of the same lemma (STRICT 0-edit exact form match ONLY; respects strictDiacritics)
  const otherForms = (entry.forms || []).map(normNFC).filter(f => f && !acceptNormSet.has(f));
  const isExactOtherForm = strict
    ? otherForms.includes(normInput)
    : otherForms.some(f => foldMarks(f) === foldedInput);
  if (isExactOtherForm) {
    return { kind: 'wrong_form', accepted: false, expected: ex.answer, typed: rawInput.trim() };
  }

  // 4a. Schema 3.1 alt_valid[] -> valid alternative in context, free retry with zero FSRS penalty
  const altValidNorm = (ex.alt_valid || []).map(normNFC);
  const isAltValid = strict
    ? altValidNorm.includes(normInput)
    : altValidNorm.some(a => foldMarks(a) === foldedInput);
  if (isAltValid) {
    return {
      kind: 'plausible_wrong',
      altValid: true,
      accepted: false,
      expected: ex.answer,
      typed: rawInput.trim(),
      message: 'Also correct in context! Try the target word.'
    };
  }

  // 4b. Plausible wrong -> free retry with quoted user word
  const plausibleNorm = (ex.plausible_wrong || []).map(normNFC);
  if (plausibleNorm.includes(normInput)) {
    return { kind: 'plausible_wrong', accepted: false, expected: ex.answer, typed: rawInput.trim() };
  }

  // 4c. Spaceless multi-word answer (e.g. "agente" for "a gente") -> accepted typo
  const foldedNoSpaceInput = foldedInput.replace(/\s+/g, '');
  const normNoSpaceInput = normInput.replace(/\s+/g, '');
  for (const target of acceptTargets) {
    const normTarget = normNFC(target);
    if (!/\s/.test(normTarget)) continue;
    if (foldedNoSpaceInput === foldMarks(normTarget).replace(/\s+/g, '')) {
      if (strict && normNoSpaceInput !== normTarget.replace(/\s+/g, '')) {
        const colliding = isDiacriticCollisionWord(foldMarks(normTarget));
        return { kind: 'diacritic_strict_miss', accepted: false, colliding, expected: target, typed: rawInput.trim() };
      }
      return { kind: 'typo', accepted: true, matched: target, typed: rawInput.trim() };
    }
  }

  // 5. Damerau-Levenshtein typo tolerance (ONLY when input is NOT another real Portuguese word)
  if (!contentStore.knownWordSet.has(normInput) && !(entry.forms || []).includes(normInput)) {
    for (const target of acceptTargets) {
      const foldedTarget = foldMarks(target);
      const tLen = Array.from(foldedTarget).length;
      const iLen = Array.from(foldedInput).length;
      let lenOk = false;
      if (tLen >= 5 && iLen >= 4) lenOk = true;
      else if (tLen === 4 && iLen >= 3 && foldedInput[0] === foldedTarget[0]) lenOk = true;
      if (lenOk && damerauLevenshtein(foldedInput, foldedTarget) === 1) {
        return { kind: 'typo', accepted: true, matched: target, typed: rawInput.trim() };
      }
    }
  }

  return { kind: 'wrong', accepted: false, expected: ex.answer, typed: rawInput.trim() };
}

// Dual-input wrapper: supports typing EITHER full word ("quero") OR remaining tail ("ero") when prefix is revealed
export function classifyAnswerWithPrefix(rawInput, entry, ex, revealedPrefix = '', opts = {}) {
  const primary = classifyAnswer(rawInput, entry, ex, opts);
  if (primary.accepted || primary.kind === 'plausible_wrong' || primary.kind === 'diacritic_strict_miss' || primary.kind === 'wrong_form') return primary;
  if (revealedPrefix && rawInput.trim() && !foldMarks(rawInput).startsWith(foldMarks(revealedPrefix))) {
    const combined = revealedPrefix + rawInput.trim();
    const secondary = classifyAnswer(combined, entry, ex, opts);
    if (secondary.accepted || secondary.kind === 'diacritic_strict_miss') return secondary;
  }
  return primary;
}

/* ==========================================================================
   7. COUNTABLE MASK RENDERER (DUAL-INPUT PREFIX SUPPORT) & EXAMPLE RENDERER
   ========================================================================== */
export function renderMask(answer, typed, revealedPrefixLen = 0, stateClass = '', onGapTap = null) {
  const gap = document.createElement('span');
  gap.className = `mask-gap ${stateClass}`.trim();
  gap.setAttribute('role', 'button');
  gap.setAttribute('tabindex', '0');

  const ansChars = Array.from(String(answer || ''));
  const typChars = Array.from(String(typed || ''));
  const revealedPrefix = ansChars.slice(0, revealedPrefixLen).join('');

  // Dual-input mode: if prefix is revealed and user types tail without repeating prefix, mirror after revealedPrefixLen
  const tailMode = revealedPrefixLen > 0 && typChars.length > 0 &&
    !foldMarks(typed).startsWith(foldMarks(revealedPrefix));

  let effectiveChars;
  if (tailMode) {
    effectiveChars = [...ansChars.slice(0, revealedPrefixLen), ...typChars];
  } else {
    effectiveChars = typChars;
  }

  for (let i = 0; i < ansChars.length; i++) {
    const aCh = ansChars[i];
    if (aCh === ' ') {
      const sp = document.createElement('span');
      sp.className = 'mask-space';
      sp.textContent = '\u00A0';
      gap.appendChild(sp);
      continue;
    }
    if (aCh === '-' || aCh === "'") {
      const p = document.createElement('span');
      p.className = 'mask-slot punct';
      p.textContent = aCh;
      gap.appendChild(p);
      continue;
    }
    const slot = document.createElement('span');
    if (i < revealedPrefixLen && (tailMode || i >= effectiveChars.length)) {
      slot.className = 'mask-slot mask-hinted';
      slot.textContent = aCh;
    } else if (i < effectiveChars.length) {
      slot.className = (i < revealedPrefixLen && tailMode) ? 'mask-slot mask-hinted' : 'mask-slot';
      slot.textContent = effectiveChars[i];
    } else {
      slot.className = 'mask-slot empty';
      slot.textContent = '_';
    }
    gap.appendChild(slot);
  }

  if (effectiveChars.length > ansChars.length) {
    const ov = document.createElement('span');
    ov.className = 'mask-overflow';
    ov.textContent = effectiveChars.slice(ansChars.length).join('');
    gap.appendChild(ov);
  }

  if (onGapTap) gap.addEventListener('click', e => { e.stopPropagation(); onGapTap(); });
  return gap;
}

export function buildDiffHighlight(correct, typed) {
  const frag = document.createDocumentFragment();
  const cArr = Array.from(String(correct || ''));
  const tArr = Array.from(String(typed || ''));
  for (let i = 0; i < cArr.length; i++) {
    const ch = cArr[i], tCh = tArr[i] || '';
    if (ch.toLowerCase() !== tCh.toLowerCase()) {
      const mark = document.createElement('span');
      mark.className = 'diff-char';
      mark.textContent = ch;
      frag.appendChild(mark);
    } else {
      frag.appendChild(document.createTextNode(ch));
    }
  }
  return frag;
}

export const EN_IRREGULARS = {
  be: ['am', 'is', 'are', 'was', 'were', 'been', 'being'],
  have: ['has', 'had', 'having'],
  do: ['does', 'did', 'done', 'doing'],
  go: ['goes', 'went', 'gone', 'going'],
  give: ['gives', 'gave', 'given', 'giving'],
  eat: ['eats', 'ate', 'eaten', 'eating'],
  come: ['comes', 'came', 'coming'],
  see: ['sees', 'saw', 'seen', 'seeing'],
  make: ['makes', 'made', 'making'],
  take: ['takes', 'took', 'taken', 'taking'],
  say: ['says', 'said', 'saying'],
  know: ['knows', 'knew', 'known', 'knowing'],
  get: ['gets', 'got', 'gotten', 'getting'],
  think: ['thinks', 'thought', 'thinking'],
  tell: ['tells', 'told', 'telling'],
  find: ['finds', 'found', 'finding'],
  leave: ['leaves', 'left', 'leaving'],
  feel: ['feels', 'felt', 'feeling'],
  put: ['puts', 'putting'],
  bring: ['brings', 'brought', 'bringing'],
  keep: ['keeps', 'kept', 'keeping'],
  begin: ['begins', 'began', 'begun', 'beginning'],
  speak: ['speaks', 'spoke', 'spoken', 'speaking'],
  write: ['writes', 'wrote', 'written', 'writing'],
  run: ['runs', 'ran', 'running'],
  buy: ['buys', 'bought', 'buying'],
  pay: ['pays', 'paid', 'paying'],
  hear: ['hears', 'heard', 'hearing'],
  drink: ['drinks', 'drank', 'drunk', 'drinking'],
  sleep: ['sleeps', 'slept', 'sleeping'],
  can: ['could'],
  will: ['would'],
  lose: ['loses', 'lost', 'losing'],
  read: ['reads', 'reading'],
  wear: ['wears', 'wore', 'worn', 'wearing'],
  sit: ['sits', 'sat', 'sitting'],
  stand: ['stands', 'stood', 'standing'],
  teach: ['teaches', 'taught', 'teaching'],
  understand: ['understands', 'understood'],
  forget: ['forgets', 'forgot', 'forgotten', 'forgetting'],
  wake: ['wakes', 'woke', 'woken', 'waking']
};

export function expandEnglishCandidates(rawStr) {
  if (!rawStr) return [];
  const cleaned = String(rawStr).replace(/\([^)]*\)/g, ' ');
  const parts = cleaned.split(/[\/,;]+/).map(x => x.trim().replace(/^to\s+/i, '').trim()).filter(Boolean);
  const out = new Set();
  for (const phrase of parts) {
    out.add(phrase);
    const low = phrase.toLowerCase();
    if (!low.includes(' ')) {
      if (EN_IRREGULARS[low]) EN_IRREGULARS[low].forEach(f => out.add(f));
      out.add(low + 's');
      out.add(low + 'es');
      out.add(low + 'ed');
      out.add(low + 'd');
      out.add(low + 'ing');
      if (low.endsWith('e') && low.length > 2) out.add(low.slice(0, -1) + 'ing');
      if (low.endsWith('y') && low.length > 2) {
        out.add(low.slice(0, -1) + 'ies');
        out.add(low.slice(0, -1) + 'ied');
      }
    }
  }
  return Array.from(out).sort((a, b) => b.length - a.length);
}

export const PT_CONTRACTION_EN_PHRASES = {
  pro: ['to the', 'for the', 'into the', 'onto the', 'at the'],
  pra: ['to the', 'for the', 'into the', 'onto the', 'at the'],
  pros: ['to the', 'for the', 'into the', 'onto the', 'at the'],
  pras: ['to the', 'for the', 'into the', 'onto the', 'at the'],
  do: ['of the', 'from the', 'about the'],
  da: ['of the', 'from the', 'about the'],
  dos: ['of the', 'from the', 'about the'],
  das: ['of the', 'from the', 'about the'],
  no: ['in the', 'on the', 'at the', 'into the'],
  na: ['in the', 'on the', 'at the', 'into the'],
  nos: ['in the', 'on the', 'at the', 'into the'],
  nas: ['in the', 'on the', 'at the', 'into the'],
  ao: ['to the', 'at the'],
  'à': ['to the', 'at the'],
  aos: ['to the', 'at the'],
  'às': ['to the', 'at the'],
  pelo: ['by the', 'through the', 'for the', 'along the', 'around the'],
  pela: ['by the', 'through the', 'for the', 'along the', 'around the'],
  pelos: ['by the', 'through the', 'for the', 'along the', 'around the'],
  pelas: ['by the', 'through the', 'for the', 'along the', 'around the'],
  num: ['in a', 'in an', 'on a', 'at a'],
  numa: ['in a', 'in an', 'on a', 'at a'],
  nuns: ['in some', 'on some'],
  numas: ['in some', 'on some'],
  dum: ['of a', 'of an', 'from a', 'from an'],
  duma: ['of a', 'of an', 'from a', 'from an'],
  duns: ['of some', 'from some'],
  dumas: ['of some', 'from some']
};
export const BARE_EN_ARTICLES = new Set(['the', 'a', 'an']);

export function renderHighlightedEnglish(container, enSentence, hintEn = '', enGloss = '', answerPt = '') {
  container.textContent = '';
  const text = String(enSentence || '');
  if (!text) return { matched: false };
  const ansKey = normNFC(answerPt);
  const contrPhrases = PT_CONTRACTION_EN_PHRASES[ansKey] || [];
  const rawCands = [...contrPhrases, ...expandEnglishCandidates(hintEn), ...expandEnglishCandidates(enGloss)];
  const hasMultiWordTarget = contrPhrases.length > 0 || rawCands.some(c => /\s/.test(c));
  const uniqueCands = Array.from(new Set(rawCands.map(c => String(c || '').trim()).filter(Boolean)))
    .filter(c => !(hasMultiWordTarget && BARE_EN_ARTICLES.has(c.toLowerCase())))
    .sort((a, b) => {
      const aw = a.split(/\s+/).length, bw = b.split(/\s+/).length;
      if (bw !== aw) return bw - aw;
      return b.length - a.length;
    });
  let bestMatch = null;
  for (const cand of uniqueCands) {
    const re = new RegExp(`(?<![A-Za-z])(${escapeRegex(cand)})(?![A-Za-z])`, 'i');
    const m = re.exec(text);
    if (m) { bestMatch = { index: m.index, text: m[1] }; break; }
  }
  if (!bestMatch) {
    container.appendChild(document.createTextNode(text));
    return { matched: false };
  }
  if (bestMatch.index > 0) container.appendChild(document.createTextNode(text.slice(0, bestMatch.index)));
  const hl = document.createElement('span');
  hl.className = 'en-target-hl';
  hl.textContent = bestMatch.text;
  container.appendChild(hl);
  const endIdx = bestMatch.index + bestMatch.text.length;
  if (endIdx < text.length) container.appendChild(document.createTextNode(text.slice(endIdx)));
  return { matched: true };
}

export const ICON_BOOK_CLOSED_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h8"/></svg>';

export function buildPosPill(pos, compact = false) {
  const sp = document.createElement('span');
  sp.className = `badge ${getPosPillClass(pos)}${compact ? ' badge-compact' : ''}`;
  sp.textContent = formatPOS(pos);
  return sp;
}

export function buildGenderPill(gender, compact = false) {
  if (!gender) return null;
  const sp = document.createElement('span');
  const cCls = compact ? ' badge-compact' : '';
  if (gender === 'm') {
    sp.className = `badge pill-icon-wrap pill-masc${cCls}`;
    setPillWithIcon(sp, 'm', compact ? 'Masc.' : 'Masculine');
    return sp;
  }
  if (gender === 'f') {
    sp.className = `badge pill-icon-wrap pill-fem${cCls}`;
    setPillWithIcon(sp, 'f', compact ? 'Fem.' : 'Feminine');
    return sp;
  }
  if (gender === 'mf') {
    sp.className = `badge pill-mf${cCls}`;
    sp.textContent = 'Masc. / Fem.';
    return sp;
  }
  return null;
}

export function buildNumberPill(number, compact = false) {
  if (!number) return null;
  const sp = document.createElement('span');
  const cCls = compact ? ' badge-compact' : '';
  const numCls = number === 'sg' ? 'pill-sg' : 'pill-pl';
  sp.className = `badge pill-icon-wrap pill-slot-num ${numCls}${cCls}`;
  setPillWithIcon(sp, number, number === 'sg' ? 'Singular' : 'Plural');
  return sp;
}

export function getSlotPillClass(slotOrLabel) {
  const raw = String(slotOrLabel || '').toLowerCase().trim();
  if (!raw) return 'pill-nonfinite';
  if (raw === 'inf' || raw === 'ger' || raw === 'part' || /infinitive|gerund|participle/.test(raw)) return 'pill-nonfinite';
  if (raw.includes('1sg=3sg') || raw.includes('3sg') || raw.includes('você') || raw.includes('voce') || raw.includes('ele')) return 'pill-person-3sg';
  if (raw.includes('1sg') || raw === 'eu' || raw.endsWith('· eu') || raw.includes('· eu')) return 'pill-person-1sg';
  if (raw.includes('1pl') || raw.includes('nós') || raw.includes('nos')) return 'pill-person-1pl';
  if (raw.includes('3pl') || raw.includes('eles') || raw.includes('vocês') || raw.includes('voces')) return 'pill-person-3pl';
  return 'pill-nonfinite';
}

export function buildSlotPill(slotLabel, compact = false, slotKey = '') {
  const clean = String(slotLabel || '').trim();
  if (!clean) return null;
  const sp = document.createElement('span');
  const cls = getSlotPillClass(slotKey || clean);
  sp.className = `badge ${cls}${compact ? ' badge-compact' : ''}`;
  sp.textContent = clean;
  return sp;
}

export function formatLexiconDisplayLemma(entry) {
  if (!entry) return '';
  const lem = String(entry.lemma || '').trim();
  const pos = String(entry.pos || '').toUpperCase();
  if (pos !== 'NOUN' && pos !== 'ADJ') return lem;
  const low = normNFC(lem);
  if (typeof FEM_O_NOUNS !== 'undefined' && FEM_O_NOUNS.has(low)) return lem;
  const forms = Array.isArray(entry.forms) ? entry.forms.map(f => String(f || '').trim()).filter(Boolean) : [];
  const formSet = new Map();
  forms.forEach(f => { const n = normNFC(f); if (n && !formSet.has(n)) formSet.set(n, f); });
  const candidates = [];
  if (low === 'bom') candidates.push('boa');
  else if (low === 'mau') candidates.push('má');
  else if (low.endsWith('ão')) candidates.push(low.slice(0, -2) + 'ã', low.slice(0, -2) + 'ona');
  else if (low.endsWith('ês')) candidates.push(low.slice(0, -2) + 'esa');
  else if (low.endsWith('or')) candidates.push(low + 'a');
  else if (low.endsWith('eu')) candidates.push(low.slice(0, -2) + 'eia');
  else if (low.endsWith('o') && low.length > 2) candidates.push(low.slice(0, -1) + 'a');
  for (const c of candidates) {
    if (formSet.has(c) && c !== low) {
      return `${lem} / ${formSet.get(c)}`;
    }
  }
  return lem;
}

export function resolveEntryBaseGender(entry) {
  if (!entry) return null;
  const pos = String(entry.pos || '').toUpperCase();
  if (!['NOUN', 'CONTR', 'DET', 'PRON'].includes(pos)) return null;
  const tags = resolveGrammaticalTags(entry, { answer: entry.lemma, pt: entry.lemma, hint_en: entry.en_gloss });
  if (tags && tags.gender) return tags.gender;
  if (entry.gender === 'm' || entry.gender === 'f' || entry.gender === 'mf') return entry.gender;
  return null;
}

export function getCombinedNoteText(entry, ex) {
  const parts = [];
  const seen = new Set();
  const pushNote = txt => {
    const clean = String(txt || '').trim();
    if (!clean) return;
    const k = normNFC(clean);
    if (seen.has(k)) return;
    seen.add(k);
    parts.push(clean);
  };
  if ((entry && entry.false_friend) || (ex && ex.false_friend_note)) {
    pushNote((ex && ex.false_friend_note) ? `False friend: ${ex.false_friend_note}` : `False friend: "${entry.lemma}" = ${entry.en_gloss}`);
  }
  if (ex && ex.grammar_note_en) pushNote(ex.grammar_note_en);
  if (ex && ex.usage_note) pushNote(ex.usage_note);
  if (entry && entry.grammar_note_en) pushNote(entry.grammar_note_en);
  if (entry && entry.usage_note) pushNote(entry.usage_note);
  return parts.join(' · ');
}

export const ICON_EYE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
export const ICON_EYE_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

export function preserveInitialCase(matched, replacement) {
  if (!matched || !replacement) return replacement;
  const first = matched[0];
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export const SAFE_COLLOQUIAL_CONTEXT_RULES = [
  [/(?<![\p{L}\p{M}])tô(?![\p{L}\p{M}])/giu, 'estou'],
  [/(?<![\p{L}\p{M}])tá(?![\p{L}\p{M}])/giu, 'está'],
  [/(?<![\p{L}\p{M}])tava(?![\p{L}\p{M}])/giu, 'estava'],
  [/(?<![\p{L}\p{M}])tavam(?![\p{L}\p{M}])/giu, 'estavam'],
  [/(?<![\p{L}\p{M}])tamos(?![\p{L}\p{M}])/giu, 'estamos'],
  [/(?<![\p{L}\p{M}])tamo(?![\p{L}\p{M}])/giu, 'estamos'],
  [/(?<![\p{L}\p{M}])cê(?![\p{L}\p{M}])/giu, 'você'],
  [/(?<![\p{L}\p{M}])cês(?![\p{L}\p{M}])/giu, 'vocês'],
  [/(?<![\p{L}\p{M}])pro(?![\p{L}\p{M}])/giu, 'para o'],
  [/(?<![\p{L}\p{M}])pros(?![\p{L}\p{M}])/giu, 'para os'],
  [/(?<![\p{L}\p{M}])pras(?![\p{L}\p{M}])/giu, 'para as'],
  [/(?<![\p{L}\p{M}])pra(?=\s+(?:mim|você|vocês|ele|ela|eles|elas|nós|isso|isto|aquilo|casa|cá|lá|onde|fazer|ir|ver|ter|dar|vir|falar|comer|beber|dormir|trabalhar|estudar|comprar|pagar|ajudar|sair|voltar|entrar|ficar|começar|terminar)(?![\p{L}\p{M}]))/giu, 'para']
];

export function normalizeColloquialSegment(seg) {
  let out = String(seg || '');
  if (!out) return out;
  for (const [rx, repl] of SAFE_COLLOQUIAL_CONTEXT_RULES) {
    out = out.replace(rx, m => preserveInitialCase(m, repl));
  }
  return out;
}

export function isColloquialContextDeferred() {
  if (!userStore || !userStore.settings || !userStore.settings.deferColloquial) return false;
  return getStudiedBaseLemmaIds().length < 100;
}

export function normalizeColloquialContext(ex, isColloquialActive = isColloquialContextDeferred()) {
  const split = buildClozeSplit(ex);
  if (!isColloquialActive) {
    return { before: split.before, answer: split.answer, after: split.after, pt: split.before + split.answer + split.after };
  }
  const before = normalizeColloquialSegment(split.before);
  const after = normalizeColloquialSegment(split.after);
  return { before, answer: split.answer, after, pt: before + split.answer + after };
}

export function renderCorrectedWordWithHighlight(container, targetWord, userTyped = '') {
  container.textContent = '';
  const target = String(targetWord || '').normalize('NFC');
  const typed = String(userTyped || '').trim().normalize('NFC');
  if (!typed || target.toLowerCase() === typed.toLowerCase()) {
    container.appendChild(document.createTextNode(target));
    return container;
  }

  const tChars = Array.from(target);
  const uChars = Array.from(typed);
  const tLow = tChars.map(c => c.toLowerCase());
  const uLow = uChars.map(c => c.toLowerCase());
  const m = tLow.length;
  const n = uLow.length;

  // Weighted Levenshtein / Needleman-Wunsch alignment (exact=0, diacritic-fold=0.4, sub/ins/del=1)
  const dp = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let i = 1; i <= m; i++) dp[i][0] = i;
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      let subCost = 1;
      if (tLow[i - 1] === uLow[j - 1]) subCost = 0;
      else if (foldMarks(tLow[i - 1]) === foldMarks(uLow[j - 1])) subCost = 0.4;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + subCost,
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1
      );
    }
  }

  const exactMatchedIdx = new Set();
  let i = m, j = n;
  while (i > 0 && j > 0) {
    let subCost = 1;
    if (tLow[i - 1] === uLow[j - 1]) subCost = 0;
    else if (foldMarks(tLow[i - 1]) === foldMarks(uLow[j - 1])) subCost = 0.4;
    if (Math.abs(dp[i][j] - (dp[i - 1][j - 1] + subCost)) < 1e-6) {
      if (subCost === 0) exactMatchedIdx.add(i - 1);
      i--; j--;
    } else if (Math.abs(dp[i][j] - (dp[i - 1][j] + 1)) < 1e-6) {
      i--;
    } else {
      j--;
    }
  }

  tChars.forEach((ch, idx) => {
    if (exactMatchedIdx.has(idx)) {
      container.appendChild(document.createTextNode(ch));
    } else {
      const mk = document.createElement('mark');
      if (ch === ' ') {
        mk.className = 'char-fix-hl char-fix-space';
        mk.textContent = '\u00A0';
      } else {
        mk.className = 'char-fix-hl';
        mk.textContent = ch;
      }
      container.appendChild(mk);
    }
  });
  return container;
}

export function renderClozeSentence(container, ex, opts = {}) {
  const { revealed = false, typed = '', revealedPrefixLen = 0, gapState = '', onGapTap = null, lemmaId = null, userTyped = '' } = opts;
  container.textContent = '';
  const split = normalizeColloquialContext(ex);
  container.appendChild(document.createTextNode(split.before));
  if (revealed) {
    const strong = document.createElement('strong');
    strong.className = `cloze-revealed ${gapState}`.trim();
    if (userTyped && normNFC(userTyped.trim()) !== normNFC(split.answer)) {
      renderCorrectedWordWithHighlight(strong, split.answer, userTyped);
    } else {
      strong.textContent = split.answer;
    }
    const targetLemmaId = lemmaId || (ex && ex.lemmaId) || null;
    if (targetLemmaId) {
      strong.setAttribute('data-open-word-detail', targetLemmaId);
      strong.setAttribute('role', 'button');
      strong.setAttribute('tabindex', '0');
      strong.addEventListener('click', e => {
        e.stopPropagation();
        appActions.openWordDetail(targetLemmaId);
      });
    }
    container.appendChild(strong);
  } else {
    container.appendChild(renderMask(split.answer, typed, revealedPrefixLen, gapState, onGapTap));
  }
  container.appendChild(document.createTextNode(split.after));
}

export function mountExample(container, ex, opts = {}) {
  return renderClozeSentence(container, ex, opts);
}

export function updateLiveBlankMirror(container, ex, typedValue, opts = {}) {
  return renderClozeSentence(container, ex, {
    revealed: false,
    typed: String(typedValue || ''),
    revealedPrefixLen: opts.revealedPrefixLen || 0,
    gapState: opts.gapState || '',
    onGapTap: opts.onGapTap || null
  });
}

export function renderCorrectionProgress(container, ex, typed = '') {
  container.textContent = '';
  const split = normalizeColloquialContext(ex);
  container.appendChild(document.createTextNode(split.before));

  const box = document.createElement('span');
  box.className = 'corr-blank-box';
  const targetChars = Array.from(String(split.answer || ''));
  const typedChars = Array.from(String(typed || ''));
  const strict = Boolean(userStore.settings.strictDiacritics);
  const charsMatch = (a, b) => strict ? normNFC(a) === normNFC(b) : foldMarks(a) === foldMarks(b);

  let hadMismatch = false;
  targetChars.forEach((ch, idx) => {
    const sp = document.createElement('span');
    sp.textContent = ch;
    if (idx < typedChars.length) {
      if (!hadMismatch && charsMatch(typedChars[idx], ch)) {
        sp.className = 'corr-char-ok';
      } else {
        hadMismatch = true;
        sp.className = 'corr-char-err';
      }
    } else {
      sp.className = 'corr-char-todo';
    }
    box.appendChild(sp);
  });

  container.appendChild(box);
  container.appendChild(document.createTextNode(split.after));
}


export const FEEDBACK_TONE_CLASS = {
  ok: 'fb-ok',
  good: 'fb-ok',
  soft_ok: 'fb-soft-ok',
  accepted: 'fb-soft-ok',
  warn: 'fb-amber',
  error: 'fb-rose',
  info: 'fb-info'
};

export function renderFeedbackBanner({
  tone = 'info',
  statusText = '',
  wordText = '',
  userTyped = '',
  lemmaId = null,
  instructionText = '',
  showIWasWrong = undefined,
  isNonSrsDrill = false,
  showNotes = false,
  diffFrag = null,
  diffLabel = '',
  targetNote = null,
  ex = null,
  entry = null
} = {}, targetIds = null) {
  const isPassingTone = tone === 'ok' || tone === 'soft_ok' || tone === 'good' || tone === 'accepted';
  const nonSrs = Boolean(isNonSrsDrill || (targetIds && targetIds.overrideId === null));
  if (showIWasWrong === undefined) {
    showIWasWrong = isPassingTone && !nonSrs && session.mode === 'study';
  }
  const ids = targetIds || {
    bannerId: 'sc-feedback-banner',
    msgId: 'sc-feedback-msg',
    subId: 'sc-feedback-sub',
    overrideId: 'btn-override-wrong'
  };
  const banner = el(ids.bannerId);
  const msg = el(ids.msgId);
  const subEl = ids.subId ? el(ids.subId) : null;
  if (!banner || !msg) return;
  const cls = FEEDBACK_TONE_CLASS[tone] || 'fb-info';
  banner.className = `feedback-banner ${cls}`;
  banner.classList.remove('hidden');

  msg.textContent = '';
  if (statusText) {
    const st = document.createElement('span');
    st.className = 'fb-status';
    st.textContent = statusText;
    msg.appendChild(st);
  }
  if (wordText) {
    const wd = document.createElement('button');
    wd.type = 'button';
    wd.className = 'fb-word';
    if (userTyped && normNFC(userTyped.trim()) !== normNFC(wordText)) {
      renderCorrectedWordWithHighlight(wd, wordText, userTyped);
    } else {
      wd.textContent = wordText;
    }
    if (lemmaId) {
      wd.dataset.openWordDetail = lemmaId;
      wd.addEventListener('click', e => {
        e.stopPropagation();
        appActions.openWordDetail(lemmaId);
      });
    }
    msg.appendChild(wd);
  }
  if (instructionText) {
    const instr = document.createElement('span');
    instr.className = 'fb-instr';
    instr.textContent = instructionText;
    msg.appendChild(instr);
  }

  if (subEl) {
    subEl.textContent = '';
    if (showNotes) {
      const unified = buildUnifiedPostAnswerSub(entry, ex, {
        diffFrag,
        diffLabel,
        targetVariantNote: targetNote
      });
      if (unified) {
        subEl.appendChild(unified);
        subEl.classList.remove('hidden');
      } else {
        subEl.classList.add('hidden');
      }
    } else {
      subEl.classList.add('hidden');
    }
  }
  if (ids.overrideId && el(ids.overrideId)) {
    el(ids.overrideId).classList.toggle('hidden', !showIWasWrong);
  }
}


export function getPosPillClass(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'VERB') return 'pill-verb';
  if (p === 'NOUN') return 'pill-noun';
  if (p === 'ADJ') return 'pill-adj';
  if (p === 'ADV') return 'pill-adv';
  return 'pill-other';
}

export function stripRedundantGenderNumberHint(hintText, hasGenderOrNumberPills = true) {
  const text = String(hintText || '').trim();
  if (!text || !hasGenderOrNumberPills) return text;
  const tokenRe = /^(?:m|f|mf|m\/f|masc|fem|masculine|feminine|sg|pl|sing|singular|plural)\.?$/i;
  const cleaned = text.replace(/\s*\(([^()]+)\)/g, (full, inner) => {
    const parts = inner.split(/[\s,;·/]+/).map(x => x.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every(tok => tokenRe.test(tok))) return '';
    return full;
  });
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

export const PT_GRAMMAR_LOOKUP = {};
[
  ['m', 'sg', ['dele','nele','deste','desse','daquele','neste','nesse','naquele','o','um','do','no','ao','pelo','num','dum','pro','este','esse','aquele','ele','meu','teu','seu','nosso','vosso','todo','outro','muito','pouco','algum','nenhum','mesmo','próprio','tanto','quanto','certo','único']],
  ['f', 'sg', ['dela','nela','desta','dessa','daquela','nesta','nessa','naquela','a','uma','da','na','à','pela','numa','duma','pra','esta','essa','aquela','ela','minha','tua','sua','nossa','vossa','toda','outra','muita','pouca','alguma','nenhuma','mesma','própria','tanta','quanta','certa','única']],
  ['m', 'pl', ['deles','neles','destes','desses','daqueles','nestes','nesses','naqueles','os','uns','dos','nos','aos','pelos','nuns','duns','pros','estes','esses','aqueles','eles','meus','teus','seus','nossos','vossos','todos','outros','muitos','poucos','alguns','nenhuns','mesmos','próprios','tantos','quantos','certos','vários','ambos','dois','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos']],
  ['f', 'pl', ['delas','nelas','destas','dessas','daquelas','nestas','nessas','naquelas','as','umas','das','nas','às','pelas','numas','dumas','pras','estas','essas','aquelas','elas','minhas','tuas','suas','nossas','vossas','todas','outras','muitas','poucas','algumas','nenhumas','mesmas','próprias','tantas','quantas','certas','várias','ambas','duas','duzentas','trezentas','quatrocentas','quinhentas','seiscentas','setecentas','oitocentas','novecentas']]
].forEach(([g, n, words]) => words.forEach(w => { PT_GRAMMAR_LOOKUP[normNFC(w)] = { gender: g, number: n }; }));

export const GENDERLESS_PRONOUNS_AND_CONTRS = new Set([
  'isto','isso','aquilo','disto','disso','daquilo','nisto','nisso','naquilo',
  'tudo','algo','alguém','ninguém','nada','quem','que','qual','quais',
  'eu','tu','você','vocês','nós','a gente','me','te','se','nos','lhe','lhes',
  'mim','ti','comigo','contigo','consigo','conosco','cada','qualquer','quaisquer'
].map(normNFC));
export const GENDERLESS_PLURAL_SET = new Set(['quais','quaisquer','vocês','nós','lhes'].map(normNFC));

export const MASC_A_NOUNS = new Set([
  'dia','problema','sistema','tema','clima','programa','cinema','mapa','idioma',
  'planeta','sofá','pijama','poema','fantasma','drama','trauma','dilema','esquema',
  'aroma','sintoma','diploma','telegrama','cometa','samba','guaraná','maracujá','tapa','atleta'
].map(normNFC));
export const FEM_O_NOUNS = new Set(['mão','foto','moto','tribo','libido'].map(normNFC));
export const SINGULAR_S_NOUNS = new Set([
  'país','mês','ônibus','lápis','tênis','vírus','cais','atlas','pires','gás','estresse','tórax'
].map(normNFC));
export const INVARIABLE_ADJS = new Set([
  'grande','feliz','fácil','difícil','triste','simples','verde','azul','cinza','marrom',
  'laranja','rosa','inteligente','importante','possível','impossível','diferente','igual',
  'melhor','pior','maior','menor','superior','inferior','anterior','posterior','exterior','interior',
  'jovem','forte','doce','leve','quente','livre','breve','pobre','nobre','comum','útil','gentil',
  'real','legal','normal','natural','social','local','geral','atual','especial','principal','central','final','total'
].map(normNFC));
export const LOOKUP_ELIGIBLE_POS = new Set(['CONTR', 'DET', 'PRON', 'NUM', 'ADJ']);

export function isRegularPluralOf(ans, lem) {
  if (!ans || !lem || ans === lem) return false;
  if (ans === lem + 's' || ans === lem + 'es') return true;
  if (lem.endsWith('m') && ans === lem.slice(0, -1) + 'ns') return true;
  if (lem.endsWith('al') && ans === lem.slice(0, -2) + 'ais') return true;
  if (lem.endsWith('el') && (ans === lem.slice(0, -2) + 'éis' || ans === lem.slice(0, -2) + 'eis')) return true;
  if (lem.endsWith('ol') && (ans === lem.slice(0, -2) + 'óis' || ans === lem.slice(0, -2) + 'ois')) return true;
  if (lem.endsWith('ul') && ans === lem.slice(0, -2) + 'uis') return true;
  if (lem.endsWith('il') && (ans === lem.slice(0, -2) + 'is' || ans === lem.slice(0, -2) + 'eis')) return true;
  if (lem.endsWith('ão') && (ans === lem.slice(0, -2) + 'ões' || ans === lem.slice(0, -2) + 'ães' || ans === lem.slice(0, -2) + 'ãos')) return true;
  if (lem.endsWith('ês') && ans === lem.slice(0, -2) + 'eses') return true;
  if (lem.endsWith('ís') && ans === lem.slice(0, -2) + 'íses') return true;
  return false;
}

export function resolveGrammaticalTags(entry, ex) {
  let gender = null;
  let number = null;
  const pos = String((entry && entry.pos) || '').toUpperCase();
  const slot = String((ex && (ex.inflection || ex.slot)) || '').toLowerCase();
  const ans = normNFC((ex && ex.answer) || (entry && entry.lemma) || '');
  const lem = normNFC((entry && entry.lemma) || '');

  // Always strip gender/number parentheticals from hint_en first
  const rawHint = String((ex && (ex.clean_hint_en || ex.hint_en)) || (entry && entry.en_gloss) || '').trim();
  const gTokenRe = /^(m|f|mf|m\/f|masc|fem|masculine|feminine)\.?$/i;
  const nTokenRe = /^(sg|pl|sing|singular|plural)\.?$/i;
  let hintGender = null, hintNumber = null;
  const cleanedHint = rawHint.replace(/\s*\(([^()]+)\)/g, (full, inner) => {
    const segments = inner.split(/([,;·/.]+|\s+)/);
    const kept = [];
    let extractedAny = false;
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (!trimmed || /^[,;·/.]+$/.test(trimmed)) continue;
      const gm = trimmed.match(gTokenRe);
      if (gm) {
        const code = gm[1].toLowerCase();
        if (!hintGender) {
          if (code === 'mf' || code === 'm/f') hintGender = 'mf';
          else if (code.startsWith('f')) hintGender = 'f';
          else if (code.startsWith('m')) hintGender = 'm';
        }
        extractedAny = true;
        continue;
      }
      const nm = trimmed.match(nTokenRe);
      if (nm) {
        const code = nm[1].toLowerCase();
        if (!hintNumber) {
          if (code.startsWith('p')) hintNumber = 'pl';
          else if (code.startsWith('s')) hintNumber = 'sg';
        }
        extractedAny = true;
        continue;
      }
      kept.push(trimmed);
    }
    if (!extractedAny) return full;
    if (kept.length === 0) return '';
    return ` (${kept.join(' ')})`;
  }).replace(/\s{2,}/g, ' ').trim();

  // 1. Explicit Neuter / Genderless Guard
  const isInflectedParticiple = pos === 'VERB' && slot.includes('part') && (ans.endsWith('a') || ans.endsWith('os') || ans.endsWith('as'));
  if (['VERB', 'ADV', 'CONJ', 'ADP', 'INTJ'].includes(pos) && !isInflectedParticiple) {
    return { gender: null, number: null, cleanedHint };
  }
  if (GENDERLESS_PRONOUNS_AND_CONTRS.has(ans)) {
    return { gender: null, number: GENDERLESS_PLURAL_SET.has(ans) ? 'pl' : null, cleanedHint };
  }

  // 2. Explicit Example Metadata (ex.inflection / ex.slot / parsed hint_en)
  if (slot && slot !== 'base') {
    const parts = slot.split(/[._\s/-]+/).filter(Boolean);
    if (parts.includes('mf')) gender = 'mf';
    else if (parts.includes('f') || parts.includes('fem')) gender = 'f';
    else if (parts.includes('m') || parts.includes('masc')) gender = 'm';
    if (parts.includes('pl') || parts.includes('plural')) number = 'pl';
    else if (parts.includes('sg') || parts.includes('sing') || parts.includes('singular')) number = 'sg';
  }
  if (!gender && hintGender) gender = hintGender;
  if (!number && hintNumber) number = hintNumber;

  // 3. Complete Contraction, Determiner, Pronoun & Numeral Table (keyed strictly on ex.answer)
  if (LOOKUP_ELIGIBLE_POS.has(pos) && PT_GRAMMAR_LOOKUP[ans]) {
    const hit = PT_GRAMMAR_LOOKUP[ans];
    if (!gender) gender = hit.gender;
    if (!number) number = hit.number;
  }

  // 4. Inflected Morphology Relative to entry.lemma (ADJ, variable NOUN, DET, PRON, VERB part)
  const isInvarAdj = pos === 'ADJ' && (INVARIABLE_ADJS.has(lem) || INVARIABLE_ADJS.has(ans));
  if (isInvarAdj) {
    gender = null;
    if (!number) {
      if (ans === 'simples') number = null;
      else number = isRegularPluralOf(ans, lem) ? 'pl' : 'sg';
    }
    return { gender, number, cleanedHint };
  }

  if (['ADJ', 'NOUN', 'DET', 'PRON'].includes(pos) || isInflectedParticiple) {
    if (lem === 'bom') {
      if (ans === 'boa') { gender = 'f'; number = 'sg'; }
      else if (ans === 'boas') { gender = 'f'; number = 'pl'; }
      else if (ans === 'bons') { gender = 'm'; number = 'pl'; }
      else if (ans === 'bom') { gender = 'm'; number = 'sg'; }
    } else if (lem === 'mau') {
      if (ans === 'má') { gender = 'f'; number = 'sg'; }
      else if (ans === 'más') { gender = 'f'; number = 'pl'; }
      else if (ans === 'maus') { gender = 'm'; number = 'pl'; }
      else if (ans === 'mau') { gender = 'm'; number = 'sg'; }
    } else if (lem === 'ator') {
      if (ans === 'atriz') { gender = 'f'; number = 'sg'; }
      else if (ans === 'atrizes') { gender = 'f'; number = 'pl'; }
    } else if (lem === 'homem' && ans === 'homens') {
      gender = 'm'; number = 'pl';
    } else if (lem === 'mulher' && ans === 'mulheres') {
      gender = 'f'; number = 'pl';
    } else if (lem.endsWith('o') && !FEM_O_NOUNS.has(lem)) {
      const stem = lem.slice(0, -1);
      if (ans === stem + 'a') { gender = 'f'; number = 'sg'; }
      else if (ans === stem + 'as') { gender = 'f'; number = 'pl'; }
      else if (ans === stem + 'os') { gender = 'm'; number = 'pl'; }
      else if (ans === lem && (pos === 'ADJ' || isInflectedParticiple)) { gender = 'm'; number = 'sg'; }
    } else if (lem.endsWith('or') && !INVARIABLE_ADJS.has(lem)) {
      if (ans === lem + 'a') { gender = 'f'; number = 'sg'; }
      else if (ans === lem + 'as') { gender = 'f'; number = 'pl'; }
      else if (ans === lem + 'es') { gender = 'm'; number = 'pl'; }
    } else if (lem.endsWith('ês')) {
      const stem = lem.slice(0, -2);
      if (ans === stem + 'esa') { gender = 'f'; number = 'sg'; }
      else if (ans === stem + 'esas') { gender = 'f'; number = 'pl'; }
      else if (ans === stem + 'eses') { gender = 'm'; number = 'pl'; }
    } else if (lem.endsWith('ão')) {
      const stem = lem.slice(0, -2);
      if (ans === stem + 'ã' || ans === stem + 'ona') { gender = 'f'; number = 'sg'; }
      else if (ans === stem + 'ãs' || ans === stem + 'onas') { gender = 'f'; number = 'pl'; }
      else if (ans === stem + 'ões' || ans === stem + 'ães' || ans === stem + 'ãos') { number = 'pl'; }
    } else if (lem.endsWith('eu')) {
      const stem = lem.slice(0, -2);
      if (ans === stem + 'eia') { gender = 'f'; number = 'sg'; }
      else if (ans === stem + 'eias') { gender = 'f'; number = 'pl'; }
      else if (ans === stem + 'eus') { gender = 'm'; number = 'pl'; }
    }

    if (!number) {
      if (SINGULAR_S_NOUNS.has(lem) && ans === lem) number = 'sg';
      else if (isRegularPluralOf(ans, lem)) number = 'pl';
    }
  }

  // 5. Portuguese Sentence Context Cross-Check (beforeText in ex.pt for NOUNs)
  if (pos === 'NOUN' && ex && ex.pt) {
    const sp = buildClozeSplit(ex);
    const prevToks = String(sp.before || '').trim().match(/[\p{L}\p{M}]+/gu);
    const prevWord = prevToks && prevToks.length > 0 ? normNFC(prevToks[prevToks.length - 1]) : '';
    const ctxHit = prevWord ? PT_GRAMMAR_LOOKUP[prevWord] : null;
    if (ctxHit) {
      if (!gender || gender === 'mf' || (entry && entry.gender === 'mf')) gender = ctxHit.gender;
      if (SINGULAR_S_NOUNS.has(lem) || !number) number = ctxHit.number;
    }
  }

  // 6. Safe Base-Lemma Fallback (ONLY when still null)
  if (pos === 'NOUN') {
    if (!gender) {
      if (MASC_A_NOUNS.has(lem)) gender = 'm';
      else if (FEM_O_NOUNS.has(lem)) gender = 'f';
      else if (entry && (entry.gender === 'm' || entry.gender === 'f' || entry.gender === 'mf')) gender = entry.gender;
    }
    if (!number) number = 'sg';
  } else if (pos === 'ADJ') {
    if (!gender && ans === lem && !isInvarAdj && entry && (entry.gender === 'm' || entry.gender === 'f')) {
      gender = entry.gender;
    }
    if (!number) number = 'sg';
  }

  return { gender, number, cleanedHint };
}

export function formatRecallTag(entry, ex) {
  const pos = String((entry && entry.pos) || '').toUpperCase();
  const slot = String((ex && (ex.slot || ex.inflection)) || '').toLowerCase();
  if (pos === 'VERB' && !slot.includes('part')) {
    const disp = formatSlot(slot).display;
    return disp ? { label: disp, tint: getSlotPillClass(slot || disp), gender: null, number: null } : null;
  }
  const tags = resolveGrammaticalTags(entry, ex);
  const gMap = { m: 'Masc.', f: 'Fem.', mf: 'Masc. / Fem.' };
  const nMap = { sg: 'Sing.', pl: 'Pl.' };
  const gLabel = tags.gender ? gMap[tags.gender] : null;
  const nLabel = tags.number ? nMap[tags.number] : null;
  const tint = tags.gender === 'f' ? 'pill-fem' : (tags.gender === 'm' ? 'pill-masc' : (tags.gender === 'mf' ? 'pill-mf' : 'pill-slot-num'));
  if (gLabel && nLabel) return { label: `${gLabel} · ${nLabel}`, tint, gender: tags.gender, number: tags.number };
  if (gLabel) return { label: gLabel, tint, gender: tags.gender, number: null };
  if (nLabel) return { label: nLabel, tint, gender: null, number: tags.number };
  const disp = formatSlot(slot).display;
  return disp && slot !== 'base' ? { label: disp, tint: 'pill-slot-num', gender: null, number: null } : null;
}

export const EN_PROSE_STOPLIST = new Set([
  'a','an','the','of','to','in','on','at','for','by','with','from','is','are','was','were','be','been','being',
  'do','does','did','done','no','not','or','and','but','as','if','it','its','he','him','his','she','her','hers',
  'we','us','our','you','your','they','them','their','i','me','my','mine',
  'so','up','out','off','down','over','under','into','onto','through','across','around','about','above','below',
  'between','among','against','during','without','within','through','before','after','since','until','while',
  'use','used','uses','using','word','words','form','forms','tense','tenses','past','present','future','imperfect',
  'perfect','subjunctive','infinitive','gerund','participle','imperative','indicative','conditional',
  'singular','plural','masculine','feminine','gender','number','person','first','second','third','subject','object',
  'spoken','colloquial','formal','informal','standard','brazilian','portuguese','english','literal','literally','lit',
  'means','mean','meaning','meant','translate','translates','translated','translation','equivalent','similar',
  'like','more','most','less','least','very','much','many','some','any','all','every','each','both','either','neither',
  'than','then','this','that','these','those','here','there','when','where','what','which','who','whom','whose','why','how',
  'only','also','too','just','even','still','already','yet','ever','always','never','often','usually','sometimes','rarely',
  'instead','rather','actually','really','simply','especially','commonly','frequently','typically','normally','generally',
  'can','cannot','may','might','must','will','would','could','should','shall','has','have','had','having',
  'one','two','three','four','five','six','seven','eight','nine','ten','once','twice',
  'see','seen','saw','look','looks','find','found','make','makes','made','take','takes','took','give','gives','gave',
  'get','gets','got','go','goes','went','gone','come','comes','came','say','says','said','tell','tells','told',
  'know','knows','knew','think','thinks','thought','want','wants','need','needs','feel','feels','felt','seem','seems',
  'become','becomes','stay','stays','keep','keeps','put','puts','leave','leaves','left','call','called','try','tries',
  'ask','asks','work','works','play','plays','live','lives','move','moves','turn','turns','hold','holds','bring','brings',
  'wait','waits','send','sends','sent','watch','learn','change','follow','meet','pay','open','close','start','stop','help',
  'refer','refers','refers','express','expresses','indicate','indicates','describe','describes','show','shows','compare',
  'note','check','right','wrong','type','continue','target','answer','hint','tip','example','examples','context','sense',
  'false','friend','friends','cognate','trap','warning','careful','avoid','confuse','confused','confusion','difference',
  'different','same','other','another','such','own','new','old','good','bad','big','small','long','short','high','low',
  'full','empty','true','real','possible','common','rare','regular','irregular','direct','indirect','definite','indefinite',
  'article','articles','contraction','contractions','verb','verbs','noun','nouns','adjective','adjectives',
  'adverb','adverbs','pronoun','pronouns','preposition','prepositions','determiner','determiners','conjunction','conjunctions',
  'phrase','phrases','clause','clauses','sentence','sentences','expression','expressions','idiom','idioms','slang',
  'time','day','days','year','years','way','thing','things','people','place','places','state','states','action','actions',
  'event','events','habit','habits','fact','facts','idea','ideas','feeling','feelings','opinion','opinions','reason',
  'end','ending','endings','stem','root','prefix','suffix','accent','accents','stress','stressed','sound','sounds','letter',
  'vs','etc','eg','ie','ex','ref','pl','sg','masc','fem','pt','br','en','ok','okay','yes','hey','oh','ah','well','now',
  'back','away','again','together','alone','almost','enough','quite','pretty','too','per','via','plus','minus','pair','pairs',
  'drop','drops','dropped','add','adds','added','replace','replaces','keep','keeps','change','changes','becomes','turns',
  'takes','requires','followed','preceded','paired','combined','combines','shortened','reduced','reduction','contracted',
  'before','after','front','side','part','parts','kind','sort','case','cases','point','line','hand','hands','head','home',
  'house','room','door','car','food','water','money','life','world','man','woman','child','friend','family','name','book',
  'school','city','country','night','morning','week','month','hour','minute','moment','today','tomorrow','yesterday',
  'something','someone','somebody','anything','anyone','anybody','nothing','nobody','everything','everyone','everybody',
  'plan','plans','plans','general','specific','abstract','concrete','physical','mental','emotional','temporary','permanent',
  'location','locations','position','direction','movement','destination','origin','cause','purpose','manner','degree',
  'possession','belonging','material','price','cost','age','weather','date','clock','telling','talking','speaking','saying',
  'asking','giving','taking','making','doing','going','coming','getting','having','being','putting','keeping','leaving',
  'finding','thinking','knowing','wanting','needing','feeling','looking','seeing','hearing','eating','drinking','buying',
  'paying','living','working','playing','waiting','calling','trying','using','helping','showing','telling','turning',
  'extra','final','initial','single','double','strong','weak','soft','hard','open','closed','nasal','oral','silent','mute',
  'male','female','both','mixed','group','groups','item','items','list','table','chart','rule','rules','pattern','patterns',
  'minor','major','typo','typos','error','errors','mistake','mistakes','match','matches','variant','variants','version',
  'queue','queued','round','lock','overridden','override','tricky','clean','easy','review','study','practice','drill',
  'casual','natural','post','opine','spelling','speech','softener','tag','question','invariant','circumflex',
  'identity','destination','recipient','route','transport','everyday','message','speaking','contrast',
  'repeat','repeating','confirm','aware','heard','afraid','teach','class','worth','welcome','badly','reduces',
  'focuses','distinguish','brazilians'
]);

export const POS_NOTE_MAP = {
  verb: 'VERB', verbs: 'VERB',
  noun: 'NOUN', nouns: 'NOUN',
  adjective: 'ADJ', adjectives: 'ADJ',
  adverb: 'ADV', adverbs: 'ADV',
  contraction: 'CONTR', contractions: 'CONTR',
  pronoun: 'PRON', pronouns: 'PRON',
  preposition: 'ADP', prepositions: 'ADP',
  determiner: 'DET', determiners: 'DET',
  conjunction: 'CONJ', conjunctions: 'CONJ'
};

export const EN_ONLY_IN_QUOTES = new Set([
  'to','the','and','of','for','with','from','in','on','at','by','is','are','was','were','be','been',
  'not','no','or','but','if','it','he','she','we','you','they','my','your','his','her','our','their',
  'find','have','make','take','give','go','get','say','think','know','want','need','feel','stay','keep',
  'put','come','leave','work','play','live','call','try','ask','tell','show','hear','run','walk','eat',
  'drink','buy','pay','open','close','start','stop','help','wait','send','watch','learn','change','meet',
  'use','look','see','like','love','hate','this','that','something','someone','anything','nothing',
  'very','much','many','some','any','all','more','most','good','bad','new','old','big','small','right','wrong'
]);

export function resolveLexiconLemmaIdForToken(rawToken, forcePtContext = false) {
  const norm = normNFC(rawToken);
  if (!norm) return null;
  if (!forcePtContext && EN_PROSE_STOPLIST.has(norm)) return null;
  // Exact lowercase NFC diacritic match ONLY (never foldMarks - prevents 'to'->'tô', 'e'->'é', 'so'->'só')
  for (const e of contentStore.orderedEntries) {
    if (normNFC(e.lemma) === norm) return e.id;
  }
  const hits = contentStore.exactSurfaceIndex.get(norm);
  if (hits && hits.size > 0) {
    let best = null, bestIdx = Infinity;
    hits.forEach(id => {
      const e = contentStore.entriesById.get(id);
      if (e && e.curriculumIndex < bestIdx) { bestIdx = e.curriculumIndex; best = e.id; }
    });
    return best;
  }
  return null;
}

export function renderRichGrammarNote(container, rawText, currentLemmaId = null) {
  const text = String(rawText || '');
  if (!text) return container;

  // 1. Protect English translation/gloss quotes (e.g. "means 'to find'", "lit. 'to be'", "= 'a lot'") as plain text
  const enQuoteRanges = [];
  const enQuoteRe = /(?:\b(?:means|meaning|mean|literally|lit\.?|translated\s+as|translates\s+to|i\.e\.?|e\.g\.?|not)\b|=|≠)\s*['"«]([^'"»]{1,48})['"»]/giu;
  let qm;
  while ((qm = enQuoteRe.exec(text)) !== null) {
    const qStart = qm.index + qm[0].length - qm[1].length - 2;
    enQuoteRanges.push([qStart, qm.index + qm[0].length]);
  }
  const inEnQuote = pos => enQuoteRanges.some(([a, b]) => pos >= a && pos < b);

  // 2. Identify explicit PT-context token indices (contraction formulas X + Y, contrast pairs X vs Y, non-EN quoted PT terms)
  const ptContextRanges = [];
  const formulaRe = /([\p{L}\p{M}]+)\s*\+\s*([\p{L}\p{M}]+)/gu;
  while ((qm = formulaRe.exec(text)) !== null) {
    ptContextRanges.push([qm.index, qm.index + qm[0].length]);
  }
  const contrastRe = /([\p{L}\p{M}]+)\s+(?:vs\.?|\/)\s+([\p{L}\p{M}]+)/giu;
  while ((qm = contrastRe.exec(text)) !== null) {
    const leftLow = normNFC(qm[1]);
    const rightLow = normNFC(qm[2]);
    if (!EN_PROSE_STOPLIST.has(leftLow) || !EN_PROSE_STOPLIST.has(rightLow)) {
      ptContextRanges.push([qm.index, qm.index + qm[0].length]);
    }
  }
  const genericQuoteRe = /['"«]([^'"»]{1,32})['"»]/gu;
  while ((qm = genericQuoteRe.exec(text)) !== null) {
    if (inEnQuote(qm.index)) continue;
    const innerWords = qm[1].toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
    if (innerWords.length > 0 && innerWords.some(w => EN_ONLY_IN_QUOTES.has(w))) {
      enQuoteRanges.push([qm.index, qm.index + qm[0].length]);
      continue;
    }
    ptContextRanges.push([qm.index, qm.index + qm[0].length]);
  }
  const inPtRange = pos => ptContextRanges.some(([a, b]) => pos >= a && pos < b);

  const tokenRe = /([\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*)|([^\p{L}\p{M}]+)/gu;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[1];
    if (!tok) {
      container.appendChild(document.createTextNode(m[2]));
      continue;
    }
    if (inEnQuote(m.index)) {
      container.appendChild(document.createTextNode(tok));
      continue;
    }
    const low = tok.toLowerCase();
    if (POS_NOTE_MAP[low]) {
      const pill = document.createElement('span');
      pill.className = `badge ${getPosPillClass(POS_NOTE_MAP[low])} note-pos-pill`;
      pill.textContent = tok;
      container.appendChild(pill);
      continue;
    }
    const forcePt = inPtRange(m.index) && low !== 'vs';
    const lemmaId = resolveLexiconLemmaIdForToken(tok, forcePt);
    if (lemmaId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'note-word-link';
      btn.setAttribute('data-open-word-detail', lemmaId);
      btn.textContent = tok;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        appActions.openWordDetail(lemmaId);
      });
      container.appendChild(btn);
      continue;
    }
    container.appendChild(document.createTextNode(tok));
  }
  return container;
}

export function buildUnifiedPostAnswerSub(entry, ex, { diffFrag = null, diffLabel = '', targetVariantNote = null } = {}) {
  const notes = [];
  const seen = new Set();
  const pushUnique = txt => {
    const clean = String(txt || '').trim();
    if (!clean) return;
    const key = normNFC(clean);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push(clean);
  };
  if (targetVariantNote) pushUnique(targetVariantNote);
  if ((entry && entry.false_friend) || (ex && ex.false_friend_note)) {
    const ff = (ex && ex.false_friend_note)
      ? `False friend: ${ex.false_friend_note}`
      : `False friend: "${entry.lemma}" = ${entry.en_gloss}`;
    pushUnique(ff);
  }
  const gNote = (ex && ex.grammar_note_en) || (entry && entry.grammar_note_en);
  if (gNote) pushUnique(gNote);

  if (!diffFrag && notes.length === 0) return null;
  const frag = document.createDocumentFragment();
  if (diffFrag) {
    if (diffLabel) frag.appendChild(document.createTextNode(diffLabel));
    frag.appendChild(diffFrag);
    if (notes.length > 0) {
      frag.appendChild(document.createTextNode(' · '));
      renderRichGrammarNote(frag, notes.join(' · '), entry && entry.id);
    }
    return frag;
  }
  renderRichGrammarNote(frag, notes.join(' · '), entry && entry.id);
  return frag;
}


export function isBlindAudioConflict(a, b) {
  const na = normNFC(a), nb = normNFC(b);
  if (na === nb) return true;
  const fa = foldMarks(na), fb = foldMarks(nb);
  if (fa === fb) return true;
  if (HOMOPHONE_GROUPS.some(g => g.includes(na) && g.includes(nb))) return true;
  const pg = contentStore.phoneticGroupByFolded.get(fa);
  if (pg && pg.has(fb)) return true;
  const dc = contentStore.foldedCollisionMap.get(fa);
  if (dc && dc.has(nb)) return true;
  return false;
}

export function isBlindAudioEligible(entry, ex) {
  if (!entry || !ex) return false;
  if (entry.excludeBlindAudio || ex.excludeBlindAudio || ex.needs_distractors) return false;
  const d = Array.isArray(ex.distractors) ? ex.distractors : [];
  if (d.length < 2) return false;
  const valid = [];
  for (const cand of d) {
    if (isBlindAudioConflict(cand, ex.answer)) continue;
    if (valid.some(v => isBlindAudioConflict(v, cand))) continue;
    valid.push(cand);
    if (valid.length === 2) break;
  }
  return valid.length === 2 ? valid : false;
}
