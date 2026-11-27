import { COLLISION_PAIRS, SLOT_LABELS, SLOT_TO_TENSE_GROUP, TENSE_GROUPS, appActions, contentStore, deepClone, el, escapeRegex, foldMarks, getLogicalDay, isHttpOrigin, makeUUID, navState, normNFC, parseCardKey, showToast, userStore } from './state.js';
import { createBlankCardRecord } from './fsrs.js';

/* ==========================================================================
   3. INDEXEDDB STORAGE (FalaClozeDB_v25) + BATCH TX + v2.4 MIGRATION
   ========================================================================== */
export const DB_NAME = 'FalaClozeDB_v25';
export const DB_VER = 2;
export const storageState = { idb: null };
export async function initStorageDB() {
  storageState.idb = await openDB();
  return storageState.idb;
}
export function getStorageDB() {
  return storageState.idb;
}
export const memIDB = { cards: new Map(), meta: new Map(), reviews: [], customFiles: new Map(), reports: [] };

export function openDB() {
  return new Promise(resolve => {
    if (!('indexedDB' in window)) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cards')) {
          const st = db.createObjectStore('cards', { keyPath: 'key' });
          st.createIndex('status', 'status', { unique: false });
          st.createIndex('due', 'due', { unique: false });
          st.createIndex('lemmaId', 'lemmaId', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('reviews')) {
          const rst = db.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
          rst.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('customFiles')) db.createObjectStore('customFiles', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('reports')) {
          const repSt = db.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
          repSt.createIndex('exId', 'exId', { unique: false });
          repSt.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

export function idbGetAll(storeName) {
  if (!storageState.idb) {
    if (storeName === 'reviews' || storeName === 'reports') return Promise.resolve([...memIDB[storeName]]);
    return Promise.resolve(Array.from(memIDB[storeName].values()));
  }
  return new Promise(resolve => {
    try {
      const tx = storageState.idb.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (_) { resolve([]); }
  });
}

export function idbPut(storeName, obj) {
  if (!storageState.idb) {
    if (storeName === 'reviews' || storeName === 'reports') {
      const nextId = memIDB[storeName].reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0) + 1;
      const rec = { ...obj, id: obj && obj.id != null ? obj.id : nextId };
      memIDB[storeName].push(rec);
      return Promise.resolve(rec.id);
    }
    const keyField = storeName === 'cards' ? 'key' : (storeName === 'meta' ? 'k' : 'path');
    memIDB[storeName].set(obj[keyField], deepClone(obj));
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    try {
      const tx = storageState.idb.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(obj);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

export function idbBatchCards(puts = [], deletes = []) {
  if (!storageState.idb) {
    puts.forEach(c => memIDB.cards.set(c.key, deepClone(c)));
    deletes.forEach(k => memIDB.cards.delete(k));
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    try {
      const tx = storageState.idb.transaction('cards', 'readwrite');
      const st = tx.objectStore('cards');
      puts.forEach(c => st.put(c));
      deletes.forEach(k => st.delete(k));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

export function idbDelete(storeName, key) {
  if (!storageState.idb) {
    if (storeName === 'reviews' || storeName === 'reports') memIDB[storeName] = memIDB[storeName].filter(r => r.id !== key);
    else memIDB[storeName].delete(key);
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    try {
      const tx = storageState.idb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

export function idbClear(storeName) {
  if (!storageState.idb) {
    if (storeName === 'reviews' || storeName === 'reports') memIDB[storeName] = [];
    else memIDB[storeName].clear();
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    try {
      const tx = storageState.idb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

export async function saveSentenceReport(report) {
  const rec = {
    exId: String(report && report.exId || ''),
    lemmaId: String(report && report.lemmaId || ''),
    cardKey: String(report && report.cardKey || ''),
    pt: String(report && report.pt || ''),
    en: String(report && report.en || ''),
    answer: String(report && report.answer || ''),
    userInput: String(report && report.userInput || ''),
    reason: String(report && report.reason || 'Other'),
    note: String(report && report.note || '').trim(),
    ts: Number(report && report.ts) || Date.now()
  };
  const id = await idbPut('reports', rec);
  if (id != null) rec.id = id;
  if (!Array.isArray(userStore.reports)) userStore.reports = [];
  userStore.reports.push(rec);
  return rec;
}

export function isSentenceReported(exId) {
  if (!exId || !Array.isArray(userStore.reports)) return false;
  return userStore.reports.some(r => r && r.exId === exId);
}

export function buildReportsExportJson() {
  const reports = Array.isArray(userStore.reports) ? userStore.reports : [];
  return JSON.stringify({
    app: 'FalaCloze',
    type: 'sentence_reports',
    exportedAt: Date.now(),
    count: reports.length,
    reports
  }, null, 2);
}

export async function clearSentenceReports() {
  userStore.reports = [];
  await idbClear('reports');
}


export function cleanFilename(rawName) {
  return String(rawName || '').split('/').pop().replace(/\s*\(\d+\)(?=\.json$)/i, '').trim();
}

export function identifyUploadedJson(parsed, rawFilename = '') {
  const fname = cleanFilename(rawFilename).toLowerCase();
  if (!parsed || typeof parsed !== 'object') return { type: 'unknown' };
  if ((parsed.app === 'FalaCloze' && Array.isArray(parsed.cards)) ||
      (parsed.schemaVersion && parsed.cards && !Array.isArray(parsed.cards) && Array.isArray(parsed.reviewLog))) {
    return { type: 'backup', path: fname };
  }
  if (Array.isArray(parsed.packs) && parsed.lexicon && parsed.slotOrder) return { type: 'manifest', path: 'manifest.json' };
  if (parsed.packId && Array.isArray(parsed.examples)) return { type: 'pack', id: parsed.packId, path: `packs/${parsed.packId}.json` };
  if (parsed.extensionId && Array.isArray(parsed.examples)) return { type: 'extension', id: parsed.extensionId, path: `extensions/${parsed.extensionId}.json` };
  if (parsed.exactCollisions || parsed.diacriticCollisions || parsed.phoneticCollisions) return { type: 'ambiguous', path: 'ambiguous.json' };
  const lexArr = Array.isArray(parsed.entries) ? parsed.entries : (Array.isArray(parsed) ? parsed : null);
  if (lexArr && lexArr.length > 0 && lexArr[0] && lexArr[0].lemma && lexArr[0].pos && !Array.isArray(lexArr[0].examples)) {
    return { type: 'lexicon', path: 'lexicon.json' };
  }
  if (Array.isArray(parsed.units) || Array.isArray(parsed.levels) || parsed.lengthBands || parsed.styleGuide ||
      fname === 'curriculum.json' ||
      (Array.isArray(parsed.items) && parsed.items.length > 0 && parsed.items[0].lemmaId && !Array.isArray(parsed.items[0].examples))) {
    return { type: 'curriculum', path: 'curriculum.json' };
  }
  const legArr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cards) ? parsed.cards : (Array.isArray(parsed.items) ? parsed.items : null));
  if (legArr && legArr.length > 0 && legArr.some(it => it && Array.isArray(it.examples) && it.examples.length > 0)) {
    return { type: 'legacy_deck', path: 'legacy_deck.json' };
  }
  return { type: 'unknown' };
}

export function buildClozeSplit(ex) {
  if (ex.pt_cloze && ex.pt_cloze.includes('___')) {
    const parts = String(ex.pt_cloze).normalize('NFC').split('___');
    return { before: parts[0], answer: String(ex.answer || '').normalize('NFC'), after: parts.slice(1).join('___') };
  }
  const pt = String(ex.pt || '').normalize('NFC');
  const ans = String(ex.answer || '').normalize('NFC');
  if (!pt || !ans) return { before: pt, answer: ans, after: '' };
  try {
    const re = new RegExp(`(?<![\\p{L}\\p{M}])(${escapeRegex(ans)})(?![\\p{L}\\p{M}])`, 'iu');
    const m = re.exec(pt);
    if (m) return { before: pt.slice(0, m.index), answer: m[1], after: pt.slice(m.index + m[1].length) };
  } catch (_) {}
  const idx = pt.toLowerCase().indexOf(ans.toLowerCase());
  if (idx !== -1) return { before: pt.slice(0, idx), answer: pt.slice(idx, idx + ans.length), after: pt.slice(idx + ans.length) };
  return { before: pt + ' ', answer: ans, after: '' };
}

export function getCellClass(slot) { return contentStore.cellClassMap[slot] || slot || 'base'; }

export function normalizeExample(raw, lemmaId) {
  const exId = String(raw.exId || raw.id || `${lemmaId}.e1`);
  const slot = String(raw.slot || (raw.tense && raw.person ? `${raw.tense}.${raw.person}` : 'base'));
  const cellClass = String(raw.cellClass || getCellClass(slot));
  const answer = String(raw.answer || '').normalize('NFC').trim();
  const accept = Array.isArray(raw.accept) ? raw.accept : (Array.isArray(raw.accepted) ? raw.accepted : [answer]);
  const pt = raw.pt ? String(raw.pt).normalize('NFC') : String(raw.pt_cloze || '').normalize('NFC').replace('___', answer);
  const en = String(raw.en || raw.en_sentence || '');

  const rawHint = String(raw.hint_en || '');
  let ffNote = raw.false_friend_note ? String(raw.false_friend_note) : null;
  let cleanHint = rawHint;
  const m = rawHint.match(/\s*\((NOT\s+[^)]+)\)/i);
  if (m) { if (!ffNote) ffNote = m[1].trim(); cleanHint = rawHint.replace(m[0], '').trim(); }

  return {
    exId, lemmaId, pt, pt_cloze: raw.pt_cloze || null, en, answer,
    subject: raw.subject || null, slot, cellClass,
    tense: raw.tense || (slot.includes('.') ? slot.split('.')[0] : slot),
    person: raw.person || (slot.includes('.') ? slot.split('.')[1] : null),
    accept: accept.map(a => String(a).normalize('NFC').trim()).filter(Boolean),
    alt_valid: Array.isArray(raw.alt_valid) ? raw.alt_valid.map(a => String(a).normalize('NFC').trim()).filter(Boolean) : [],
    plausible_wrong: Array.isArray(raw.plausible_wrong) ? raw.plausible_wrong.map(String) : [],
    distractors: Array.isArray(raw.distractors) ? raw.distractors.map(String) : [],
    excludeBlindAudio: Boolean(raw.excludeBlindAudio),
    needs_distractors: Boolean(raw.needs_distractors),
    hint_en: rawHint, clean_hint_en: cleanHint,
    false_friend_note: ffNote,
    grammar_note_en: raw.grammar_note_en ? String(raw.grammar_note_en) : null,
    requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
    register_tier: raw.register_tier ? String(raw.register_tier) : 'spoken',
    rev: Number(raw.rev || 1),
    contentHash: raw.contentHash ? String(raw.contentHash) : null,
    retired: Boolean(raw.retired)
  };
}

export function unpackEntryForms(entry) {
  const raw = entry.forms;
  const formsBySlot = {};
  const formsList = new Set([normNFC(entry.lemma)]);
  if (typeof raw === 'string' && raw.length > 0) {
    const parts = raw.split('|');
    const order = entry.pos === 'VERB' ? contentStore.slotOrder.verb : contentStore.slotOrder.nominal;
    parts.forEach((f, i) => {
      const clean = String(f || '').normalize('NFC').trim();
      if (clean) {
        formsList.add(normNFC(clean));
        if (order[i]) formsBySlot[order[i]] = clean;
      }
    });
  } else if (Array.isArray(raw)) {
    raw.forEach(f => { const c = normNFC(f); if (c) formsList.add(c); });
  }
  return { formsList: Array.from(formsList), formsBySlot };
}

export function rebuildContentIndexes() {
  contentStore.entriesById.clear();
  contentStore.orderedEntries = [];
  contentStore.surfaceIndex.clear();
  contentStore.exactSurfaceIndex.clear();
  contentStore.curriculumItemById.clear();
  contentStore.unitByNum.clear();
  contentStore.levelById.clear();
  contentStore.knownWordSet.clear();
  contentStore.foldedCollisionMap.clear();
  contentStore.phoneticGroupByFolded.clear();

  if (contentStore.manifest) {
    contentStore.cellClassMap = contentStore.manifest.cellClassMap || {};
    contentStore.slotOrder = contentStore.manifest.slotOrder || { verb: [], nominal: [] };
  }
  if (contentStore.curriculum) {
    (contentStore.curriculum.levels || []).forEach(lv => contentStore.levelById.set(lv.id, lv));
    (contentStore.curriculum.units || []).forEach(u => contentStore.unitByNum.set(u.unit, u));
    (contentStore.curriculum.items || []).forEach(it => contentStore.curriculumItemById.set(it.lemmaId, it));
  }

  const addSurface = (w, lemmaId = null) => {
    const n = normNFC(w);
    if (!n) return;
    contentStore.knownWordSet.add(n);
    const f = foldMarks(n);
    if (!contentStore.foldedCollisionMap.has(f)) contentStore.foldedCollisionMap.set(f, new Set());
    contentStore.foldedCollisionMap.get(f).add(n);
    if (lemmaId) {
      if (!contentStore.surfaceIndex.has(f)) contentStore.surfaceIndex.set(f, new Set());
      contentStore.surfaceIndex.get(f).add(lemmaId);
      if (!contentStore.exactSurfaceIndex.has(n)) contentStore.exactSurfaceIndex.set(n, new Set());
      contentStore.exactSurfaceIndex.get(n).add(lemmaId);
    }
  };

  COLLISION_PAIRS.forEach(pair => pair.forEach(w => addSurface(w)));

  if (contentStore.ambiguous) {
    for (const [folded, forms] of Object.entries(contentStore.ambiguous.diacriticCollisions || {})) {
      if (!contentStore.foldedCollisionMap.has(folded)) contentStore.foldedCollisionMap.set(folded, new Set());
      (forms || []).forEach(f => {
        contentStore.foldedCollisionMap.get(folded).add(normNFC(f));
        addSurface(f);
      });
    }
    for (const [, group] of Object.entries(contentStore.ambiguous.phoneticCollisions || {})) {
      const foldedArr = (group || []).map(foldMarks);
      foldedArr.forEach(fg => {
        if (!contentStore.phoneticGroupByFolded.has(fg)) contentStore.phoneticGroupByFolded.set(fg, new Set());
        foldedArr.forEach(other => contentStore.phoneticGroupByFolded.get(fg).add(other));
      });
    }
  }

  const rawEntries = contentStore.lexicon ? (contentStore.lexicon.entries || []) : [];
  for (const raw of rawEntries) {
    const cur = contentStore.curriculumItemById.get(raw.id);
    const trapTags = Array.isArray(raw.trapTags) ? raw.trapTags : [];
    const clusterTag = trapTags.find(t => String(t).startsWith('cluster:'));
    const { formsList, formsBySlot } = unpackEntryForms(raw);

    const entry = {
      id: raw.id,
      idx: raw.idx != null ? raw.idx : 9999,
      curriculumIndex: cur ? cur.curriculumIndex : (raw.curriculumIndex != null ? raw.curriculumIndex : raw.idx),
      unit: cur ? cur.unit : Math.floor((raw.curriculumIndex || 0) / 100) + 1,
      level: cur ? cur.level : 'foundations',
      lemma: String(raw.lemma || '').normalize('NFC').trim(),
      freqRank: raw.freqRank != null ? raw.freqRank : (raw.idx + 1),
      pos: String(raw.pos || 'WORD').toUpperCase(),
      en_gloss: String(raw.en_gloss || ''),
      packId: raw.packId || (cur && contentStore.unitByNum.get(cur.unit) ? contentStore.unitByNum.get(cur.unit).packId : 'pack_01'),
      gender: raw.gender || null,
      government: Array.isArray(raw.government) ? raw.government : [],
      pool: Boolean(raw.pool),
      cognate: Boolean(raw.cognate),
      heteronym: Boolean(raw.heteronym),
      excludeBlindAudio: Boolean(raw.excludeBlindAudio),
      false_friend: Boolean(raw.false_friend) || trapTags.includes('false_friend'),
      cluster_id: raw.cluster_id || (clusterTag ? clusterTag.slice(8) : null),
      trapTags, forms: formsList, formsBySlot,
      grammar_note_en: raw.grammar_note_en || null,
      inlineExamples: raw._inlineExamples || null
    };

    entry.forms.forEach(f => addSurface(f, entry.id));
    contentStore.entriesById.set(entry.id, entry);
    contentStore.orderedEntries.push(entry);
  }

  contentStore.orderedEntries.sort((a, b) => a.curriculumIndex - b.curriculumIndex);
  scheduleSurfaceIndexBuild();
}

export let surfaceBuildToken = 0;
export function indexEntrySurfaces(entry) {
  if (!entry) return;
  const allForms = [entry.lemma, ...(entry.forms || [])];
  for (const w of allForms) {
    const n = normNFC(w);
    if (!n) continue;
    if (!contentStore.exactSurfaceIndex.has(n)) contentStore.exactSurfaceIndex.set(n, new Set());
    contentStore.exactSurfaceIndex.get(n).add(entry.id);
    const f = foldMarks(n);
    if (!f) continue;
    if (!contentStore.surfaceIndex.has(f)) contentStore.surfaceIndex.set(f, new Set());
    contentStore.surfaceIndex.get(f).add(entry.id);
  }
}
export function scheduleSurfaceIndexBuild() {
  const token = ++surfaceBuildToken;
  const entries = contentStore.orderedEntries;
  let idx = 0;
  const step = () => {
    if (token !== surfaceBuildToken) return;
    const end = Math.min(entries.length, idx + 400);
    for (; idx < end; idx++) indexEntrySurfaces(entries[idx]);
    if (idx < entries.length) {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(step, { timeout: 120 });
      else setTimeout(step, 0);
    }
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(step, { timeout: 120 });
  else setTimeout(step, 0);
}

export function putPackInCache(path, parsed) {
  if (contentStore.packCache.has(path)) contentStore.packCache.delete(path);
  else if (contentStore.packCache.size >= contentStore.maxPackCache) {
    contentStore.packCache.delete(contentStore.packCache.keys().next().value);
  }
  const byLemma = new Map();
  for (const rawEx of (parsed.examples || [])) {
    const ex = normalizeExample(rawEx, rawEx.lemmaId);
    if (!byLemma.has(ex.lemmaId)) byLemma.set(ex.lemmaId, []);
    byLemma.get(ex.lemmaId).push(ex);
  }
  const rec = { data: parsed, examplesByLemma: byLemma };
  contentStore.packCache.set(path, rec);
  return rec;
}

export function getManifestHashForPath(path) {
  const clean = String(path || '').replace(/^\.\//, '').split('?')[0];
  const m = contentStore.manifest;
  if (!m || !clean) return null;
  if (m.lexicon && ((m.lexicon.file || 'lexicon.json') === clean)) return m.lexicon.hash || null;
  if (m.curriculum && ((m.curriculum.file || 'curriculum.json') === clean)) return m.curriculum.hash || null;
  if (m.ambiguous && ((m.ambiguous.file || 'ambiguous.json') === clean)) return m.ambiguous.hash || null;
  for (const p of (m.packs || [])) {
    if ((p.file || `packs/${p.id}.json`) === clean) return p.hash || null;
  }
  for (const ext of (m.extensions || [])) {
    if ((ext.file || `extensions/${ext.id}.json`) === clean) return ext.hash || null;
  }
  return null;
}

export let dataBasePrefix = './';
export function resolveDataUrl(relUrl) {
  const s = String(relUrl || '');
  if (dataBasePrefix !== './' && s.startsWith('./')) {
    return dataBasePrefix + s.slice(2);
  }
  return s;
}

export function buildVersionedAssetUrl(path) {
  const clean = String(path || '').replace(/^\.\//, '').split('?')[0];
  const hash = getManifestHashForPath(clean);
  return hash ? `./${clean}?v=${encodeURIComponent(hash)}` : `./${clean}`;
}

export async function loadPackOrExt(path) {
  const expectedHash = getManifestHashForPath(path);
  if (contentStore.packCache.has(path)) {
    const cached = contentStore.packCache.get(path);
    if (!expectedHash || cached._manifestHash === expectedHash) {
      contentStore.packCache.delete(path);
      contentStore.packCache.set(path, cached);
      return cached;
    }
    contentStore.packCache.delete(path);
  }
  if (contentStore.customFiles.has(path)) {
    const rec = putPackInCache(path, contentStore.customFiles.get(path));
    if (rec) rec._manifestHash = expectedHash;
    return rec;
  }
  if (isHttpOrigin()) {
    try {
      const res = await fetch(resolveDataUrl(buildVersionedAssetUrl(path)), { cache: 'no-cache' });
      if (res.ok) {
        const parsed = await res.json();
        if (parsed.packId) contentStore.availablePackIds.add(parsed.packId);
        if (parsed.extensionId) contentStore.availableExtIds.add(parsed.extensionId);
        const rec = putPackInCache(path, parsed);
        if (rec) rec._manifestHash = expectedHash;
        return rec;
      }
    } catch (_) {}
  }
  return null;
}

export async function getExamplesForEntry(entry) {
  if (!entry) return [];
  if (entry.inlineExamples) return entry.inlineExamples;
  const all = [], seen = new Set();

  const packObj = await loadPackOrExt(`packs/${entry.packId}.json`);
  if (packObj && packObj.examplesByLemma.has(entry.id)) {
    for (const ex of packObj.examplesByLemma.get(entry.id)) {
      if (!seen.has(ex.exId)) { seen.add(ex.exId); all.push(ex); }
    }
  }

  const unlocked = userStore.settings.unlockedTenses || ['pres_base'];
  const exts = (contentStore.manifest && contentStore.manifest.extensions) || [];
  for (const extDef of exts) {
    if (!unlocked.includes(extDef.tense)) continue;
    if (Array.isArray(extDef.appliesToPacks) && !extDef.appliesToPacks.includes(entry.packId)) continue;
    const extPath = extDef.file || `extensions/${extDef.id}.json`;
    if (!extDef.hash && !contentStore.customFiles.has(extPath)) continue;
    const extObj = await loadPackOrExt(extPath);
    if (extObj && extObj.examplesByLemma.has(entry.id)) {
      for (const ex of extObj.examplesByLemma.get(entry.id)) {
        if (!seen.has(ex.exId)) { seen.add(ex.exId); all.push(ex); }
      }
    }
  }
  return all;
}

export function isSlotUnlocked(slot) {
  const grp = SLOT_TO_TENSE_GROUP.get(slot);
  if (!grp) return true;
  return (userStore.settings.unlockedTenses || ['pres_base']).includes(grp);
}

export function isIntroReadyExample(entry, ex) {
  let unintroPool = 0;
  for (const reqId of (ex.requires || [])) {
    if (reqId === entry.id) continue;
    const reqEntry = contentStore.entriesById.get(reqId);
    if (!reqEntry) continue;
    if (userStore.cards.has(reqId) || reqEntry.curriculumIndex < entry.curriculumIndex) continue;
    if (reqEntry.pool) unintroPool++;
    else return false;
  }
  return unintroPool <= 1;
}

export async function getEligibleExamples(entry, cellClassFilter = null) {
  const all = await getExamplesForEntry(entry);
  return all.filter(ex => !ex.retired && isSlotUnlocked(ex.slot) && (!cellClassFilter || ex.cellClass === cellClassFilter));
}

/* ==========================================================================
   9. META PERSISTENCE, SCHEDULER & UNIT PROGRESS
   ========================================================================== */
export async function saveMeta(k, v) { await idbPut('meta', { k, v }); }
export async function saveSettings() { await saveMeta('settings', userStore.settings); }
export async function saveToday() { await saveMeta('today', userStore.today); }
export async function saveCellStats() { await saveMeta('cellStats', userStore.cellStats); }
export async function saveTypoLog() { await saveMeta('typoLog', userStore.typoLog || {}); }
export async function saveMixups() { await saveMeta('mixups', userStore.mixups || {}); }

export function makeTypoLogKey(lemmaId, target, exId = '') {
  return `${String(lemmaId || '')}::${normNFC(target)}::${String(exId || '')}`;
}

export async function recordTypoEvent({ lemmaId, target, exId, userInput, diacriticOnly }) {
  if (!lemmaId || !target) return null;
  if (!userStore.typoLog || typeof userStore.typoLog !== 'object') userStore.typoLog = {};
  const key = makeTypoLogKey(lemmaId, target, exId);
  const prev = userStore.typoLog[key];
  const now = Date.now();
  // Preserve real-typo classification once a non-diacritic mistake has occurred for this key
  const nextDiacOnly = prev && prev.diacriticOnly === false ? false : Boolean(diacriticOnly);
  const rec = {
    key,
    lemmaId: String(lemmaId),
    target: String(target),
    exId: String(exId || ''),
    lastInput: String(userInput || '').trim(),
    diacriticOnly: nextDiacOnly,
    count: (prev ? (Number(prev.count) || 0) : 0) + 1,
    cleanStreak: 0,
    graduated: false,
    updatedAt: now
  };
  userStore.typoLog[key] = rec;
  await saveTypoLog();
  return rec;
}

export function getActiveTypoEntries(mode = 'all') {
  const map = userStore.typoLog && typeof userStore.typoLog === 'object' ? userStore.typoLog : {};
  const out = [];
  for (const rec of Object.values(map)) {
    if (!rec || rec.graduated || !rec.lemmaId || !rec.target) continue;
    if (mode === 'real' && rec.diacriticOnly !== false) continue;
    out.push(rec);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export async function recordTypoDrillAttempt(key, isClean) {
  if (!key || !userStore.typoLog || !userStore.typoLog[key]) return null;
  const rec = userStore.typoLog[key];
  const now = Date.now();
  if (isClean) {
    rec.cleanStreak = (Number(rec.cleanStreak) || 0) + 1;
    if (rec.cleanStreak >= 2) rec.graduated = true;
  } else {
    rec.cleanStreak = 0;
    rec.graduated = false;
  }
  rec.updatedAt = now;
  await saveTypoLog();
  return rec;
}

export function makeMixupPairKey(lemmas) {
  return (Array.isArray(lemmas) ? lemmas : [])
    .map(w => normNFC(w))
    .filter(Boolean)
    .sort()
    .join('|');
}

export async function recordConfusableMixup(pairLemmas) {
  const key = makeMixupPairKey(pairLemmas);
  if (!key) return null;
  if (!userStore.mixups || typeof userStore.mixups !== 'object') userStore.mixups = {};
  const prev = userStore.mixups[key];
  const now = Date.now();
  const rec = {
    key,
    lemmas: Array.isArray(pairLemmas) ? pairLemmas.slice(0, 3) : [],
    count: (prev ? (Number(prev.count) || 0) : 0) + 1,
    lastTs: now,
    dismissedAt: prev && prev.dismissedAt ? prev.dismissedAt : 0,
    updatedAt: now
  };
  userStore.mixups[key] = rec;
  await saveMixups();
  return rec;
}

export async function dismissConfusableRecommendation(pairKey) {
  if (!pairKey) return;
  if (!userStore.mixups || typeof userStore.mixups !== 'object') userStore.mixups = {};
  const prev = userStore.mixups[pairKey] || { key: pairKey, lemmas: pairKey.split('|'), count: 0, lastTs: 0 };
  const now = Date.now();
  prev.dismissedAt = now;
  prev.updatedAt = now;
  userStore.mixups[pairKey] = prev;
  await saveMixups();
}

export function ensureDailyRollover(nowMs = Date.now()) {
  const today = getLogicalDay(nowMs);
  if (!userStore.today || userStore.today.day !== today) {
    userStore.today = { day: today, newLemmas: 0, newForms: 0, bonusNew: 0, clustersToday: [], reviewedLemmasToday: [], shownSentencesToday: [] };
    saveToday();
  }
}

export function getEffectiveDailyNewCap() {
  return (Number(userStore.settings.dailyNewLimit) || 10) + (Number(userStore.today.bonusNew) || 0);
}

// Single authoritative studied-base-lemma counter (NEVER counts #/:: form sub-cards, orphaned keys, to_learn, or suspended)
export function getStudiedBaseLemmaIds() {
  const out = [];
  for (const entry of contentStore.orderedEntries) {
    const rec = userStore.cards.get(entry.id);
    if (!rec || rec.suspended) continue;
    if (rec.assumed || ['learning', 'relearning', 'review', 'known', 'assumed'].includes(rec.status)) {
      out.push(entry.id);
    }
  }
  return out;
}

export function computeAvailableSessionCounts(now = Date.now()) {
  let dueCount = 0;
  for (const [k, rec] of userStore.cards.entries()) {
    if (rec.suspended || rec.assumed || rec.status === 'assumed') continue;
    const { lemmaId } = parseCardKey(k);
    const entry = contentStore.entriesById.get(lemmaId);
    if (!entry || !isPackLoadedOrAvailable(entry.packId)) continue;
    if ((rec.status === 'learning' || rec.status === 'relearning') && rec.due <= now + 15 * 60000) dueCount++;
    else if (rec.status === 'review' && rec.due <= now && !isSiblingBuried(lemmaId)) dueCount++;
  }
  let unintroducedInLoadedPacks = 0;
  for (const entry of contentStore.orderedEntries) {
    if (userStore.cards.has(entry.id)) continue;
    if (!isPackLoadedOrAvailable(entry.packId)) continue;
    if (isClusterBlocked(entry, now)) continue;
    if (isColloquialDeferred(entry)) continue;
    unintroducedInLoadedPacks++;
  }
  const remNewCap = Math.max(0, getEffectiveDailyNewCap() - (userStore.today.newLemmas || 0));
  const availNew = Math.min(remNewCap, unintroducedInLoadedPacks);
  return { dueCount, availNew, unintroducedInLoadedPacks };
}

export function isCardDueNow(card, now = Date.now()) {
  if (!card || card.suspended || card.status === 'suspended' || card.assumed || card.status === 'assumed') return false;
  return (card.status === 'learning' || card.status === 'relearning' || card.status === 'review') && (card.due || 0) <= now;
}

export function getLemmaStatusBadge(entry) {
  const rec = userStore.cards.get(entry.id);
  if (!rec || rec.status === 'new' || rec.status === 'to_learn') {
    return { bucket: 'to_learn', label: 'To Learn', cls: 'badge' };
  }
  if (rec.suspended || rec.status === 'suspended') {
    return { bucket: 'suspended', label: 'Suspended', cls: 'badge badge-slate' };
  }
  if (rec.assumed || rec.status === 'assumed') {
    return { bucket: 'assumed', label: 'Assumed', cls: 'badge badge-sky' };
  }
  if (rec.status === 'known') {
    return { bucket: 'known', label: 'Known', cls: 'badge badge-emerald' };
  }
  if (rec.status === 'review') {
    return { bucket: 'review', label: 'Review', cls: 'badge badge-primary' };
  }
  return { bucket: 'learning', label: 'Learning', cls: 'badge badge-amber' };
}

export function getLemmaBucket(entry) { return getLemmaStatusBadge(entry).bucket; }

export function getCellStat(lemmaId, cellClass) {
  const m = userStore.cellStats[lemmaId];
  return (m && m[cellClass]) ? m[cellClass] : { ok: 0, fail: 0 };
}

export function getHighestReachedUnit() {
  let maxIdx = 0;
  for (const [k, rec] of userStore.cards.entries()) {
    const { lemmaId, cellClass } = parseCardKey(k);
    if (cellClass || rec.suspended) continue;
    const e = contentStore.entriesById.get(lemmaId);
    if (e && e.curriculumIndex > maxIdx) maxIdx = e.curriculumIndex;
  }
  return Math.floor(maxIdx / 100) + 1;
}

export function autoUnlockTensesForUnit(unitNum) {
  let changed = false;
  const arr = userStore.settings.unlockedTenses;
  for (const g of TENSE_GROUPS) {
    if (unitNum >= g.unit && !arr.includes(g.id)) { arr.push(g.id); changed = true; }
  }
  if (changed) saveSettings();
}

export const COLLOQUIAL_DEFERRAL_RULES = {};
[
  [['tá', 'tô', 'tão', 'tava', 'tavam'], 100, ['estar'], 10],
  [['pra', 'pro', 'pras', 'pros'], 100, ['para'], 10],
  [['cê', 'ocê', 'cês'], 100, ['você'], 10],
  [['né'], 100, ['não', 'ser'], 10],
  [['num', 'numa', 'nuns', 'numas'], 80, ['em', 'um'], 7],
  [['dum', 'duma', 'duns', 'dumas'], 80, ['de', 'um'], 7]
].forEach(([forms, minStudied, prereqLemmas, minStab]) => {
  forms.forEach(f => { COLLOQUIAL_DEFERRAL_RULES[normNFC(f)] = { minStudied, prereqLemmas, minStab }; });
});

export function isLemmaSolid(lemmaText, minStab) {
  const target = normNFC(lemmaText);
  for (const e of contentStore.orderedEntries) {
    if (normNFC(e.lemma) !== target) continue;
    const rec = userStore.cards.get(e.id);
    if (rec && !rec.suspended && (rec.status === 'known' || (rec.stability || 0) >= minStab)) return true;
  }
  return false;
}

export function isColloquialDeferred(entry) {
  if (!entry || !userStore.settings.deferColloquial) return false;
  const lem = normNFC(entry.lemma);
  const rule = COLLOQUIAL_DEFERRAL_RULES[lem];
  const hasTag = Boolean(
    entry.colloquial ||
    entry.register === 'spoken' ||
    (Array.isArray(entry.trapTags) && entry.trapTags.some(t => /colloquial|spoken_reduction/i.test(String(t))))
  );
  if (!rule && !hasTag) return false;
  const studiedCount = getStudiedBaseLemmaIds().length;
  if (rule) {
    if (studiedCount < rule.minStudied) return true;
    for (const req of rule.prereqLemmas) {
      if (!isLemmaSolid(req, rule.minStab)) return true;
    }
    return false;
  }
  return studiedCount < 100;
}

export function getFastAnswerThresholdMs(answer, sentencePt = '') {
  const targetAnswerLength = Array.from(String(answer || '').trim()).length;
  const cleanSent = String(sentencePt || '').trim();
  const sentenceWordCount = cleanSent ? cleanSent.split(/\s+/).filter(Boolean).length : 0;
  const raw = 1500 + sentenceWordCount * 380 + targetAnswerLength * 220;
  return Math.max(2500, Math.min(8500, raw));
}

export function isClusterBlocked(entry, nowMs = Date.now()) {
  if (!entry.cluster_id) return false;
  if (userStore.today.clustersToday.includes(entry.cluster_id)) return true;
  for (const other of contentStore.orderedEntries) {
    if (other.curriculumIndex >= entry.curriculumIndex) break;
    if (other.cluster_id !== entry.cluster_id) continue;
    const rec = userStore.cards.get(other.id);
    if (!rec) return true;
    const days = rec.firstIntroducedAt ? (nowMs - rec.firstIntroducedAt) / 86400000 : 0;
    if ((rec.stability || 0) < 5 && days < 14) return true;
  }
  return false;
}

export function isSiblingBuried(lemmaId) { return userStore.today.reviewedLemmasToday.includes(lemmaId); }

export function isPackLoadedOrAvailable(packId) {
  if (contentStore.legacyMode) return true;
  if (contentStore.availablePackIds.has(packId)) return true;
  if (contentStore.customFiles.has(`packs/${packId}.json`)) return true;
  const pDef = contentStore.manifest && (contentStore.manifest.packs || []).find(p => p.id === packId);
  return Boolean(pDef && pDef.hash && isHttpOrigin());
}

export function isMultiFormEntry(entry) {
  if (!entry) return false;
  if (String(entry.pos || '').toUpperCase() === 'VERB') return true;
  const distinctForms = new Set((entry.forms || []).map(normNFC).filter(Boolean));
  if (distinctForms.size > 1) return true;
  const packObj = contentStore.packCache.get(`packs/${entry.packId}.json`);
  if (packObj && packObj.examplesByLemma.has(entry.id)) {
    const exs = packObj.examplesByLemma.get(entry.id);
    const ansSet = new Set(exs.map(e => normNFC(e.answer)).filter(Boolean));
    if (ansSet.size > 1) return true;
  }
  return false;
}

export function getExampleFormKey(entry, ex) {
  if (!entry || !ex || !isMultiFormEntry(entry)) return null;
  if (String(entry.pos || '').toUpperCase() === 'VERB') {
    return getCellClass(ex.cellClass || ex.slot || 'base');
  }
  const sl = String(ex.inflection || ex.slot || '').toLowerCase();
  if (sl && sl !== 'base') return getCellClass(sl);
  return normNFC(ex.answer);
}

export function isExampleFormKnown(rec, entry, ex) {
  if (!rec) return false;
  if (rec.status === 'known') return true;
  const fk = getExampleFormKey(entry, ex);
  if (fk && rec.knownCells && rec.knownCells[fk]) return true;
  const ans = normNFC(ex && ex.answer);
  if (ans && rec.knownAnswers && rec.knownAnswers[ans]) return true;
  return false;
}

function normalizeSenseToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^to\s+/, '')
    .replace(/[.,!?'"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getGlossSenseClusters(enGloss) {
  const seen = new Set();
  const out = [];
  for (const part of String(enGloss || '').split(/[;/]/)) {
    const clean = normalizeSenseToken(part);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function resolveExampleSenseCluster(entry, ex) {
  const clusters = getGlossSenseClusters(entry && entry.en_gloss);
  const explicit = ex && (ex.senseKey || ex.sense);
  if (explicit) {
    const normExp = normalizeSenseToken(explicit);
    const expIdx = clusters.indexOf(normExp);
    return { index: expIdx >= 0 ? expIdx : 0, key: normExp || clusters[0] || 'primary', isPrimary: expIdx <= 0 };
  }
  if (clusters.length <= 1) {
    return { index: 0, key: clusters[0] || 'primary', isPrimary: true };
  }
  const rawHint = String((ex && (ex.clean_hint_en || ex.hint_en)) || '');
  const normHint = normalizeSenseToken(rawHint);
  if (!normHint) {
    return { index: 0, key: clusters[0], isPrimary: true };
  }
  const hintParts = rawHint.split(/[;/,]/).map(normalizeSenseToken).filter(Boolean);
  for (const hp of [normHint, ...hintParts]) {
    const exactIdx = clusters.indexOf(hp);
    if (exactIdx !== -1) {
      return { index: exactIdx, key: clusters[exactIdx], isPrimary: exactIdx === 0 };
    }
  }
  let bestIdx = -1;
  let bestLen = 0;
  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    if (!cl) continue;
    const escCl = escapeRegex(cl);
    const reCl = new RegExp(`(?:^|\\s)${escCl}(?:$|\\s)`);
    const reHint = new RegExp(`(?:^|\\s)${escapeRegex(normHint)}(?:$|\\s)`);
    if (reCl.test(normHint) || reHint.test(cl)) {
      if (cl.length > bestLen) { bestLen = cl.length; bestIdx = i; }
    }
  }
  if (bestIdx !== -1) {
    return { index: bestIdx, key: clusters[bestIdx], isPrimary: bestIdx === 0 };
  }
  return { index: 0, key: clusters[0], isPrimary: true };
}

export async function pickBestExample(entry, cellClassFilter, cardKey, isNewWord = false, extraOpts = {}) {
  const rawPool = await getEligibleExamples(entry, cellClassFilter);
  if (rawPool.length === 0) return null;
  const baseRec = userStore.cards.get(entry.id);
  const subRec = cardKey !== entry.id ? userStore.cards.get(cardKey) : null;
  const pool = rawPool.filter(ex => !isExampleFormKnown(baseRec, entry, ex) && !isExampleFormKnown(subRec, entry, ex));
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const rec = subRec || baseRec;
  const lastId = (extraOpts && extraOpts.excludeExampleId) || (rec ? rec.lastExampleId : null);
  const shown = new Set(userStore.today.shownSentencesToday || []);
  let candidates = pool;
  const isEarlyLearning = !baseRec || baseRec.status === 'new' || baseRec.status === 'learning' || (baseRec.reps || 0) < 2;
  if (isEarlyLearning) {
    if (extraOpts && extraOpts.lockedSenseKey) {
      const senseLocked = candidates.filter(ex => resolveExampleSenseCluster(entry, ex).key === extraOpts.lockedSenseKey);
      if (senseLocked.length > 0) candidates = senseLocked;
    } else {
      const primaryOnly = candidates.filter(ex => resolveExampleSenseCluster(entry, ex).isPrimary);
      if (primaryOnly.length > 0) candidates = primaryOnly;
    }
  }
  if (extraOpts && extraOpts.excludeExampleId) {
    const diffCtx = candidates.filter(ex => ex.exId !== extraOpts.excludeExampleId);
    if (diffCtx.length > 0) candidates = diffCtx;
  }
  if (isNewWord) {
    const intro = candidates.filter(ex => isIntroReadyExample(entry, ex));
    if (intro.length > 0) candidates = intro;
  }
  let best = candidates[0], bestScore = -Infinity;
  for (const ex of candidates) {
    const st = getCellStat(entry.id, ex.cellClass);
    const unpracticedBonus = (st.ok === 0 && st.fail === 0) ? 1.8 : 0;
    let score = unpracticedBonus + (st.fail * 2.5 - st.ok) + Math.random() * 0.3;
    if (ex.exId === lastId) score -= 50;
    if (shown.has(normNFC(ex.pt))) score -= 25;
    if (userStore.settings.deferColloquial && getStudiedBaseLemmaIds().length < 100 && COLLOQUIAL_DEFERRAL_RULES[normNFC(ex.answer)]) score -= 15;
    if (score > bestScore) { bestScore = score; best = ex; }
  }
  return best;
}


export function preloadUpcomingPacks(entries) {
  const seen = new Set();
  for (const e of entries.slice(0, 4)) {
    if (!e || seen.has(e.packId)) continue;
    seen.add(e.packId);
    if (isPackLoadedOrAvailable(e.packId)) loadPackOrExt(`packs/${e.packId}.json`).catch(() => {});
  }
}


export async function ingestJsonFile(parsed, rawFilename) {
  const cls = identifyUploadedJson(parsed, rawFilename);
  if (cls.type === 'unknown') return { ok: false, msg: `Unrecognized JSON: ${rawFilename}` };
  if (cls.type === 'backup') {
    const summary = { imported: 0, skipped: 0, pruned: 0 };
    await mergeProgressObject(parsed, { pruneUnknown: true, summary });
    return { ok: true, type: 'backup', msg: `Imported ${summary.imported} cards (${summary.skipped} skipped).`, summary };
  }
  if (cls.type === 'manifest') { contentStore.manifest = parsed; contentStore.customFiles.set('manifest.json', parsed); await idbPut('customFiles', { path: 'manifest.json', data: parsed }); }
  else if (cls.type === 'lexicon') { contentStore.lexicon = Array.isArray(parsed) ? { version: 2, entries: parsed } : parsed; contentStore.customFiles.set('lexicon.json', contentStore.lexicon); await idbPut('customFiles', { path: 'lexicon.json', data: contentStore.lexicon }); }
  else if (cls.type === 'curriculum') { contentStore.curriculum = parsed; contentStore.customFiles.set('curriculum.json', parsed); await idbPut('customFiles', { path: 'curriculum.json', data: parsed }); }
  else if (cls.type === 'ambiguous') { contentStore.ambiguous = parsed; contentStore.customFiles.set('ambiguous.json', parsed); await idbPut('customFiles', { path: 'ambiguous.json', data: parsed }); }
  else if (cls.type === 'pack') { contentStore.availablePackIds.add(cls.id); contentStore.customFiles.set(cls.path, parsed); await idbPut('customFiles', { path: cls.path, data: parsed }); putPackInCache(cls.path, parsed); }
  else if (cls.type === 'extension') { contentStore.availableExtIds.add(cls.id); contentStore.customFiles.set(cls.path, parsed); await idbPut('customFiles', { path: cls.path, data: parsed }); putPackInCache(cls.path, parsed); }
  else if (cls.type === 'legacy_deck') {
    const arr = Array.isArray(parsed) ? parsed : (parsed.cards || parsed.items || []);
    contentStore.legacyMode = true;
    const entries = arr.map((c, idx) => ({
      id: c.id || `pt_leg_${idx}`, idx, curriculumIndex: idx, lemma: c.lemma, pos: c.pos || 'WORD',
      en_gloss: c.en_gloss || '', packId: 'legacy', forms: c.forms || [],
      cluster_id: c.cluster_id || null, false_friend: Boolean(c.false_friend), grammar_note_en: c.grammar_note_en || null,
      _inlineExamples: (c.examples || []).map(ex => normalizeExample(ex, c.id || `pt_leg_${idx}`))
    }));
    contentStore.lexicon = { version: 1, entries };
    contentStore.customFiles.set('legacy_deck.json', parsed);
    await idbPut('customFiles', { path: 'legacy_deck.json', data: parsed });
  }
  rebuildContentIndexes();
  return { ok: true, type: cls.type, path: cls.path };
}

export async function handleMultipleFileUpload(fileList) {
  if (!fileList || fileList.length === 0) return;
  let okCount = 0;
  let lastMsg = '';
  for (const file of Array.from(fileList)) {
    if (!file.name.toLowerCase().endsWith('.json')) continue;
    try {
      const res = await ingestJsonFile(JSON.parse(await file.text()), file.name);
      if (res.ok) { okCount++; lastMsg = res.msg || ''; }
    } catch (_) {}
  }
  appActions.renderHome();
  if (navState.settingsOpen) appActions.renderSettings();
  showToast(okCount === 1 && lastMsg ? lastMsg : (okCount > 0 ? `Imported ${okCount} JSON file${okCount === 1 ? '' : 's'}` : 'No valid FalaCloze JSON files found'));
}

export function buildExportPayload() {
  return {
    app: 'FalaCloze', schemaVersion: 3, exportedAt: Date.now(),
    settings: userStore.settings,
    cards: Array.from(userStore.cards.values()),
    cellStats: userStore.cellStats,
    reviews: userStore.reviews.slice(-5000),
    meta: {
      settings: userStore.settings,
      today: userStore.today,
      cellStats: userStore.cellStats,
      placement: userStore.placement || null,
      typoLog: userStore.typoLog || {},
      mixups: userStore.mixups || {}
    }
  };
}

export async function exportProgress() {
  const payload = buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `falacloze_v25_progress_${getLogicalDay()}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('Progress exported!');
}

export function isValidCardKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (contentStore.entriesById.size === 0) return true;
  const { lemmaId, cellClass } = parseCardKey(key);
  const entry = contentStore.entriesById.get(lemmaId);
  if (!entry) return false;
  if (!cellClass || cellClass === 'base') return true;
  if (entry.formsBySlot && Object.prototype.hasOwnProperty.call(entry.formsBySlot, cellClass)) return true;
  const isVerb = entry.pos === 'VERB';
  const orderList = isVerb ? (contentStore.slotOrder.verb || []) : (contentStore.slotOrder.nominal || []);
  for (const s of orderList) {
    if (s === cellClass || getCellClass(s) === cellClass) return true;
  }
  if (isVerb) {
    for (const [raw, mapped] of Object.entries(contentStore.cellClassMap || {})) {
      if (raw === cellClass || mapped === cellClass) return true;
    }
  }
  if ((contentStore.slotOrder.verb || []).length === 0 &&
      (contentStore.slotOrder.nominal || []).length === 0 &&
      Object.keys(contentStore.cellClassMap || {}).length === 0 &&
      Object.prototype.hasOwnProperty.call(SLOT_LABELS, cellClass)) {
    return true;
  }
  return false;
}

export async function mergeProgressObject(inc, opts = {}) {
  const data = inc && typeof inc === 'object' ? inc : {};
  const pruneUnknown = Boolean(opts && opts.pruneUnknown) && contentStore.entriesById.size > 0;
  const incCards = Array.isArray(data.cards)
    ? data.cards
    : Object.entries(data.cards || {}).map(([key, rec]) => ({ key, ...rec, status: rec.status || rec.state || 'new' }));
  const recStamp = r => Math.max(r.stateUpdatedAt || 0, r.updatedAt || 0, r.last_review || r.lastReview || 0);
  const puts = [];
  const deletes = [];
  let skipped = 0;

  if (pruneUnknown) {
    for (const existingKey of Array.from(userStore.cards.keys())) {
      if (!isValidCardKey(existingKey)) {
        userStore.cards.delete(existingKey);
        deletes.push(existingKey);
      }
    }
  }

  for (const incRec of incCards) {
    if (!incRec || !incRec.key) { skipped++; continue; }
    if (pruneUnknown && !isValidCardKey(incRec.key)) { skipped++; continue; }
    const local = userStore.cards.get(incRec.key);
    const mergedCells = { ...(local && local.knownCells || {}) };
    for (const [ck, ts] of Object.entries((incRec && incRec.knownCells) || {})) {
      mergedCells[ck] = Math.max(Number(mergedCells[ck]) || 0, Number(ts) || 1);
    }
    const mergedAnswers = { ...(local && local.knownAnswers || {}) };
    for (const [ak, ts] of Object.entries((incRec && incRec.knownAnswers) || {})) {
      mergedAnswers[ak] = Math.max(Number(mergedAnswers[ak]) || 0, Number(ts) || 1);
    }
    const hasMergedFormMeta = Object.keys(mergedCells).length > 0 || Object.keys(mergedAnswers).length > 0;
    if (!local || recStamp(incRec) > recStamp(local)) {
      const norm = { ...createBlankCardRecord(incRec.key), ...incRec, status: incRec.status || incRec.state || 'new' };
      if (hasMergedFormMeta) { norm.knownCells = mergedCells; norm.knownAnswers = mergedAnswers; }
      userStore.cards.set(norm.key, norm); puts.push(norm);
    } else if (hasMergedFormMeta) {
      const upd = deepClone(local);
      upd.knownCells = mergedCells;
      upd.knownAnswers = mergedAnswers;
      userStore.cards.set(upd.key, upd); puts.push(upd);
    }
  }
  if (puts.length > 0 || deletes.length > 0) await idbBatchCards(puts, deletes);

  const existingUuids = new Set(userStore.reviews.map(r => r && r.uuid).filter(Boolean));
  const incReviews = Array.isArray(data.reviews) ? data.reviews : (Array.isArray(data.reviewLog) ? data.reviewLog : []);
  for (const r of incReviews) {
    if (!r) continue;
    if (pruneUnknown) {
      if (r.cardKey && !isValidCardKey(r.cardKey)) continue;
      if (r.lemmaId && !contentStore.entriesById.has(r.lemmaId)) continue;
    }
    const u = r.uuid || makeUUID();
    if (existingUuids.has(u)) continue;
    existingUuids.add(u);
    const clean = { ...r, uuid: u };
    delete clean.id;
    const revId = await idbPut('reviews', clean);
    clean.id = revId;
    userStore.reviews.push(clean);
  }

  if (pruneUnknown) {
    for (const existingLid of Object.keys(userStore.cellStats || {})) {
      if (!contentStore.entriesById.has(existingLid)) {
        delete userStore.cellStats[existingLid];
        continue;
      }
      const slotMap = userStore.cellStats[existingLid] || {};
      for (const existingCc of Object.keys(slotMap)) {
        if (!isValidCardKey(`${existingLid}#${existingCc}`)) delete slotMap[existingCc];
      }
    }
  }

  const statsSrc = (data.meta && data.meta.cellStats) || data.cellStats || data.formStats || {};
  for (const [lid, slots] of Object.entries(statsSrc)) {
    if (pruneUnknown && !contentStore.entriesById.has(lid)) continue;
    if (!userStore.cellStats[lid]) userStore.cellStats[lid] = {};
    for (const [sl, st] of Object.entries(slots)) {
      const cc = getCellClass(sl);
      if (pruneUnknown && !isValidCardKey(`${lid}#${cc}`)) continue;
      const loc = userStore.cellStats[lid][cc] || { ok: 0, fail: 0 };
      userStore.cellStats[lid][cc] = { ok: Math.max(loc.ok, st.ok || 0), fail: Math.max(loc.fail, st.fail || 0) };
    }
  }
  if (data.meta && data.meta.placement && (!userStore.placement || (data.meta.placement.ts || 0) > (userStore.placement.ts || 0))) {
    userStore.placement = deepClone(data.meta.placement);
    await saveMeta('placement', userStore.placement);
  }
  const incTypoLog = (data.meta && data.meta.typoLog) || data.typoLog || {};
  if (incTypoLog && typeof incTypoLog === 'object') {
    if (!userStore.typoLog || typeof userStore.typoLog !== 'object') userStore.typoLog = {};
    for (const [k, rec] of Object.entries(incTypoLog)) {
      if (!rec || !rec.lemmaId || !rec.target) continue;
      if (pruneUnknown && !contentStore.entriesById.has(rec.lemmaId)) continue;
      const loc = userStore.typoLog[k];
      if (!loc || (rec.updatedAt || 0) > (loc.updatedAt || 0)) {
        const merged = deepClone(rec);
        if (loc && loc.diacriticOnly === false) merged.diacriticOnly = false;
        userStore.typoLog[k] = merged;
      }
    }
    await saveTypoLog();
  }
  const incMixups = (data.meta && data.meta.mixups) || data.mixups || {};
  if (incMixups && typeof incMixups === 'object') {
    if (!userStore.mixups || typeof userStore.mixups !== 'object') userStore.mixups = {};
    for (const [k, rec] of Object.entries(incMixups)) {
      if (!rec || !rec.key) continue;
      const loc = userStore.mixups[k];
      if (!loc || (rec.updatedAt || 0) > (loc.updatedAt || 0)) {
        userStore.mixups[k] = deepClone(rec);
      }
    }
    await saveMixups();
  }
  await saveCellStats();
  if (opts && opts.summary && typeof opts.summary === 'object') {
    opts.summary.imported = puts.length;
    opts.summary.skipped = skipped;
    opts.summary.pruned = deletes.length;
  }
  return puts.length;
}

export async function readFileTextResilient(file) {
  if (!file) throw new Error('No file selected');
  let text = '';
  if (typeof file.text === 'function') {
    try {
      text = String(await file.text());
    } catch (textErr) {
      if (typeof FileReader === 'undefined') throw textErr;
    }
  }
  if ((!text || !text.trim()) && typeof FileReader !== 'undefined') {
    text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('FileReader failed to read file'));
      reader.readAsText(file, 'UTF-8');
    });
  }
  return text;
}

export function parseBackupJsonText(rawText) {
  const cleaned = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) throw new Error('Backup JSON is empty');
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup JSON must be an object');
  }
  return parsed;
}


// Clean v2.4 migration: preserves cards/stats WITHOUT overwriting new 10-word defaults or unlocking non-Unit-1 tenses
export async function migrateFromV24IfNeeded() {
  if (userStore.cards.size > 0) return;
  try {
    const raw = window.localStorage.getItem('falacloze_v24_state');
    if (!raw) return;
    const old = JSON.parse(raw);
    if (!old || typeof old !== 'object') return;
    const puts = [];
    for (const [k, rec] of Object.entries(old.cards || {})) {
      const migrated = { ...createBlankCardRecord(k), ...rec, status: rec.state || rec.status || 'new' };
      userStore.cards.set(k, migrated); puts.push(migrated);
    }
    if (puts.length > 0) await idbBatchCards(puts, []);
    if (old.formStats) { userStore.cellStats = old.formStats; await saveCellStats(); }
    if (old.settings) {
      // Carry over audio/diacritic preferences ONLY; keep new v2.5 10-word & pres_base defaults intact
      if (typeof old.settings.strictDiacritics === 'boolean') userStore.settings.strictDiacritics = old.settings.strictDiacritics;
      if (typeof old.settings.autoPlay === 'boolean') userStore.settings.autoPlay = old.settings.autoPlay;
      if (typeof old.settings.rotateVoices === 'boolean') userStore.settings.rotateVoices = old.settings.rotateVoices;
      if (Array.isArray(old.settings.enabledVoices)) userStore.settings.enabledVoices = old.settings.enabledVoices;
      await saveSettings();
    }
    if (puts.length > 0) showToast(`Migrated ${puts.length} cards from v2.4`);
  } catch (_) {}
}

export async function autoLoadHostedFiles() {
  if (!isHttpOrigin()) return;
  if (contentStore.manifest && contentStore.lexicon) return;
  el('home-checking-pill').classList.remove('hidden');
  const fetchJson = async url => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try { const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' }); return r.ok ? await r.json() : null; }
    catch (_) { return null; }
    finally { clearTimeout(t); }
  };
  try {
    const prefixes = /\/app\//.test(location.pathname || '')
      ? ['../data/', './', './data/']
      : ['./', './data/', '../data/'];
    let manifest = null;
    for (const prefix of prefixes) {
      manifest = await fetchJson(prefix + 'manifest.json');
      if (manifest) { dataBasePrefix = prefix; break; }
    }
    if (manifest) {
      contentStore.manifest = manifest;
      const [lex, cur, amb] = await Promise.all([
        fetchJson(resolveDataUrl(buildVersionedAssetUrl((manifest.lexicon && manifest.lexicon.file) || 'lexicon.json'))),
        fetchJson(resolveDataUrl(buildVersionedAssetUrl((manifest.curriculum && manifest.curriculum.file) || 'curriculum.json'))),
        fetchJson(resolveDataUrl(buildVersionedAssetUrl((manifest.ambiguous && manifest.ambiguous.file) || 'ambiguous.json')))
      ]);
      if (lex) contentStore.lexicon = lex;
      if (cur) contentStore.curriculum = cur;
      if (amb) contentStore.ambiguous = amb;
      rebuildContentIndexes();
      const p1 = (manifest.packs || []).find(p => p.hash);
      if (p1) await loadPackOrExt(p1.file || `packs/${p1.id}.json`);
      appActions.renderHome();
    }
  } finally {
    el('home-checking-pill').classList.add('hidden');
  }
}
