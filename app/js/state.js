export const COURSE_CONFIG = {
  'en->pt-BR': {
    id: 'en->pt-BR',
    sourceLang: 'en',
    targetLang: 'pt-BR',
    targetCorpus: 'pt-BR',
    label: 'Spoken PT-BR (from English)',
    ttsLangPrefixes: ['pt-br', 'pt'],
    diacritics: ['á', 'à', 'â', 'ã', 'é', 'ê', 'í', 'ó', 'ô', 'õ', 'ú', 'ç']
  },
  'ru->pt-BR': {
    id: 'ru->pt-BR',
    sourceLang: 'ru',
    targetLang: 'pt-BR',
    targetCorpus: 'pt-BR',
    label: 'Spoken PT-BR (from Russian)',
    ttsLangPrefixes: ['pt-br', 'pt'],
    diacritics: ['á', 'à', 'â', 'ã', 'é', 'ê', 'í', 'ó', 'ô', 'õ', 'ú', 'ç']
  },
  'pt-BR->en': {
    id: 'pt-BR->en',
    sourceLang: 'pt-BR',
    targetLang: 'en-US',
    targetCorpus: 'en-US',
    label: 'Spoken EN-US (from Portuguese)',
    ttsLangPrefixes: ['en-us', 'en'],
    diacritics: []
  },
  'ru->en': {
    id: 'ru->en',
    sourceLang: 'ru',
    targetLang: 'en-US',
    targetCorpus: 'en-US',
    label: 'Spoken EN-US (from Russian)',
    ttsLangPrefixes: ['en-us', 'en'],
    diacritics: []
  }
};
export const DEFAULT_COURSE_ID = 'en->pt-BR';
export function getCourseConfig(courseId = DEFAULT_COURSE_ID) {
  return COURSE_CONFIG[courseId] || COURSE_CONFIG[DEFAULT_COURSE_ID];
}

/* ==========================================================================
   1. UTILITIES, UUID, TOAST & SAFE NORMALIZATION
   ========================================================================== */
export const el = id => document.getElementById(id);
export const SVG_NS = 'http://www.w3.org/2000/svg';
export function makeSpeakerIcon(size = 15) {
  const svg = document.createElementNS ? document.createElementNS(SVG_NS, 'svg') : document.createElement('svg');
  svg.setAttribute('class', 'icon-svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS ? document.createElementNS(SVG_NS, 'polygon') : document.createElement('polygon');
  poly.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
  const p1 = document.createElementNS ? document.createElementNS(SVG_NS, 'path') : document.createElement('path');
  p1.setAttribute('d', 'M15.54 8.46a5 5 0 0 1 0 7.07');
  const p2 = document.createElementNS ? document.createElementNS(SVG_NS, 'path') : document.createElement('path');
  p2.setAttribute('d', 'M19.07 4.93a10 10 0 0 1 0 14.14');
  svg.append(poly, p1, p2);
  return svg;
}
export const ICON_SINGULAR_SVG = '<svg class="icon-svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.78; flex-shrink:0;" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>';
export const ICON_PLURAL_SVG = '<svg class="icon-svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.78; flex-shrink:0;" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5"/><circle cx="16.5" cy="9" r="2.5"/><path d="M16.5 14.5c2.5 0 4.5 2 4.5 4.5"/></svg>';
export const ICON_MASC_SVG = '<svg class="icon-svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.78; flex-shrink:0;" aria-hidden="true"><circle cx="10" cy="14" r="5"/><path d="M13.6 10.4L20 4"/><path d="M15 4h5v5"/></svg>';
export const ICON_FEM_SVG = '<svg class="icon-svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.78; flex-shrink:0;" aria-hidden="true"><circle cx="12" cy="9" r="5"/><path d="M12 14v7"/><path d="M9 18h6"/></svg>';

export function makeMiniIcon(kind) {
  const svg = document.createElementNS ? document.createElementNS(SVG_NS, 'svg') : document.createElement('svg');
  svg.setAttribute('class', 'icon-svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('style', 'opacity:0.78; flex-shrink:0;');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => {
    const n = document.createElementNS ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    return n;
  };
  if (kind === 'sg') {
    svg.append(mk('circle', { cx: 12, cy: 8, r: 3.5 }), mk('path', { d: 'M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6' }));
  } else if (kind === 'pl') {
    svg.append(mk('circle', { cx: 9, cy: 8, r: 3 }), mk('path', { d: 'M3 20c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5' }), mk('circle', { cx: 16.5, cy: 9, r: 2.5 }), mk('path', { d: 'M16.5 14.5c2.5 0 4.5 2 4.5 4.5' }));
  } else if (kind === 'm') {
    svg.append(mk('circle', { cx: 10, cy: 14, r: 5 }), mk('path', { d: 'M13.6 10.4L20 4' }), mk('path', { d: 'M15 4h5v5' }));
  } else if (kind === 'f') {
    svg.append(mk('circle', { cx: 12, cy: 9, r: 5 }), mk('path', { d: 'M12 14v7' }), mk('path', { d: 'M9 18h6' }));
  }
  return svg;
}

export function setPillWithIcon(elNode, iconKind, label) {
  elNode.textContent = '';
  if (iconKind) elNode.appendChild(makeMiniIcon(iconKind));
  const sp = document.createElement('span');
  sp.textContent = label;
  elNode.appendChild(sp);
}

export const TURTLE_SVG = '<svg class="icon-svg icon-turtle" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 14a7 7 0 0 1 14 0H5z"/><path d="M19 13h2.5a1.5 1.5 0 0 1 0 3H19"/><path d="M5 15l-2 1"/><path d="M8 14v3"/><path d="M16 14v3"/><path d="M9 9.5l3 1.5 3-1.5"/></svg>';
export function makeTurtleIcon(size = 15) {
  const svg = document.createElementNS ? document.createElementNS(SVG_NS, 'svg') : document.createElement('svg');
  svg.setAttribute('class', 'icon-svg icon-turtle');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    'M5 14a7 7 0 0 1 14 0H5z',
    'M19 13h2.5a1.5 1.5 0 0 1 0 3H19',
    'M5 15l-2 1',
    'M8 14v3',
    'M16 14v3',
    'M9 9.5l3 1.5 3-1.5'
  ];
  paths.forEach(d => {
    const p = document.createElementNS ? document.createElementNS(SVG_NS, 'path') : document.createElement('path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  });
  return svg;
}

export const deepClone = obj => JSON.parse(JSON.stringify(obj));

export function makeUUID() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `rev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const toastState = { undoCallback: null };
export function consumeToastUndo() {
  const fn = toastState.undoCallback;
  toastState.undoCallback = null;
  return fn;
}
export function showToast(msg, onUndo = null) {
  const box = el('toast');
  const txt = el('toast-msg');
  const btn = el('toast-undo-btn');
  if (!box || !txt) return;
  txt.textContent = String(msg || '');
  toastState.undoCallback = onUndo;
  btn.classList.toggle('hidden', !onUndo);
  box.classList.add('show');
  clearTimeout(box._timer);
  box._timer = setTimeout(() => {
    box.classList.remove('show');
    toastState.undoCallback = null;
  }, onUndo ? 4200 : 2500);
}



export function isHttpOrigin() { return location.protocol === 'http:' || location.protocol === 'https:'; }

export const DAY_ROLLOVER_HOUR = 3;

export function getLogicalDay(nowMs = Date.now(), offsetDays = 0) {
  const d = new Date(nowMs - DAY_ROLLOVER_HOUR * 3600000 + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getLogicalDayStartMs(nowMs = Date.now()) {
  const shifted = new Date(nowMs - DAY_ROLLOVER_HOUR * 3600000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate(), DAY_ROLLOVER_HOUR, 0, 0, 0).getTime();
}

export function normNFC(str) {
  return String(str || '').normalize('NFC').trim().toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ');
}

export function foldMarks(str) {
  return normNFC(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function parseCardKey(cardKey) {
  const idx = cardKey.indexOf('#');
  if (idx === -1) return { lemmaId: cardKey, cellClass: null };
  return { lemmaId: cardKey.slice(0, idx), cellClass: cardKey.slice(idx + 1) };
}

/* ==========================================================================
   2. CONSTANTS, POS MAP, AUTHORITATIVE SLOT FORMATTER & TENSE UNLOCK MAP
   ========================================================================== */
export const POS_MAP = {
  VERB: 'Verb', NOUN: 'Noun', ADJ: 'Adjective', ADV: 'Adverb',
  PRON: 'Pronoun', ADP: 'Preposition', PREP: 'Preposition',
  DET: 'Determiner', CONJ: 'Conjunction', CONTR: 'Contraction',
  INTJ: 'Interjection', NUM: 'Number', CHUNK: 'Chunk'
};

export function formatPOS(raw) {
  const k = String(raw || '').toUpperCase();
  return POS_MAP[k] || (k ? k.charAt(0) + k.slice(1).toLowerCase() : 'Word');
}

export const SLOT_LABELS = {
  'base': { tenseLabel: '', personLabel: '' },
  'inf': { tenseLabel: 'Infinitive', personLabel: 'Infinitive' },
  'ger': { tenseLabel: 'Gerund', personLabel: 'Gerund' },
  'part': { tenseLabel: 'Participle', personLabel: 'Participle' },
  'pres.1sg': { tenseLabel: 'Present', personLabel: 'Eu' },
  'pres.3sg': { tenseLabel: 'Present', personLabel: 'Você / ele / ela / a gente' },
  'pres.1pl': { tenseLabel: 'Present', personLabel: 'Nós' },
  'pres.3pl': { tenseLabel: 'Present', personLabel: 'Eles / elas / vocês' },
  'perf.1sg': { tenseLabel: 'Past (Perfect)', personLabel: 'Eu' },
  'perf.3sg': { tenseLabel: 'Past (Perfect)', personLabel: 'Você / ele / ela / a gente' },
  'perf.1pl': { tenseLabel: 'Past (Perfect)', personLabel: 'Nós' },
  'perf.3pl': { tenseLabel: 'Past (Perfect)', personLabel: 'Eles / elas / vocês' },
  'impf.1sg': { tenseLabel: 'Past (Imperfect)', personLabel: 'Eu' },
  'impf.3sg': { tenseLabel: 'Past (Imperfect)', personLabel: 'Você / ele / ela / a gente' },
  'impf.1sg=3sg': { tenseLabel: 'Past (Imperfect)', personLabel: 'Eu / você / ele / ela' },
  'impf.1pl': { tenseLabel: 'Past (Imperfect)', personLabel: 'Nós' },
  'impf.3pl': { tenseLabel: 'Past (Imperfect)', personLabel: 'Eles / elas / vocês' },
  'cond.1sg': { tenseLabel: 'Conditional', personLabel: 'Eu' },
  'cond.3sg': { tenseLabel: 'Conditional', personLabel: 'Você / ele / ela / a gente' },
  'cond.1sg=3sg': { tenseLabel: 'Conditional', personLabel: 'Eu / você / ele / ela' },
  'cond.1pl': { tenseLabel: 'Conditional', personLabel: 'Nós' },
  'cond.3pl': { tenseLabel: 'Conditional', personLabel: 'Eles / elas / vocês' },
  'fut_subj.1sg': { tenseLabel: 'Future Subjunctive', personLabel: 'Eu' },
  'fut_subj.3sg': { tenseLabel: 'Future Subjunctive', personLabel: 'Você / ele / ela / a gente' },
  'fut_subj.1sg=3sg': { tenseLabel: 'Future Subjunctive', personLabel: 'Eu / você / ele / ela' },
  'fut_subj.1pl': { tenseLabel: 'Future Subjunctive', personLabel: 'Nós' },
  'fut_subj.3pl': { tenseLabel: 'Future Subjunctive', personLabel: 'Eles / elas / vocês' },
  'pres_subj.1sg': { tenseLabel: 'Present Subjunctive', personLabel: 'Eu' },
  'pres_subj.3sg': { tenseLabel: 'Present Subjunctive', personLabel: 'Você / ele / ela / a gente' },
  'pres_subj.1sg=3sg': { tenseLabel: 'Present Subjunctive', personLabel: 'Eu / você / ele / ela' },
  'pres_subj.1pl': { tenseLabel: 'Present Subjunctive', personLabel: 'Nós' },
  'pres_subj.3pl': { tenseLabel: 'Present Subjunctive', personLabel: 'Eles / elas / vocês' },
  'impf_subj.1sg': { tenseLabel: 'Imperfect Subjunctive', personLabel: 'Eu' },
  'impf_subj.3sg': { tenseLabel: 'Imperfect Subjunctive', personLabel: 'Você / ele / ela / a gente' },
  'impf_subj.1sg=3sg': { tenseLabel: 'Imperfect Subjunctive', personLabel: 'Eu / você / ele / ela' },
  'impf_subj.1pl': { tenseLabel: 'Imperfect Subjunctive', personLabel: 'Nós' },
  'impf_subj.3pl': { tenseLabel: 'Imperfect Subjunctive', personLabel: 'Eles / elas / vocês' },
  'imp.3sg': { tenseLabel: 'Imperative', personLabel: 'Você' },
  'imp.3pl': { tenseLabel: 'Imperative', personLabel: 'Vocês' },
  'm.sg': { tenseLabel: 'Form', personLabel: 'Masculine singular' },
  'f.sg': { tenseLabel: 'Form', personLabel: 'Feminine singular' },
  'm.pl': { tenseLabel: 'Form', personLabel: 'Masculine plural' },
  'f.pl': { tenseLabel: 'Form', personLabel: 'Feminine plural' },
  'present.1st_sg': { tenseLabel: 'Present', personLabel: 'Eu' },
  'present.3rd_sg': { tenseLabel: 'Present', personLabel: 'Você / ele / ela / a gente' },
  'present.1st_pl': { tenseLabel: 'Present', personLabel: 'Nós' },
  'present.3rd_pl': { tenseLabel: 'Present', personLabel: 'Eles / elas' },
  'present.inf': { tenseLabel: 'Infinitive', personLabel: 'Infinitive' },
  'present.base': { tenseLabel: 'Base', personLabel: 'Base form' }
};

export function formatSlot(slotOrTense, legacyPerson = null) {
  let key = String(slotOrTense || 'base');
  if (legacyPerson && !key.includes('.')) key = `${key}.${legacyPerson}`;
  const info = SLOT_LABELS[key] || { tenseLabel: 'Form', personLabel: key.replace(/[._]/g, ' ') };
  let display = '';
  if (key === 'base' || key === 'present.base') {
    display = '';
  } else if (key === 'inf') {
    display = 'Infinitive';
  } else if (key === 'ger') {
    display = 'Gerund';
  } else if (key === 'part') {
    display = 'Participle';
  } else {
    const t = info.tenseLabel || '';
    const p = info.personLabel || '';
    if (!t || t === 'Present' || t === 'Form' || t === 'Base' || t.toLowerCase() === p.toLowerCase()) {
      display = p;
    } else {
      const shortT = t === 'Past (Perfect)' ? 'Past' : (t === 'Past (Imperfect)' ? 'Imperfect' : t);
      display = p ? `${shortT} · ${p}` : shortT;
    }
  }
  return { tenseLabel: info.tenseLabel, personLabel: info.personLabel, display };
}

export const TENSE_GROUPS = [
  { id: 'pres_base', unit: 1, label: 'Present Core (1sg, 3sg, inf)', locked: true, extId: null, slots: ['pres.1sg', 'pres.3sg', 'inf', 'base', 'm.sg', 'f.sg', 'm.pl', 'f.pl'] },
  { id: 'pres_3pl_ger', unit: 2, label: '3rd Plural & Gerund (Unit 2)', locked: false, extId: 'ext_3pl_gerund', slots: ['pres.3pl', 'ger'] },
  { id: 'perf', unit: 3, label: 'Past Perfect & 1st Plural (Unit 3)', locked: false, extId: 'ext_past_perf', slots: ['pres.1pl', 'perf.1sg', 'perf.3sg', 'perf.1pl', 'perf.3pl'] },
  { id: 'impf', unit: 5, label: 'Past Imperfect (Unit 5)', locked: false, extId: 'ext_past_impf', slots: ['impf.1sg', 'impf.3sg', 'impf.1pl', 'impf.3pl'] },
  { id: 'cond_fut_subj', unit: 7, label: 'Conditional & Future Subjunctive (Unit 7)', locked: false, extId: 'ext_cond_fut_subj', slots: ['cond.1sg', 'cond.3sg', 'cond.1pl', 'cond.3pl', 'fut_subj.1sg', 'fut_subj.3sg', 'fut_subj.1pl', 'fut_subj.3pl'] },
  { id: 'pres_subj', unit: 10, label: 'Present Subjunctive & Imperative (Unit 10)', locked: false, extId: 'ext_pres_subj', slots: ['pres_subj.1sg', 'pres_subj.3sg', 'pres_subj.1pl', 'pres_subj.3pl', 'imp.3sg', 'imp.3pl'] },
  { id: 'impf_subj', unit: 15, label: 'Imperfect Subjunctive & Participle (Unit 15)', locked: false, extId: null, slots: ['impf_subj.1sg', 'impf_subj.3sg', 'impf_subj.1pl', 'impf_subj.3pl', 'part'] }
];

export const SLOT_TO_TENSE_GROUP = new Map();
TENSE_GROUPS.forEach(g => g.slots.forEach(s => SLOT_TO_TENSE_GROUP.set(s, g.id)));

export const COLLISION_PAIRS = [
  ['e', 'é'], ['esta', 'está'], ['da', 'dá'], ['pais', 'país'],
  ['pode', 'pôde'], ['por', 'pôr'], ['nos', 'nós'], ['a', 'à'],
  ['tem', 'têm'], ['vem', 'vêm'], ['saia', 'saía'], ['avo', 'avô', 'avó'],
  ['ta', 'tá'], ['to', 'tô']
];

export const HOMOPHONE_GROUPS = [
  ['mas', 'mais'], ['mal', 'mau'], ['porque', 'por que', 'porquê', 'por quê'],
  ['sem', 'cem'], ['a', 'há', 'à'], ['onde', 'aonde']
];


/* ==========================================================================
   5. 3-LAYER CONTENT STORE, SURFACE INDEX, LRU PACK CACHE & ADAPTERS
   ========================================================================== */
export const contentStore = {
  manifest: null, lexicon: null, curriculum: null, ambiguous: null,
  entriesById: new Map(),
  orderedEntries: [],
  surfaceIndex: new Map(), // foldedSurface -> Set<lemmaId> (for inflected Vocab search: "fazem" -> "fazer")
  exactSurfaceIndex: new Map(), // exact lowercase NFC surface -> Set<lemmaId> (for diacritic-strict note auto-linking)
  curriculumItemById: new Map(),
  unitByNum: new Map(),
  levelById: new Map(),
  cellClassMap: {},
  slotOrder: { verb: [], nominal: [] },
  knownWordSet: new Set(),
  foldedCollisionMap: new Map(),
  phoneticGroupByFolded: new Map(),
  customFiles: new Map(),
  packCache: new Map(),
  maxPackCache: 6,
  availablePackIds: new Set(),
  availableExtIds: new Set(),
  legacyMode: false
};

// Defaults: sessionSize = 20, dailyNewLimit = 10, maxAttempts = 3, hideDiacriticsBar = false, unlockedTenses = ['pres_base']
export const userStore = {
  cards: new Map(),
  cellStats: {},
  reviews: [],
  reports: [],
  typoLog: {},
  mixups: {},
  settings: {
    settingsVersion: 4,
    desiredRetention: 0.85,
    dailyNewLimit: 10,
    dailyNewFormCap: 5,
    sessionSize: 20,
    enableFixRound: true,
    soundEffects: true,
    typoTrainerMode: 'all',
    maxAttempts: 3,            // 3 | 'unlimited'
    hideDiacriticsBar: false,
    deferColloquial: true,
    walkMode: false,
    autoPlay: true,
    rotateVoices: true,
    varyPitch: true,
    pitchRange: 'subtle',      // 'subtle' (0.92-1.08) | 'wide' (0.85-1.15)
    enabledVoices: [],
    strictDiacritics: false,
    finaleModes: ['blind', 'recall'],
    unlockedTenses: ['pres_base']
  },
  today: {
    day: getLogicalDay(), newLemmas: 0, newForms: 0, bonusNew: 0, clustersToday: [], reviewedLemmasToday: [], shownSentencesToday: []
  },
  placement: null,
  activeSession: null
};

export const State = {
  vocabSelectMode: false,
  get vocabBulkMode() { return this.vocabSelectMode; },
  set vocabBulkMode(v) { this.vocabSelectMode = Boolean(v); },
  vocabSelected: new Set(),
  vocabScrollTop: 0,
  clusterDrill: null,
  pendingBulkAction: null,
  suppressNextClickUntil: 0
};


/* ==========================================================================
   10. SESSION ENGINE, MULTI-ATTEMPT HINTS, MANDATORY RE-TYPE & FULL UNDO
   ========================================================================== */
export const session = {
  mode: 'study', // 'study' | 'round1' | 'verb_drill' | 'check_known'
  targetCount: 10,
  reviewedCount: 0, cleanCount: 0, hardCount: 0, missedCount: 0,
  recentNewVerbStreak: 0,
  activeItem: null,
  revealed: false,
  needsCorrection: false,
  triggeredByDontKnow: false,
  dontKnowSkipArmed: false,
  attemptCount: 0,
  revealedPrefixLen: 0,
  hadStrictAccentRetry: false,
  hadWrongFormRetry: false,
  usedHint: false,
  isComposing: false,
  lastSubmittedVal: '',
  cardOpenedAt: 0,
  transitionLockUntil: 0,
  requeueList: [],
  requeuedFormKeys: new Set(),
  round1Queue: [],
  drillQueue: [],
  missedIds: new Set(),
  hardIds: new Set(),
  newLearnedIds: new Set(),
  sessionLog: new Map(), // lemmaId -> { exId, grade, wasNew }
  undoStack: [],
  mainHistory: [],
  seenMainExIds: new Set(),
  lemmaSenseMap: new Map(),
  lastPreSnapshot: null,
  timerStartMs: 0, timerAccumMs: 0, firstKeystrokeMs: null,
  // Progressive 2nd-tap slow mode counters
  clozeManualPlayCount: 0, lastAudioPhase: 'pre',
  blindWordPlayCount: 0, blindSentPlayCount: 0,
  // Finale
  blindQueue: [], blindIdx: 0, blindCorrect: 0, blindAnswered: false, blindChainItems: [],
  recallTiles: [], recallTimer: null, recallSweepTimer: null, recallReturnTimer: null, isStandaloneBlind: false
};


export const placementState = { items: [], knownIds: new Set() };

export const navState = { view: 'home', settingsOpen: false, vocabBucket: 'studied' };

export const dailyGoalState = { modalMode: 'limit', addDelta: 10 };

export const appActions = {};
