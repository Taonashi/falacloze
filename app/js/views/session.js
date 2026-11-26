import { State, appActions, contentStore, dailyGoalState, deepClone, el, foldMarks, formatPOS, formatSlot, getLogicalDayStartMs, makeSpeakerIcon, makeUUID, navState, normNFC, parseCardKey, session, setPillWithIcon, showToast, userStore } from '../state.js';
import { FSRS6, createBlankCardRecord, sanitizeRetention } from '../fsrs.js';
import { autoUnlockTensesForUnit, computeAvailableSessionCounts, dismissConfusableRecommendation, ensureDailyRollover, getActiveTypoEntries, getCellClass, getCellStat, getEffectiveDailyNewCap, getEligibleExamples, getExampleFormKey, getExamplesForEntry, getFastAnswerThresholdMs, getHighestReachedUnit, idbDelete, idbPut, isClusterBlocked, isColloquialDeferred, isExampleFormKnown, isMultiFormEntry, isPackLoadedOrAvailable, isSentenceReported, isSiblingBuried, makeMixupPairKey, pickBestExample, preloadUpcomingPacks, recordConfusableMixup, recordTypoDrillAttempt, recordTypoEvent, resolveExampleSenseCluster, saveCellStats, saveMeta, saveSentenceReport, saveToday } from '../storage.js';
import { ICON_EYE_OFF_SVG, ICON_EYE_SVG, classifyAnswer, classifyAnswerWithPrefix, formatRecallTag, getCombinedNoteText, getPosPillClass, getSlotPillClass, isBlindAudioEligible, isDiacriticOnlyDiff, mountExample, normalizeColloquialContext, renderClozeSentence, renderCorrectedWordWithHighlight, renderCorrectionProgress, renderFeedbackBanner, renderHighlightedEnglish, renderRichGrammarNote, resolveGrammaticalTags, stripRedundantGenderNumberHint } from '../grading.js';
import { bindProgressiveExampleBtn, getNormalSpeechRate, pickVoiceForNewCard, playCorrectChime, playSummaryChord, renderProgressiveAudioBtn, speakClozeCard, speakClozeItem, speakPT, stopTTS } from '../tts.js';

export async function persistPausedSession() {
  const inFinale = navState.view === 'finale' && (!el('panel-blind').classList.contains('hidden') || !el('panel-recall').classList.contains('hidden'));
  const phase = inFinale ? (!el('panel-blind').classList.contains('hidden') ? 'blind' : 'recall') : session.mode;
  if (phase === 'study') {
    if (!session.activeItem || session.reviewedCount < 1) { await clearPausedSession(); return; }
  } else if (phase !== 'round1' && phase !== 'blind' && phase !== 'recall') {
    return;
  }
  const payload = {
    savedAt: Date.now(), phase, targetCount: session.targetCount,
    reviewedCount: session.reviewedCount, cleanCount: session.cleanCount,
    hardCount: session.hardCount, missedCount: session.missedCount,
    activeCardKey: session.activeItem ? session.activeItem.cardKey : null,
    activeExId: session.activeItem && session.activeItem.ex ? session.activeItem.ex.exId : null,
    requeueList: session.requeueList,
    round1Queue: (session.round1Queue || []).map(it => ({ cardKey: it.cardKey, exId: it.ex && it.ex.exId })),
    failedExactItems: (session.failedExactItems || []).map(it => ({
      cardKey: it.cardKey,
      lemmaId: it.entry ? it.entry.id : null,
      exId: it.ex ? it.ex.exId : null,
      cellClass: it.cellClass || null
    })),
    blindIdx: session.blindIdx || 0,
    recallTiles: deepClone(session.recallTiles || []),
    missedIds: Array.from(session.missedIds), hardIds: Array.from(session.hardIds),
    newLearnedIds: Array.from(session.newLearnedIds),
    mainHistory: deepClone(session.mainHistory || []),
    seenMainExIds: Array.from(session.seenMainExIds || []),
    sessionLog: Array.from(session.sessionLog.entries())
  };
  userStore.activeSession = payload;
  await saveMeta('activeSession', payload);
}

export async function clearPausedSession() {
  userStore.activeSession = null;
  await idbDelete('meta', 'activeSession');
}

export function captureSnapshot() {
  if (!session.activeItem) return null;
  const { cardKey, entry, ex } = session.activeItem;
  const prev = userStore.cards.get(cardKey);
  return {
    cardKey, lemmaId: entry.id, exId: ex.exId, cellClass: ex.cellClass,
    priorRec: prev ? deepClone(prev) : null,
    priorCellStats: userStore.cellStats[entry.id] ? deepClone(userStore.cellStats[entry.id]) : null,
    priorToday: deepClone(userStore.today),
    priorRequeue: deepClone(session.requeueList),
    priorRequeuedFormKeys: Array.from(session.requeuedFormKeys || []),
    priorReviewed: session.reviewedCount, priorClean: session.cleanCount,
    priorHard: session.hardCount, priorMissed: session.missedCount,
    priorMissedIds: Array.from(session.missedIds),
    priorHardIds: Array.from(session.hardIds),
    priorNewIds: Array.from(session.newLearnedIds),
    priorMainHistoryLen: Array.isArray(session.mainHistory) ? session.mainHistory.length : 0,
    priorFailedExactLen: Array.isArray(session.failedExactItems) ? session.failedExactItems.length : 0,
    priorSeenMainExIds: Array.from(session.seenMainExIds || []),
    priorMode: session.mode,
    priorRound1Queue: (session.round1Queue || []).slice(),
    sessionLogKey: makeSessionLogKey(entry.id, ex),
    priorSessionEntry: session.sessionLog.has(makeSessionLogKey(entry.id, ex)) ? deepClone(session.sessionLog.get(makeSessionLogKey(entry.id, ex))) : null,
    reviewId: null
  };
}

export function makeSessionLogKey(lemmaId, exOrAnswer) {
  const ans = typeof exOrAnswer === 'string'
    ? exOrAnswer
    : (exOrAnswer && exOrAnswer.answer ? exOrAnswer.answer : '');
  const normAns = normNFC(ans);
  return normAns ? `${lemmaId}::${normAns}` : String(lemmaId);
}

export async function commitReview(snap, grade, nowMs = Date.now()) {
  ensureDailyRollover();
  if (session.mode === 'round1') return;
  if (session.mode === 'verb_drill') {
    session.reviewedCount += 1;
    if (grade >= 3) session.cleanCount += 1;
    return;
  }

  const { cardKey, lemmaId, exId, cellClass, priorRec } = snap;
  const entry = contentStore.entriesById.get(lemmaId);
  if (!entry) return;
  const { cellClass: subCell } = parseCardKey(cardKey);
  const isNew = !priorRec || priorRec.status === 'assumed' || priorRec.assumed;

  if (isNew && !subCell && session.mode === 'study') {
    userStore.today.newLemmas += 1;
    session.newLearnedIds.add(lemmaId);
    if (entry.cluster_id && !userStore.today.clustersToday.includes(entry.cluster_id)) {
      userStore.today.clustersToday.push(entry.cluster_id);
    }
    autoUnlockTensesForUnit(entry.unit);
  }

  if (!userStore.today.reviewedLemmasToday.includes(lemmaId)) userStore.today.reviewedLemmasToday.push(lemmaId);
  const ex = session.activeItem ? session.activeItem.ex : null;
  if (ex && !userStore.today.shownSentencesToday.includes(normNFC(ex.pt))) userStore.today.shownSentencesToday.push(normNFC(ex.pt));

  let nextRec = null;
  if (session.mode === 'check_known' && grade >= 3) {
    nextRec = priorRec ? deepClone(priorRec) : createBlankCardRecord(cardKey);
    nextRec.assumed = false; nextRec.status = 'known';
    nextRec.stability = 21; nextRec.difficulty = 4.5; nextRec.interval = 21;
    nextRec.due = nowMs + 21 * 86400000; nextRec.last_review = nowMs; nextRec.updatedAt = nowMs;
    nextRec.lastExampleId = exId;
    userStore.cards.set(cardKey, nextRec);
    await idbPut('cards', nextRec);
  } else if (session.mode === 'check_known' && grade < 3) {
    userStore.cards.delete(cardKey);
    await idbDelete('cards', cardKey);
  } else {
    nextRec = FSRS6.schedule(cardKey, priorRec, grade, sanitizeRetention(userStore.settings.desiredRetention, 0.85), nowMs);
    nextRec.lastExampleId = exId;
    userStore.cards.set(cardKey, nextRec);
    await idbPut('cards', nextRec);
  }

  if (!userStore.cellStats[lemmaId]) userStore.cellStats[lemmaId] = {};
  if (!userStore.cellStats[lemmaId][cellClass]) userStore.cellStats[lemmaId][cellClass] = { ok: 0, fail: 0 };
  if (grade >= 3) userStore.cellStats[lemmaId][cellClass].ok += 1;
  else {
    userStore.cellStats[lemmaId][cellClass].fail += 1;
    if (!subCell && cellClass !== 'base' && userStore.cellStats[lemmaId][cellClass].fail >= 2) {
      const splitKey = `${lemmaId}#${cellClass}`;
      if (!userStore.cards.has(splitKey)) {
        const sub = createBlankCardRecord(splitKey);
        sub.updatedAt = nowMs;
        userStore.cards.set(splitKey, sub);
        await idbPut('cards', sub);
      }
    }
  }

  const revObj = { uuid: makeUUID(), ts: nowMs, cardKey, exId, grade };
  const revId = await idbPut('reviews', revObj);
  revObj.id = revId;
  userStore.reviews.push(revObj);
  snap.reviewId = revId;

  session.reviewedCount += 1;
  const missedOnFirstAttempt = grade === 1 || grade === 2 || session.attemptCount > 0 || session.usedHint;
  if (grade === 3) session.cleanCount += 1;
  else if (grade === 2) { session.hardCount += 1; session.hardIds.add(lemmaId); }
  else {
    session.missedCount += 1; session.missedIds.add(lemmaId);
  }
  if (session.mode === 'study' && grade < 3 && ex) {
    if (!Array.isArray(session.failedExactItems)) session.failedExactItems = [];
    if (!session.failedExactItems.some(it => it && it.ex && it.ex.exId === ex.exId)) {
      session.failedExactItems.push({ cardKey, entry, ex, cellClass: parseCardKey(cardKey).cellClass });
    }
  }
  if (session.mode === 'study' && (missedOnFirstAttempt || isNew)) {
    const formRqKey = makeSessionLogKey(lemmaId, ex);
    if (!session.requeuedFormKeys) session.requeuedFormKeys = new Set();
    if (!session.requeuedFormKeys.has(formRqKey) && !session.requeueList.some(r => r.formRqKey === formRqKey)) {
      session.requeuedFormKeys.add(formRqKey);
      session.requeueList.push({
        cardKey,
        cellClass: subCell || (ex && ex.cellClass) || null,
        formRqKey,
        origExampleId: exId,
        waitSteps: 3 + (session.requeueList.length % 3)
      });
    }
  }

  const logKey = snap.sessionLogKey || makeSessionLogKey(lemmaId, ex);
  const prevLog = session.sessionLog.get(logKey);
  const isTricky = grade < 3 || session.usedHint;
  const cleanedHint = ex ? (resolveGrammaticalTags(entry, ex).cleanedHint || ex.clean_hint_en || entry.en_gloss) : entry.en_gloss;
  session.sessionLog.set(logKey, {
    lemmaId,
    exId,
    answer: ex ? ex.answer : (prevLog ? prevLog.answer : ''),
    cleanedHint: cleanedHint || (prevLog ? prevLog.cleanedHint : entry.en_gloss),
    grade: prevLog ? Math.min(prevLog.grade, grade) : grade,
    wasNew: (prevLog ? prevLog.wasNew : false) || isNew,
    tricky: (prevLog ? prevLog.tricky : false) || isTricky,
    skippedKnown: false
  });
  if (session.mode === 'study' && ex) {
    if (!Array.isArray(session.mainHistory)) session.mainHistory = [];
    if (!(session.seenMainExIds instanceof Set)) session.seenMainExIds = new Set(session.seenMainExIds || []);
    session.seenMainExIds.add(ex.exId);
    session.mainHistory.push({
      exId: ex.exId,
      lemmaId,
      pt: ex.pt || '',
      en: ex.en || '',
      answer: ex.answer || '',
      slot: ex.slot || 'base',
      grade,
      outcome: grade >= 3 ? 'clean' : (grade === 2 ? 'hard' : 'missed'),
      wasNew: isNew,
      ts: nowMs
    });
  }

  session.lastPreSnapshot = snap;
  session.undoStack.push(snap);
  if (session.undoStack.length > 20) session.undoStack.shift();

  await saveToday();
  await saveCellStats();
  if (session.mode === 'study') await persistPausedSession();
  updateUndoButtons();
}

export async function restoreSnapshot(snap) {
  if (!snap) return;
  if (snap.priorRec) {
    const r = deepClone(snap.priorRec); r.updatedAt = Date.now();
    userStore.cards.set(snap.cardKey, r);
    await idbPut('cards', r);
  } else {
    userStore.cards.delete(snap.cardKey);
    await idbDelete('cards', snap.cardKey);
  }
  if (snap.priorCellStats) userStore.cellStats[snap.lemmaId] = deepClone(snap.priorCellStats);
  else delete userStore.cellStats[snap.lemmaId];

  userStore.today = deepClone(snap.priorToday);
  if (snap.reviewId != null) {
    await idbDelete('reviews', snap.reviewId);
    userStore.reviews = userStore.reviews.filter(r => r.id !== snap.reviewId);
  }

  session.requeueList = deepClone(snap.priorRequeue);
  if (Array.isArray(snap.priorRequeuedFormKeys)) session.requeuedFormKeys = new Set(snap.priorRequeuedFormKeys);
  session.reviewedCount = snap.priorReviewed;
  session.cleanCount = snap.priorClean;
  session.hardCount = snap.priorHard;
  session.missedCount = snap.priorMissed;
  session.missedIds = new Set(snap.priorMissedIds);
  session.hardIds = new Set(snap.priorHardIds);
  session.newLearnedIds = new Set(snap.priorNewIds);
  if (typeof snap.priorMainHistoryLen === 'number' && Array.isArray(session.mainHistory)) {
    session.mainHistory.length = Math.min(session.mainHistory.length, snap.priorMainHistoryLen);
  }
  if (typeof snap.priorFailedExactLen === 'number' && Array.isArray(session.failedExactItems)) {
    session.failedExactItems.length = Math.min(session.failedExactItems.length, snap.priorFailedExactLen);
  }
  if (Array.isArray(snap.priorSeenMainExIds)) {
    session.seenMainExIds = new Set(snap.priorSeenMainExIds);
  }
  if (snap.priorMode) session.mode = snap.priorMode;
  if (Array.isArray(snap.priorRound1Queue)) session.round1Queue = snap.priorRound1Queue.slice();
  const restoreLogKey = snap.sessionLogKey || snap.lemmaId;
  if (snap.priorSessionEntry) session.sessionLog.set(restoreLogKey, deepClone(snap.priorSessionEntry));
  else session.sessionLog.delete(restoreLogKey);

  await saveToday();
  await saveCellStats();
}

export async function performUndo() {
  if ((session.mode !== 'study' && session.mode !== 'check_known' && session.mode !== 'round1') || session.undoStack.length === 0) return;
  const snap = session.undoStack.pop();
  session.lastPreSnapshot = null;
  await restoreSnapshot(snap);
  const entry = contentStore.entriesById.get(snap.lemmaId);
  if (entry) {
    const exs = await getExamplesForEntry(entry);
    const ex = exs.find(e => e.exId === snap.exId) || exs[0];
    if (ex) mountStudyItem({ cardKey: snap.cardKey, entry, ex, cellClass: parseCardKey(snap.cardKey).cellClass });
  }
  updateUndoButtons();
  showToast('Returned to previous word');
}

export async function handleOverrideWrong() {
  if (session.mode !== 'study' || !session.lastPreSnapshot || !session.activeItem) return;
  const snap = session.lastPreSnapshot;
  if (session.undoStack.length > 0 && session.undoStack[session.undoStack.length - 1] === snap) session.undoStack.pop();
  await restoreSnapshot(snap);
  await commitReview(snap, 1, Date.now());
  const { entry, ex } = session.activeItem;
  session.revealed = false;
  session.needsCorrection = true;
  session.triggeredByDontKnow = false;
  session.dontKnowSkipArmed = false;
  session.lastSubmittedVal = '';
  const inp = el('answer-input');
  inp.value = '';
  inp.placeholder = `Type "${ex.answer}"...`;
  renderCorrectionProgress(el('sc-pt-box'), ex, '');
  el('btn-known').classList.remove('already-know-beckon');
  renderFeedbackBanner({
    tone: 'error',
    statusText: 'Marked for review',
    wordText: ex.answer,
    lemmaId: entry.id,
    instructionText: 'Type it below to continue.',
    showIWasWrong: false,
    showNotes: true,
    ex,
    entry
  });
  scrollFeedbackBannerIntoView();
  setPrimaryAction('check');
  syncAudioControlsVisibility();
  focusAnswerInput();
  showToast('Marked for review');
}

export function updateUndoButtons() {
  const canUndo = (session.mode === 'study' || session.mode === 'check_known') && session.undoStack.length > 0;
  const prevBtn = el('btn-prev-word');
  prevBtn.disabled = false;
  prevBtn.setAttribute('aria-label', canUndo ? 'Previous word' : 'Back to Home');
  prevBtn.setAttribute('title', canUndo ? 'Previous word' : 'Back to Home');
  el('btn-walk-undo').disabled = !canUndo;
}


async function resolveRequeueItem(rq) {
  if (!rq || !rq.cardKey) return null;
  const { lemmaId, cellClass } = parseCardKey(rq.cardKey);
  const entry = contentStore.entriesById.get(lemmaId);
  if (!entry || !isPackLoadedOrAvailable(entry.packId)) return null;
  const lockedSenseKey = session.lemmaSenseMap instanceof Map ? (session.lemmaSenseMap.get(lemmaId) || null) : null;
  const targetCell = rq.cellClass || cellClass || null;
  let ex = await pickBestExample(entry, targetCell, rq.cardKey, false, {
    excludeExampleId: rq.origExampleId,
    preferDifferentContext: true,
    lockedSenseKey
  });
  if (!ex && targetCell && !cellClass) {
    ex = await pickBestExample(entry, null, rq.cardKey, false, {
      excludeExampleId: rq.origExampleId,
      preferDifferentContext: true,
      lockedSenseKey
    });
  }
  return ex ? { cardKey: rq.cardKey, entry, ex, cellClass: cellClass || (ex && ex.cellClass) || null, isRequeue: true } : null;
}

export async function pickNextStudyItem() {
  if (session.mode === 'round1') {
    if (Array.isArray(session.round1Items) && session.round1Items.length > 0) {
      const nextIdx = (session.round1Idx != null ? session.round1Idx : -1) + 1;
      if (nextIdx < session.round1Items.length) {
        session.round1Idx = nextIdx;
        session.round1Queue = session.round1Items.slice(nextIdx + 1);
        return session.round1Items[nextIdx];
      }
      session.round1Queue = [];
      return null;
    }
    return session.round1Queue.shift() || null;
  }
  if (session.mode === 'verb_drill' || session.mode === 'check_known') return session.drillQueue.shift() || null;

  const now = Date.now();

  // 1. Due same-session contextual requeue (bypasses sibling burying & prefers different context sentence)
  const rqIdx = session.requeueList.findIndex(r => r.waitSteps <= 0);
  if (rqIdx !== -1) {
    const [rq] = session.requeueList.splice(rqIdx, 1);
    const resolvedRq = await resolveRequeueItem(rq);
    if (resolvedRq) return resolvedRq;
  }

  // 2. If targetCount reached, drain any pending same-session requeues before ending main phase
  if (session.reviewedCount >= session.targetCount) {
    while (session.requeueList.length > 0) {
      const rq = session.requeueList.shift();
      const resolvedRq = await resolveRequeueItem(rq);
      if (resolvedRq) return resolvedRq;
    }
    return null;
  }

  const dueLearn = [], dueReview = [], soonLearn = [];
  for (const [cardKey, rec] of userStore.cards.entries()) {
    if (rec.suspended || rec.assumed || rec.status === 'assumed') continue;
    const { lemmaId, cellClass } = parseCardKey(cardKey);
    const entry = contentStore.entriesById.get(lemmaId);
    if (!entry || !isPackLoadedOrAvailable(entry.packId)) continue;
    if (rec.status === 'learning' || rec.status === 'relearning') {
      if (rec.due <= now) dueLearn.push({ cardKey, entry, cellClass, due: rec.due });
      else if (rec.due <= now + 15 * 60000) soonLearn.push({ cardKey, entry, cellClass, due: rec.due });
    } else if (rec.status === 'review' && rec.due <= now && !isSiblingBuried(lemmaId)) {
      dueReview.push({ cardKey, entry, cellClass, due: rec.due });
    }
  }

  dueLearn.sort((a, b) => a.due - b.due);
  for (const p of dueLearn) {
    const lockedSenseKey = session.lemmaSenseMap instanceof Map ? (session.lemmaSenseMap.get(p.entry.id) || null) : null;
    const ex = await pickBestExample(p.entry, p.cellClass, p.cardKey, false, { lockedSenseKey });
    if (ex) { preloadUpcomingPacks(dueLearn.slice(1).map(x => x.entry)); return { ...p, ex }; }
  }

  dueReview.sort((a, b) => a.due - b.due);
  for (const p of dueReview) {
    const lockedSenseKey = session.lemmaSenseMap instanceof Map ? (session.lemmaSenseMap.get(p.entry.id) || null) : null;
    const ex = await pickBestExample(p.entry, p.cellClass, p.cardKey, false, { lockedSenseKey });
    if (ex) { preloadUpcomingPacks(dueReview.slice(1).map(x => x.entry)); return { ...p, ex }; }
  }

  if (userStore.today.newLemmas < getEffectiveDailyNewCap()) {
    const candidates = [];
    for (const entry of contentStore.orderedEntries) {
      if (userStore.cards.has(entry.id)) continue;
      if (!isPackLoadedOrAvailable(entry.packId)) continue;
      if (isClusterBlocked(entry, now)) continue;
      if (isColloquialDeferred(entry)) continue;
      candidates.push(entry);
      if (candidates.length >= 8) break;
    }
    if (candidates.length > 0) {
      let chosen = candidates[0];
      if (session.recentNewVerbStreak >= 3 && chosen.pos === 'VERB') {
        const nonVerb = candidates.find(c => c.pos !== 'VERB' && c.unit === chosen.unit);
        if (nonVerb) chosen = nonVerb;
      }
      const ex = await pickBestExample(chosen, null, chosen.id, true);
      if (ex) {
        session.recentNewVerbStreak = chosen.pos === 'VERB' ? session.recentNewVerbStreak + 1 : 0;
        preloadUpcomingPacks(candidates.filter(c => c !== chosen));
        return { cardKey: chosen.id, entry: chosen, ex, cellClass: null };
      }
    }
  }

  while (session.requeueList.length > 0) {
    const rq = session.requeueList.shift();
    const resolvedRq = await resolveRequeueItem(rq);
    if (resolvedRq) return resolvedRq;
  }

  const dripped = await dripInFormSubCard(now);
  if (dripped) return dripped;

  soonLearn.sort((a, b) => a.due - b.due);
  for (const p of soonLearn) {
    const lockedSenseKey = session.lemmaSenseMap instanceof Map ? (session.lemmaSenseMap.get(p.entry.id) || null) : null;
    const ex = await pickBestExample(p.entry, p.cellClass, p.cardKey, false, { lockedSenseKey });
    if (ex) return { ...p, ex };
  }
  return null;
}

export async function dripInFormSubCard(nowMs = Date.now()) {
  const cap = Number(userStore.settings.dailyNewFormCap) || 5;
  if ((userStore.today.newForms || 0) >= cap) return null;
  for (const [cardKey, rec] of userStore.cards.entries()) {
    const { lemmaId, cellClass } = parseCardKey(cardKey);
    if (cellClass || rec.suspended || rec.assumed || rec.status === 'assumed') continue;
    if ((rec.stability || 0) < 7) continue;
    if (isSiblingBuried(lemmaId)) continue;
    const entry = contentStore.entriesById.get(lemmaId);
    if (!entry || !isPackLoadedOrAvailable(entry.packId)) continue;
    const eligible = await getEligibleExamples(entry, null);
    const unintroduced = eligible.find(ex => {
      if (!ex.cellClass || ex.cellClass === 'base') return false;
      const subKey = `${lemmaId}#${ex.cellClass}`;
      if (userStore.cards.has(subKey)) return false;
      const st = getCellStat(lemmaId, ex.cellClass);
      return (st.ok || 0) === 0 && (st.fail || 0) === 0;
    });
    if (unintroduced) {
      const subKey = `${lemmaId}#${unintroduced.cellClass}`;
      const subRec = createBlankCardRecord(subKey);
      subRec.updatedAt = nowMs;
      userStore.cards.set(subKey, subRec);
      await idbPut('cards', subRec);
      userStore.today.newForms = (userStore.today.newForms || 0) + 1;
      await saveToday();
      return { cardKey: subKey, entry, ex: unintroduced, cellClass: unintroduced.cellClass };
    }
  }
  return null;
}

/* ==========================================================================
   11. STUDY UI, DIACRITICS BAR TOGGLE, MULTI-ATTEMPT & MANDATORY RE-TYPE
   ========================================================================== */
export function focusAnswerInput() {
  if (session.mode === 'study' && userStore.settings.walkMode) return;
  el('answer-input').focus({ preventScroll: true });
}

export function syncDiacriticsBarVisibility() {
  const hide = Boolean(userStore.settings.hideDiacriticsBar);
  el('diacritic-bar').classList.toggle('hidden', hide);
  const rBar = el('recall-diacritic-bar');
  if (rBar) rBar.classList.toggle('hidden', hide);
}

export function syncAudioControlsVisibility() {
  const isPost = Boolean(session.revealed || session.needsCorrection);
  const phase = isPost ? 'post' : 'pre';
  if (session.lastAudioPhase !== phase) {
    session.clozeManualPlayCount = 0;
    session.lastAudioPhase = phase;
  }
  const label = isPost ? 'Replay' : 'Listen';
  const dockAudio = el('dock-audio-controls');
  if (dockAudio) dockAudio.classList.remove('hidden');
  const walkAudio = el('walk-audio-controls');
  if (walkAudio) walkAudio.classList.remove('hidden');
  renderProgressiveAudioBtn(el('btn-replay-audio'), label, session.clozeManualPlayCount, 15);
  renderProgressiveAudioBtn(el('btn-walk-audio'), label, session.clozeManualPlayCount, 15);
}

export function triggerClozeAudio() {
  if (!session.activeItem) return;
  const isPost = Boolean(session.revealed || session.needsCorrection);
  const phase = isPost ? 'post' : 'pre';
  if (session.lastAudioPhase !== phase) {
    session.clozeManualPlayCount = 0;
    session.lastAudioPhase = phase;
  }
  session.clozeManualPlayCount += 1;
  const rate = session.clozeManualPlayCount >= 2 ? 0.75 : getNormalSpeechRate();
  syncAudioControlsVisibility();
  speakClozeItem(session.activeItem.ex, isPost, rate);
}

export function setPrimaryAction(state) {
  const btn = el('btn-primary-action');
  if (state === 'dont_know') { btn.className = 'btn btn-primary-soft'; btn.textContent = "Don't know"; }
  else if (state === 'check_soft') { btn.className = 'btn btn-primary-soft'; btn.textContent = 'Check'; }
  else if (state === 'check') { btn.className = 'btn btn-primary'; btn.textContent = 'Check'; }
  else if (state === 'next_good') { btn.className = 'btn btn-emerald'; btn.textContent = 'Next'; }
  else if (state === 'next_hard') { btn.className = 'btn btn-mint-soft'; btn.textContent = 'Next'; }
  else if (state === 'next_again') { btn.className = 'btn btn-rose'; btn.textContent = 'Next'; }
}


export function updateSessionHeader() {
  const titleEl = el('session-title');
  if (session.mode === 'round1') {
    titleEl.textContent = 'Fix';
    titleEl.classList.remove('hidden');
    const tot = Math.max(1, session.round1Total || (Array.isArray(session.round1Items) ? session.round1Items.length : 0) || (session.round1Queue.length + (session.activeItem ? 1 : 0)));
    const cur = Math.min(tot, (session.round1Idx != null ? session.round1Idx : 0) + (session.activeItem ? 1 : 0));
    el('session-counter').textContent = `${cur}/${tot}`;
    el('session-progress-fill').style.width = `${Math.min(100, Math.round((cur / tot) * 100))}%`;
  } else if (session.mode === 'verb_drill' || session.mode === 'check_known') {
    titleEl.textContent = session.mode === 'verb_drill' ? 'Drill' : 'Check';
    titleEl.classList.remove('hidden');
    const rem = (Array.isArray(session.drillQueue) ? session.drillQueue.length : 0) + (session.activeItem && !session.revealed ? 1 : 0);
    const tot = Math.max(1, session.targetCount, session.reviewedCount + rem);
    const cur = Math.min(session.reviewedCount, tot);
    el('session-counter').textContent = `${cur}/${tot}`;
    el('session-progress-fill').style.width = `${Math.min(100, Math.round((cur / tot) * 100))}%`;
  } else {
    titleEl.textContent = '';
    titleEl.classList.add('hidden');
    const pendingRq = Array.isArray(session.requeueList) ? session.requeueList.length : 0;
    const goal = session.targetCount === 999
      ? Math.max(1, session.reviewedCount + (session.activeItem ? 1 : 0))
      : Math.max(1, session.targetCount, session.reviewedCount + pendingRq);
    const cur = Math.min(session.reviewedCount, goal);
    el('session-counter').textContent = session.targetCount === 999 ? `${cur} done` : `${cur}/${goal}`;
    el('session-progress-fill').style.width = `${Math.min(100, Math.round((cur / goal) * 100))}%`;
    el('btn-sheet-finish').classList.toggle('hidden', session.reviewedCount < 1);
  }
}


export function scrollFeedbackBannerIntoView(bannerId = 'sc-feedback-banner') {
  const banner = el(bannerId);
  if (!banner || banner.classList.contains('hidden')) return;
  const container = (typeof banner.closest === 'function' ? banner.closest('.train-body') : null)
    || (typeof document.querySelector === 'function' ? document.querySelector('#view-session .train-body') : null);
  if (!container) return;
  const doScroll = () => {
    if (typeof container.getBoundingClientRect === 'function' && typeof banner.getBoundingClientRect === 'function') {
      const cRect = container.getBoundingClientRect();
      const bRect = banner.getBoundingClientRect();
      if (bRect.bottom > cRect.bottom - 10) {
        const nextTop = Math.max(0, (container.scrollTop || 0) + (bRect.bottom - cRect.bottom) + 16);
        if (typeof container.scrollTo === 'function') container.scrollTo({ top: nextTop, behavior: 'smooth' });
        else container.scrollTop = nextTop;
      } else if (bRect.top < cRect.top + 4) {
        const nextTop = Math.max(0, (container.scrollTop || 0) + (bRect.top - cRect.top) - 8);
        if (typeof container.scrollTo === 'function') container.scrollTo({ top: nextTop, behavior: 'smooth' });
        else container.scrollTop = nextTop;
      }
    } else {
      const nextTop = Math.max(0, (banner.offsetTop || 0) - 8);
      if (typeof container.scrollTo === 'function') container.scrollTo({ top: nextTop, behavior: 'smooth' });
      else container.scrollTop = nextTop;
    }
  };
  doScroll();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doScroll);
}

export function mountStudyItem(item) {
  stopTTS();
  session.activeItem = item;
  session.revealed = false;
  session.needsCorrection = false;
  session.clozeManualPlayCount = 0;
  session.lastAudioPhase = 'pre';
  session.triggeredByDontKnow = false;
  session.dontKnowSkipArmed = false;
  session.attemptCount = 0;
  session.revealedPrefixLen = 0;
  session.hadStrictAccentRetry = false;
  session.hadWrongFormRetry = false;
  session.usedHint = false;
  session.timerStartMs = Date.now();
  session.timerAccumMs = 0;
  session.firstKeystrokeMs = null;
  session.cardOpenedAt = Date.now();
  session.transitionLockUntil = Date.now() + 300;

  pickVoiceForNewCard();

  const { cardKey, entry, ex } = item;
  const rec = userStore.cards.get(cardKey);
  if (session.mode === 'study' && entry && ex) {
    if (!(session.lemmaSenseMap instanceof Map)) session.lemmaSenseMap = new Map();
    if (!session.lemmaSenseMap.has(entry.id)) {
      session.lemmaSenseMap.set(entry.id, resolveExampleSenseCluster(entry, ex).key);
    }
  }

  const posBadge = el('sc-pos');
  posBadge.textContent = formatPOS(entry.pos);
  posBadge.className = `badge ${getPosPillClass(entry.pos)}`;

  const tags = resolveGrammaticalTags(entry, ex);
  const slotEl = el('sc-slot');
  const slotDisplay = entry.pos === 'VERB' ? formatSlot(ex.slot).display : '';
  if (slotDisplay) {
    slotEl.textContent = slotDisplay;
    slotEl.className = `badge ${getSlotPillClass(ex.slot || slotDisplay)}`;
  } else {
    slotEl.className = 'badge hidden';
  }

  const genEl = el('sc-gender');
  if (tags.gender) {
    if (tags.gender === 'm') {
      genEl.className = 'badge pill-icon-wrap pill-masc';
      setPillWithIcon(genEl, 'm', 'Masculine');
    } else if (tags.gender === 'f') {
      genEl.className = 'badge pill-icon-wrap pill-fem';
      setPillWithIcon(genEl, 'f', 'Feminine');
    } else {
      genEl.className = 'badge pill-mf';
      genEl.textContent = 'Masc. / Fem.';
    }
  } else {
    genEl.className = 'badge hidden';
  }

  const numEl = el('sc-number');
  if (numEl) {
    if (tags.number) {
      numEl.className = 'badge pill-icon-wrap pill-slot-num';
      setPillWithIcon(numEl, tags.number, tags.number === 'sg' ? 'Singular' : 'Plural');
    } else {
      numEl.className = 'badge hidden';
    }
  }

  el('sc-heteronym').classList.toggle('hidden', !entry.heteronym);
  el('sc-leech').classList.toggle('hidden', !(rec && rec.leech));

  // Strict pre-answer anti-spoiler
  el('sc-ff-badge').textContent = ''; el('sc-ff-badge').classList.add('hidden');

  el('sc-feedback-banner').classList.add('hidden');
  el('sc-feedback-msg').textContent = '';
  const fbSubEl = el('sc-feedback-sub');
  if (fbSubEl) { fbSubEl.textContent = ''; fbSubEl.classList.add('hidden'); }
  el('btn-override-wrong').classList.add('hidden');
  const studyBody = (typeof el('sc-feedback-banner').closest === 'function' ? el('sc-feedback-banner').closest('.train-body') : null)
    || (typeof document.querySelector === 'function' ? document.querySelector('#view-session .train-body') : null);
  if (studyBody) studyBody.scrollTop = 0;

  mountExample(el('sc-pt-box'), ex, { revealed: false, typed: '', revealedPrefixLen: 0, onGapTap: focusAnswerInput });
  const cleanedHint = tags.cleanedHint;
  const hlRes = renderHighlightedEnglish(el('sc-en'), ex.en, cleanedHint, entry.en_gloss, ex.answer);

  const qualMatch = cleanedHint.match(/\(([^()]+)\)/);
  const hintEl = el('sc-hint');
  if (hlRes && hlRes.matched && !qualMatch) {
    hintEl.textContent = '';
    hintEl.classList.add('hidden');
  } else if (hlRes && hlRes.matched && qualMatch) {
    hintEl.textContent = qualMatch[0];
    hintEl.classList.remove('hidden');
  } else {
    hintEl.textContent = cleanedHint;
    hintEl.classList.toggle('hidden', !cleanedHint);
  }

  const knownBtn = el('btn-known');
  knownBtn.classList.remove('already-know-beckon');
  knownBtn.classList.toggle('hidden', session.mode !== 'study');
  const repBtn = el('btn-report-sentence');
  if (repBtn) repBtn.classList.toggle('reported', isSentenceReported(ex && ex.exId));
  syncSfxButtonUI();
  // Removed duplicate bottom-right task status label

  setPrimaryAction('dont_know');
  syncDiacriticsBarVisibility();
  syncAudioControlsVisibility();
  updateSessionHeader();
  updateUndoButtons();

  const isWalk = session.mode === 'study' && userStore.settings.walkMode;
  el('study-input-dock').classList.toggle('hidden', isWalk);
  el('controls-walk').classList.toggle('hidden', !isWalk);

  if (isWalk) {
    el('btn-walk-reveal').classList.remove('hidden');
    el('walk-grade-row').classList.add('hidden');
  } else {
    const inp = el('answer-input');
    inp.value = '';
    inp.placeholder = 'Type missing PT-BR word...';
    inp.focus({ preventScroll: true });
  }
  if (session.mode === 'study') persistPausedSession();
}

export function revealPostAnswerNotes(entry, ex) {
  if (entry.false_friend || ex.false_friend_note) {
    el('sc-ff-badge').textContent = 'False Friend';
    el('sc-ff-badge').classList.remove('hidden');
  }
}

export function advanceRevealedPrefix(answer, curLen) {
  const chars = Array.from(String(answer || ''));
  const maxLen = Math.max(0, chars.length - 1);
  let next = Math.min(maxLen, curLen + 1);
  while (next < maxLen && (chars[next - 1] === ' ' || chars[next - 1] === '-')) next++;
  return next;
}

export async function enterMandatoryRetype(entry, ex, msgPrefix = null, fromDontKnow = false) {
  if (session.mode === 'round1' && session.activeItem) {
    if (Array.isArray(session.round1Items)) {
      session.round1Items.push(session.activeItem);
      session.round1Total = session.round1Items.length;
      session.round1Queue = session.round1Items.slice((session.round1Idx || 0) + 1);
    } else {
      session.round1Queue.push(session.activeItem);
    }
  }
  else await commitReview(captureSnapshot(), 1);

  renderCorrectionProgress(el('sc-pt-box'), ex, '');
  revealPostAnswerNotes(entry, ex);
  el('btn-known').classList.remove('already-know-beckon');
  renderFeedbackBanner({
    tone: 'error',
    statusText: msgPrefix || 'Answer:',
    wordText: ex.answer,
    lemmaId: entry.id,
    instructionText: 'Type it below to continue.',
    showIWasWrong: false,
    showNotes: true,
    ex,
    entry
  });
  scrollFeedbackBannerIntoView();
  session.needsCorrection = true;
  session.triggeredByDontKnow = Boolean(fromDontKnow);
  session.dontKnowSkipArmed = false;
  session.revealed = false;
  syncAudioControlsVisibility();
  setPrimaryAction('check_soft');
  el('btn-primary-action').disabled = false;
  const inp = el('answer-input');
  inp.value = '';
  inp.placeholder = `Type "${ex.answer}"...`;
  if (userStore.settings.autoPlay) speakClozeItem(ex, true);
  updateSessionHeader();
  inp.focus({ preventScroll: true });
}

export async function handlePrimarySubmit() {
  if (session.isComposing || !session.activeItem) return;
  if (Date.now() < session.transitionLockUntil) return;

  const { cardKey, entry, ex } = session.activeItem;
  const inp = el('answer-input');

  if (session.revealed) {
    await advanceStudy();
    return;
  }

  const rawVal = inp.value;
  const trimmed = rawVal.trim();
  session.lastSubmittedVal = trimmed;
  inp.value = '';

  // Mandatory re-type mode (never disables button; Don't know allows empty tap -> Next -> advance; typing speaks audio 2nd time!)
  if (session.needsCorrection) {
    if (!trimmed) {
      if (session.triggeredByDontKnow) {
        if (!session.dontKnowSkipArmed) {
          session.dontKnowSkipArmed = true;
          setPrimaryAction('next_again');
          inp.focus({ preventScroll: true });
          return;
        }
        session.needsCorrection = false;
        session.dontKnowSkipArmed = false;
        await advanceStudy();
        return;
      }
      renderCorrectionProgress(el('sc-pt-box'), ex, '');
      renderFeedbackBanner({
        tone: 'error',
        statusText: 'Answer:',
        wordText: ex.answer,
        lemmaId: entry.id,
        instructionText: 'Type it below to continue.',
        showIWasWrong: false,
        showNotes: true,
        ex,
        entry
      });
      scrollFeedbackBannerIntoView();
      setPrimaryAction('check_soft');
      inp.focus({ preventScroll: true });
      return;
    }
    session.dontKnowSkipArmed = false;
    const corr = classifyAnswer(trimmed, entry, ex, { strictDiacritics: userStore.settings.strictDiacritics });
    const foldedOk = !userStore.settings.strictDiacritics &&
      [ex.answer, ...(ex.accept || [])].some(t => foldMarks(trimmed) === foldMarks(t));
    if (corr.accepted || foldedOk) {
      mountExample(el('sc-pt-box'), ex, { revealed: true, gapState: '', lemmaId: entry.id });
      renderFeedbackBanner({
        tone: 'soft_ok',
        statusText: '✓ Corrected',
        wordText: ex.answer,
        lemmaId: entry.id,
        showIWasWrong: false,
        showNotes: true,
        ex,
        entry
      });
      scrollFeedbackBannerIntoView();
      session.needsCorrection = false;
      session.revealed = true;
      syncAudioControlsVisibility();
      setPrimaryAction('next_good');
      inp.value = '';
      inp.placeholder = 'Type missing PT-BR word...';
      if (userStore.settings.autoPlay) speakClozeItem(ex, true);
      inp.focus({ preventScroll: true });
    } else {
      renderCorrectionProgress(el('sc-pt-box'), ex, '');
      renderFeedbackBanner({
        tone: 'error',
        statusText: 'Answer:',
        wordText: ex.answer,
        lemmaId: entry.id,
        instructionText: 'Type it below to continue.',
        showIWasWrong: false,
        showNotes: true,
        ex,
        entry
      });
      scrollFeedbackBannerIntoView();
      setPrimaryAction('check_soft');
      inp.focus({ preventScroll: true });
    }
    return;
  }

  // Empty input -> Don't know (Again + Mandatory Re-Type with enabled skip-to-Next option)
  if (!trimmed) {
    await enterMandatoryRetype(entry, ex, null, true);
    return;
  }

  const ansChars = Array.from(String(ex.answer || ''));
  const revealedPrefix = ansChars.slice(0, session.revealedPrefixLen).join('');
  const res = classifyAnswerWithPrefix(trimmed, entry, ex, revealedPrefix);
  const wasNew = !userStore.cards.has(cardKey);
  const reactionMs = session.firstKeystrokeMs !== null ? session.firstKeystrokeMs : 9999;

  // Plausible wrong -> free retry with exact quoted word, does NOT increment attemptCount or reveal letter
  if (res.kind === 'plausible_wrong') {
    maybeRecordConfusableMixup(entry, trimmed);
    const pwMsg = res.altValid
      ? (res.message || 'Also correct in context! Try the target word.')
      : `"${trimmed}" makes sense, but we need another word here.`;
    renderFeedbackBanner({ tone: 'info', instructionText: pwMsg, showNotes: false });
    scrollFeedbackBannerIntoView();
    mountExample(el('sc-pt-box'), ex, { revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, onGapTap: focusAnswerInput });
    setPrimaryAction('dont_know');
    inp.focus({ preventScroll: true });
    return;
  }

  // Wrong form of the same lemma -> 1 friendly form retry without silently failing
  if (res.kind === 'wrong_form' && !session.hadWrongFormRetry) {
    session.hadWrongFormRetry = true;
    renderFeedbackBanner({ tone: 'warn', instructionText: 'Right word - check the form/person and try again.', showNotes: false });
    scrollFeedbackBannerIntoView();
    mountExample(el('sc-pt-box'), ex, { revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, gapState: 'state-amber', onGapTap: focusAnswerInput });
    setPrimaryAction('dont_know');
    inp.focus({ preventScroll: true });
    return;
  }

  // Strict diacritics ON -> 1 free retry, then counts as wrong attempt
  if (res.kind === 'diacritic_strict_miss' && !session.hadStrictAccentRetry) {
    session.hadStrictAccentRetry = true;
    if (session.mode === 'study') {
      recordTypoEvent({
        lemmaId: entry.id,
        target: res.expected || ex.answer,
        exId: ex.exId,
        userInput: trimmed,
        diacriticOnly: isDiacriticOnlyDiff(trimmed, res.expected || ex.answer)
      });
    }
    renderFeedbackBanner({ tone: 'warn', instructionText: 'Check the accent/diacritic and try again.', showNotes: false });
    scrollFeedbackBannerIntoView();
    mountExample(el('sc-pt-box'), ex, { revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, onGapTap: focusAnswerInput });
    setPrimaryAction('dont_know');
    inp.focus({ preventScroll: true });
    return;
  }

  // Accepted answer (exact, diacritic-folded when strict OFF, or Damerau-Levenshtein typo)
  if (res.accepted) {
    const isAccFoldOnly = (res.kind === 'diacritic_accepted' || res.kind === 'diacritic_collision_accepted') && !userStore.settings.strictDiacritics;
    const isTypo = res.kind === 'typo';
    const isHard = session.usedHint || session.attemptCount > 0 || isTypo;
    const grade = isHard ? 2 : 3;
    if (session.mode === 'study' || session.mode === 'check_known') {
      await commitReview(captureSnapshot(), grade);
    }

    const canOverride = session.mode === 'study';
    const canFastKnown = canOverride && grade === 3 && wasNew && reactionMs < getFastAnswerThresholdMs(ex.answer, ex.pt);
    if (canOverride && (isTypo || res.kind === 'diacritic_accepted' || res.kind === 'diacritic_collision_accepted')) {
      const targetWord = res.matched || ex.answer;
      recordTypoEvent({
        lemmaId: entry.id,
        target: targetWord,
        exId: ex.exId,
        userInput: trimmed,
        diacriticOnly: isDiacriticOnlyDiff(trimmed, targetWord)
      });
    }

    const targetVarNote = normNFC(res.matched) !== normNFC(ex.answer) ? `Target form: ${ex.answer}` : null;
    const typedForHl = res.typed || trimmed;
    renderClozeSentence(el('sc-pt-box'), ex, { revealed: true, gapState: 'cloze-pop', lemmaId: entry.id, userTyped: typedForHl });
    playCorrectChime();
    if (res.kind === 'typo') {
      renderFeedbackBanner({
        tone: 'soft_ok', statusText: '✓ Accepted', wordText: res.matched, userTyped: typedForHl, lemmaId: entry.id,
        showIWasWrong: canOverride, showNotes: true,
        targetNote: targetVarNote, ex, entry
      });
    } else if (isAccFoldOnly && !isHard) {
      renderFeedbackBanner({
        tone: 'ok', statusText: '✓ Correct', wordText: res.matched, userTyped: typedForHl, lemmaId: entry.id,
        showIWasWrong: canOverride, showNotes: true, targetNote: targetVarNote, ex, entry
      });
    } else if (isHard) {
      renderFeedbackBanner({
        tone: 'soft_ok', statusText: '✓ Good', wordText: res.matched, userTyped: typedForHl, lemmaId: entry.id,
        showIWasWrong: canOverride, showNotes: true, targetNote: targetVarNote, ex, entry
      });
    } else {
      renderFeedbackBanner({
        tone: 'ok', statusText: '✓ Correct', wordText: res.matched, userTyped: typedForHl, lemmaId: entry.id,
        showIWasWrong: canOverride, showNotes: true, targetNote: targetVarNote, ex, entry
      });
    }

    if (canFastKnown) {
      el('btn-known').classList.add('already-know-beckon');
    } else {
      el('btn-known').classList.remove('already-know-beckon');
    }

    revealPostAnswerNotes(entry, ex);
    scrollFeedbackBannerIntoView();
    session.revealed = true;
    syncAudioControlsVisibility();
    setPrimaryAction(grade === 3 ? 'next_good' : 'next_hard');
    if (userStore.settings.autoPlay) speakClozeItem(ex, true);
    updateSessionHeader();
    inp.focus({ preventScroll: true });
    return;
  }

  // Wrong answer -> check confusable mix-up, then multi-attempt hint or Mandatory Re-Type
  maybeRecordConfusableMixup(entry, trimmed);
  session.attemptCount += 1;
  const isUnlimited = userStore.settings.maxAttempts === 'unlimited';
  if (isUnlimited || session.attemptCount < 3) {
    session.usedHint = true;
    session.revealedPrefixLen = advanceRevealedPrefix(ex.answer, session.revealedPrefixLen);
    const hintMsg = isUnlimited
      ? 'Try again - next letter revealed'
      : `Try again (attempt ${session.attemptCount}/3) - next letter revealed`;
    renderFeedbackBanner({ tone: 'warn', instructionText: hintMsg, showNotes: false });
    scrollFeedbackBannerIntoView();
    mountExample(el('sc-pt-box'), ex, {
      revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, gapState: 'state-amber', onGapTap: focusAnswerInput
    });
    setPrimaryAction('dont_know');
    inp.focus({ preventScroll: true });
    return;
  }

  // 3rd wrong attempt -> Again + Mandatory Re-Type
  await enterMandatoryRetype(entry, ex);
}

export function handleHint() {
  if (!session.activeItem || session.revealed || session.needsCorrection) return;
  const { ex } = session.activeItem;
  session.usedHint = true;
  session.revealedPrefixLen = advanceRevealedPrefix(ex.answer, session.revealedPrefixLen);
  const inp = el('answer-input');
  inp.value = '';
  setPrimaryAction('dont_know');
  mountExample(el('sc-pt-box'), ex, {
    revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, gapState: 'state-amber', onGapTap: focusAnswerInput
  });
  inp.focus({ preventScroll: true });
}

export async function seedCardKnown(cardKey, entry, exId = null, recordUndo = false) {
  if (recordUndo && session.mode === 'study' && session.activeItem) {
    const snap = captureSnapshot();
    session.undoStack.push(snap);
    if (session.undoStack.length > 20) session.undoStack.shift();
    updateUndoButtons();
  }
  const now = Date.now();
  const rec = userStore.cards.has(cardKey) ? deepClone(userStore.cards.get(cardKey)) : createBlankCardRecord(cardKey);
  rec.assumed = false; rec.suspended = false; rec.status = 'known';
  rec.stability = 21; rec.difficulty = 4.5; rec.interval = 21;
  rec.due = now + 21 * 86400000; rec.last_review = now; rec.updatedAt = now;
  if (exId) rec.lastExampleId = exId;
  if (!rec.firstIntroducedAt) rec.firstIntroducedAt = now;
  userStore.cards.set(cardKey, rec);
  await idbPut('cards', rec);
  if (!userStore.today.reviewedLemmasToday.includes(entry.id)) {
    userStore.today.reviewedLemmasToday.push(entry.id);
    await saveToday();
  }
  if (recordUndo && session.mode === 'study' && exId) {
    const curEx = session.activeItem && session.activeItem.ex && session.activeItem.ex.exId === exId ? session.activeItem.ex : null;
    const logKey = makeSessionLogKey(entry.id, curEx);
    const prevLog = session.sessionLog.get(logKey);
    if (!prevLog) {
      session.sessionLog.set(logKey, { lemmaId: entry.id, exId, answer: curEx ? curEx.answer : '', grade: 3, wasNew: !userStore.cards.has(cardKey), tricky: false, skippedKnown: true });
      session.reviewedCount += 1;
      session.cleanCount += 1;
      if (curEx) {
        if (!Array.isArray(session.mainHistory)) session.mainHistory = [];
        if (!(session.seenMainExIds instanceof Set)) session.seenMainExIds = new Set(session.seenMainExIds || []);
        session.seenMainExIds.add(curEx.exId);
        session.mainHistory.push({
          exId: curEx.exId, lemmaId: entry.id, pt: curEx.pt || '', en: curEx.en || '',
          answer: curEx.answer || '', slot: curEx.slot || 'base', grade: 3, outcome: 'known', wasNew: false, ts: now
        });
      }
    }
  }
}

export async function handleAlreadyKnowClick() {
  if (!session.activeItem || session.mode !== 'study' || Date.now() < session.transitionLockUntil) return;
  const { cardKey, entry, ex } = session.activeItem;
  el('btn-known').classList.remove('already-know-beckon');
  const alreadyCommitted = Boolean(session.revealed);
  const now = Date.now();

  if (!isMultiFormEntry(entry)) {
    await seedCardKnown(cardKey, entry, ex.exId, !alreadyCommitted);
    if (alreadyCommitted) {
      const existingLog = session.sessionLog.get(makeSessionLogKey(entry.id, ex));
      if (existingLog) { existingLog.skippedKnown = true; existingLog.tricky = false; }
    }
    showToast(`Marked "${ex.answer}" as Known`, performUndo);
    await advanceStudy();
    return;
  }

  if (!alreadyCommitted) {
    const snap = captureSnapshot();
    session.undoStack.push(snap);
    if (session.undoStack.length > 20) session.undoStack.shift();
    updateUndoButtons();
  }
  const baseRec = userStore.cards.has(entry.id) ? deepClone(userStore.cards.get(entry.id)) : createBlankCardRecord(entry.id);
  if (!baseRec.knownCells) baseRec.knownCells = {};
  if (!baseRec.knownAnswers) baseRec.knownAnswers = {};
  const formKey = getExampleFormKey(entry, ex);
  const ansNorm = normNFC(ex.answer);
  if (formKey) baseRec.knownCells[formKey] = now;
  if (ansNorm) baseRec.knownAnswers[ansNorm] = now;
  baseRec.updatedAt = now;
  baseRec.stateUpdatedAt = now;

  const { cellClass: subCell } = parseCardKey(cardKey);
  if (subCell) {
    const subRec = userStore.cards.has(cardKey) ? deepClone(userStore.cards.get(cardKey)) : createBlankCardRecord(cardKey);
    subRec.status = 'known'; subRec.assumed = false; subRec.suspended = false;
    subRec.stability = 21; subRec.interval = 21; subRec.due = now + 21 * 86400000;
    subRec.updatedAt = now; subRec.stateUpdatedAt = now;
    userStore.cards.set(cardKey, subRec);
    await idbPut('cards', subRec);
  }

  const cc = getCellClass(ex.cellClass || ex.slot || 'base');
  if (!userStore.cellStats[entry.id]) userStore.cellStats[entry.id] = {};
  const prevSt = userStore.cellStats[entry.id][cc] || { ok: 0, fail: 0 };
  userStore.cellStats[entry.id][cc] = { ok: Math.max(3, prevSt.ok || 0), fail: prevSt.fail || 0 };
  await saveCellStats();

  const allLoadedEx = await getExamplesForEntry(entry);
  const hasUnknownLoadedEx = allLoadedEx.some(e => !isExampleFormKnown(baseRec, entry, e));
  const hasUnknownEntryForm = (entry.forms || []).some(f => !baseRec.knownAnswers[normNFC(f)]);
  const allFormsKnown = entry.pos !== 'VERB' && !hasUnknownLoadedEx && !hasUnknownEntryForm;

  if (allFormsKnown) {
    baseRec.status = 'known'; baseRec.assumed = false; baseRec.suspended = false;
    baseRec.stability = 21; baseRec.interval = 21; baseRec.due = now + 21 * 86400000;
  } else if (alreadyCommitted && session.lastPreSnapshot && !session.lastPreSnapshot.priorRec) {
    baseRec.status = 'to_learn';
    baseRec.due = 0;
    baseRec.step = 0;
  } else if (!baseRec.status || baseRec.status === 'new') {
    baseRec.status = 'to_learn';
  }
  userStore.cards.set(entry.id, baseRec);
  await idbPut('cards', baseRec);

  const formLogKey = makeSessionLogKey(entry.id, ex);
  if (!alreadyCommitted) {
    if (!session.sessionLog.has(formLogKey)) {
      session.sessionLog.set(formLogKey, { lemmaId: entry.id, exId: ex.exId, answer: ex.answer, grade: 3, wasNew: !baseRec.reps, tricky: false, skippedKnown: true });
      session.reviewedCount += 1;
      session.cleanCount += 1;
      if (!Array.isArray(session.mainHistory)) session.mainHistory = [];
      if (!(session.seenMainExIds instanceof Set)) session.seenMainExIds = new Set(session.seenMainExIds || []);
      session.seenMainExIds.add(ex.exId);
      session.mainHistory.push({
        exId: ex.exId, lemmaId: entry.id, pt: ex.pt || '', en: ex.en || '',
        answer: ex.answer || '', slot: ex.slot || 'base', grade: 3, outcome: 'known', wasNew: !baseRec.reps, ts: now
      });
    }
  } else {
    const existingLog = session.sessionLog.get(formLogKey);
    if (existingLog) { existingLog.skippedKnown = true; existingLog.tricky = false; }
    const mh = Array.isArray(session.mainHistory) ? session.mainHistory.find(h => h && h.exId === ex.exId) : null;
    if (mh) mh.outcome = 'known';
  }

  showToast(
    allFormsKnown
      ? `Marked "${ex.answer}" as Known`
      : `Marked "${ex.answer}" as Known - other forms of "${entry.lemma}" stay in practice`,
    performUndo
  );
  await advanceStudy();
}

export function getSeenMainExIdSet() {
  const seen = new Set();
  if (session.seenMainExIds instanceof Set) {
    for (const id of session.seenMainExIds) if (id) seen.add(id);
  } else if (Array.isArray(session.seenMainExIds)) {
    for (const id of session.seenMainExIds) if (id) seen.add(id);
  }
  if (Array.isArray(session.mainHistory)) {
    for (const h of session.mainHistory) if (h && h.exId) seen.add(h.exId);
  }
  return seen;
}

export async function advanceStudy() {
  session.requeueList.forEach(r => { r.waitSteps -= 1; });
  const next = await pickNextStudyItem();
  if (next) { mountStudyItem(next); return; }

  if (session.mode === 'study') {
    await clearPausedSession();
    if (userStore.settings.enableFixRound !== false) {
      const seenExIds = getSeenMainExIdSet();
      const enforceSeenGuard = seenExIds.size > 0;
      const toFix = Array.from(new Set([...session.missedIds, ...session.hardIds]));
      const toFixSet = new Set(toFix);
      const exactPool = Array.isArray(session.failedExactItems)
        ? session.failedExactItems.filter(it => it && it.entry && it.ex && toFixSet.has(it.entry.id) && (!enforceSeenGuard || seenExIds.has(it.ex.exId)))
        : [];
      if (exactPool.length > 0 || toFix.length > 0) {
        const q = [];
        const coveredExIds = new Set();
        const coveredLemmaIds = new Set();
        for (const it of exactPool) {
          if (coveredExIds.has(it.ex.exId)) continue;
          coveredExIds.add(it.ex.exId);
          coveredLemmaIds.add(it.entry.id);
          q.push({ cardKey: it.cardKey, entry: it.entry, ex: it.ex, cellClass: it.cellClass || null });
        }
        for (const lid of toFix) {
          if (coveredLemmaIds.has(lid)) continue;
          const entry = contentStore.entriesById.get(lid);
          if (!entry) continue;
          // Prefer exact recorded failed exId from mainHistory/sessionLog; NEVER invent unseen sentences when main session tracked seenExIds
          let ex = null;
          const histMatch = Array.isArray(session.mainHistory)
            ? [...session.mainHistory].reverse().find(h => h && h.lemmaId === lid && h.grade < 3 && h.exId && seenExIds.has(h.exId))
            : null;
          const logMatch = histMatch || Array.from(session.sessionLog.values()).find(lg => lg && lg.lemmaId === lid && (lg.tricky || lg.grade < 3) && lg.exId && (!enforceSeenGuard || seenExIds.has(lg.exId)));
          if (logMatch) {
            const exs = await getExamplesForEntry(entry);
            ex = exs.find(e => e.exId === logMatch.exId) || null;
          } else if (!enforceSeenGuard) {
            ex = await pickBestExample(entry, null, lid, false);
          }
          if (ex) {
            coveredExIds.add(ex.exId);
            coveredLemmaIds.add(lid);
            q.push({ cardKey: lid, entry, ex, cellClass: null });
          }
        }
        if (q.length > 0) {
          session.mode = 'round1';
          session.round1Items = [...q];
          session.round1Idx = 0;
          session.round1Total = q.length;
          session.round1Queue = q.slice(1);
          showToast(`Round 1: Fix ${q.length} tricky word${q.length === 1 ? '' : 's'}`);
          mountStudyItem(session.round1Items[0]);
          return;
        }
      }
    }
    await launchRound2OrSummary();
    return;
  }

  if (session.mode === 'round1') {
    await launchRound2OrSummary();
    return;
  }

  appActions.navigateTo('finale');
  await showDoneSummary();
}


/* ==========================================================================
   12. ROUND 2 FINALE: WORDS-ONLY BLIND AUDIO, FULL-SESSION RECALL TILES & RICH SUMMARY
   ========================================================================== */

export async function resolveAllSessionItems() {
  const items = [];
  const seenExIds = getSeenMainExIdSet();
  const seenReturnedExIds = new Set();
  for (const [key, log] of session.sessionLog.entries()) {
    if (!log || log.skippedKnown || !log.exId) continue;
    if (seenExIds.size > 0 && !seenExIds.has(log.exId)) continue;
    if (seenReturnedExIds.has(log.exId)) continue;
    const lid = log.lemmaId || String(key).split('::')[0];
    const entry = contentStore.entriesById.get(lid);
    if (!entry) continue;
    const exs = await getExamplesForEntry(entry);
    const ex = exs.find(e => e.exId === log.exId) || null;
    if (ex) {
      seenReturnedExIds.add(ex.exId);
      items.push({ entry, ex });
    }
  }
  return items;
}

export function getActiveFinaleModes() {
  if (Array.isArray(userStore.settings.finaleModes)) return userStore.settings.finaleModes;
  return ['blind', 'recall'];
}

export function setFinaleRecallLayout(active) {
  const pane = el('finale-scroll-pane');
  if (!pane) return;
  if (active) {
    pane.classList.remove('scroll-pane');
    pane.classList.add('finale-recall-pane');
  } else {
    pane.classList.remove('finale-recall-pane');
    pane.classList.add('scroll-pane');
  }
}

export async function launchRound2OrSummary() {
  const modes = getActiveFinaleModes();
  const items = await resolveAllSessionItems();
  session.isStandaloneBlind = false;
  appActions.navigateTo('finale');

  const wantBlind = modes.includes('blind');
  const wantRecall = modes.includes('recall');
  if (items.length === 0 || (!wantBlind && !wantRecall)) { await showDoneSummary(); return; }
  if (wantBlind) { startBlindAudio(items, wantRecall); return; }
  startRecallTiles(items);
}

export function startBlindAudio(items, chainToRecall = false) {
  const ready = [];
  for (const it of items) {
    const dist = isBlindAudioEligible(it.entry, it.ex);
    if (dist) ready.push({ ...it, distractors: dist });
  }
  session.blindQueue = ready.slice(0, 8);
  session.blindIdx = 0;
  session.blindCorrect = 0;
  session.blindHistory = [];
  session.blindRetryQueue = [];
  session.blindInRetry = false;
  session.blindAudioPenalizedLemmas = new Set();
  session.blindChainItems = chainToRecall ? items : [];

  if (session.blindQueue.length === 0) {
    if (chainToRecall && items.length > 0) startRecallTiles(items);
    else showDoneSummary();
    return;
  }

  setFinaleRecallLayout(false);
  el('finale-title').textContent = session.isStandaloneBlind ? 'Standalone Blind Audio' : 'Blind Audio';
  el('finale-sub').textContent = 'Word ear check';
  el('finale-sub').classList.remove('hidden');
  el('btn-finale-skip').classList.remove('hidden');
  if (el('btn-recall-skip')) el('btn-recall-skip').classList.add('hidden');
  if (el('btn-summary-history')) el('btn-summary-history').classList.add('hidden');
  el('panel-blind').classList.remove('hidden');
  el('panel-recall').classList.add('hidden');
  el('panel-done').classList.add('hidden');
  renderBlindStep();
}

export function applyBlindAudioMissSrs(item) {
  if (!item || !item.entry) return;
  const lemmaId = item.entry.id;
  const ex = item.ex;
  if (!session.blindAudioPenalizedLemmas) session.blindAudioPenalizedLemmas = new Set();
  if (session.blindAudioPenalizedLemmas.has(lemmaId)) return;
  session.blindAudioPenalizedLemmas.add(lemmaId);

  // Gentle SRS adjustment ONLY for existing cards (never create brand-new cards, never touch today counters)
  if (userStore.cards.has(lemmaId)) {
    const rec = deepClone(userStore.cards.get(lemmaId));
    const now = Date.now();
    if (rec.status === 'learning') {
      rec.step = 0;
      rec.due = now + 10 * 60 * 1000;
    } else if (rec.status === 'review' || rec.status === 'known') {
      rec.status = 'review';
      rec.assumed = false;
      rec.stability = Math.max(1, (rec.stability || 3) * 0.55);
      rec.difficulty = Math.min(10, (rec.difficulty || 5) + 0.4);
      rec.interval = 1;
      const nextRollover = getLogicalDayStartMs(now) + 86400000;
      rec.due = Math.min(nextRollover, now + 86400000);
    }
    rec.stateUpdatedAt = now;
    rec.updatedAt = now;
    userStore.cards.set(lemmaId, rec);
    idbPut('cards', rec);
  }

  if (ex) {
    const lk = makeSessionLogKey(lemmaId, ex);
    const log = session.sessionLog.get(lk);
    if (log) log.tricky = true;
  }
}

// Blind Audio speaks WORDS ONLY (ex.answer on auto-play/Play/0.75x, opt.text on option tap; NEVER auto-plays sentence!)
export function renderBlindStep() {
  stopTTS();
  const item = session.blindQueue[session.blindIdx];
  if (!item) {
    if (Array.isArray(session.blindRetryQueue) && session.blindRetryQueue.length > 0) {
      session.blindQueue = session.blindRetryQueue.slice();
      session.blindRetryQueue = [];
      session.blindIdx = 0;
      session.blindHistory = [];
      session.blindInRetry = true;
      renderBlindStep();
      return;
    }
    if (session.blindChainItems && session.blindChainItems.length > 0) startRecallTiles(session.blindChainItems);
    else if (session.isStandaloneBlind) { showToast(`Blind Audio done: ${session.blindCorrect}/${session.blindQueue.length}`); appActions.navigateTo('home'); }
    else showDoneSummary();
    return;
  }

  session.blindAnswered = false;
  session.blindWordPlayCount = 0;
  session.blindSentPlayCount = 0;
  renderProgressiveAudioBtn(el('btn-blind-play'), '', 0, 26);
  renderProgressiveAudioBtn(el('btn-blind-sent-play'), 'Sentence', 0, 15);
  pickVoiceForNewCard();
  const { ex, distractors } = item;

  el('blind-badge').textContent = session.blindInRetry
    ? `Retry · ${session.blindIdx + 1}/${session.blindQueue.length}`
    : `Blind Audio · ${session.blindIdx + 1}/${session.blindQueue.length}`;
  if (el('blind-phase-pill')) el('blind-phase-pill').classList.toggle('hidden', !session.blindInRetry);
  el('blind-reveal-box').classList.add('hidden');
  el('btn-blind-next').disabled = true;

  const priorState = Array.isArray(session.blindHistory) ? session.blindHistory[session.blindIdx] : null;
  const options = (priorState && Array.isArray(priorState.options)) ? priorState.options : [
    { text: ex.answer, correct: true },
    ...distractors.map(d => ({ text: d, correct: false }))
  ].sort(() => Math.random() - 0.5);

  const grid = el('blind-options');
  grid.textContent = '';
  const applyRevealedState = chosenIdx => {
    Array.from(grid.children).forEach((b, i) => {
      b.disabled = true;
      if (options[i].correct) b.classList.add('opt-correct');
      else if (i === chosenIdx) b.classList.add('opt-wrong');
      else b.classList.add('opt-dim');
    });
    renderClozeSentence(el('blind-pt-full'), ex, { revealed: true, lemmaId: item.entry ? item.entry.id : null });
    renderHighlightedEnglish(el('blind-en-full'), ex.en, ex.clean_hint_en || ex.hint_en, item.entry ? item.entry.en_gloss : '', ex.answer);
    const bNoteBox = el('blind-note-box');
    if (bNoteBox) {
      bNoteBox.textContent = '';
      const noteStr = getCombinedNoteText(item.entry, ex);
      if (noteStr) {
        renderRichGrammarNote(bNoteBox, noteStr, item.entry ? item.entry.id : null);
        bNoteBox.classList.remove('hidden');
      } else {
        bNoteBox.classList.add('hidden');
      }
    }
    el('blind-reveal-box').classList.remove('hidden');
    el('btn-blind-next').disabled = false;
  };

  options.forEach((opt, optIdx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'blind-opt';
    btn.textContent = opt.text;
    btn.addEventListener('click', () => {
      // Speak ONLY the tapped option word (never full sentence)
      speakPT(opt.text, { rate: 0.96, keepVoice: false });
      if (session.blindAnswered) return;
      session.blindAnswered = true;
      if (opt.correct) {
        session.blindCorrect += 1;
      } else {
        if (!Array.isArray(session.blindRetryQueue)) session.blindRetryQueue = [];
        if (!session.blindRetryQueue.some(r => r.ex && ex && r.ex.exId === ex.exId)) {
          session.blindRetryQueue.push({ entry: item.entry, ex: item.ex, distractors: item.distractors });
        }
        applyBlindAudioMissSrs(item);
      }
      if (!Array.isArray(session.blindHistory)) session.blindHistory = [];
      session.blindHistory[session.blindIdx] = { options, chosenIdx: optIdx, answered: true };
      applyRevealedState(optIdx);
    });
    grid.appendChild(btn);
  });

  if (priorState && priorState.answered) {
    session.blindAnswered = true;
    applyRevealedState(priorState.chosenIdx);
  } else {
    // Auto-play target WORD only
    speakPT(ex.answer, { rate: 0.96, keepVoice: true });
  }
}

// Full-Session Recall Tiles: ALL unique words from today's session simultaneously (NO 8/10 cap!)
export function startRecallTiles(items) {
  const seen = new Set();
  const tiles = [];
  for (const item of [...items].sort(() => Math.random() - 0.5)) {
    const normAns = normNFC(item.ex.answer);
    const slotKey = String(item.ex.slot || item.ex.inflection || '');
    const dedupeKey = `${normAns}::${slotKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const tag = formatRecallTag(item.entry, item.ex);
    tiles.push({
      lemmaId: item.entry.id,
      answer: item.ex.answer,
      normAns,
      foldedAns: foldMarks(item.ex.answer),
      gloss: stripRedundantGenderNumberHint(item.ex.clean_hint_en || item.entry.en_gloss, Boolean(tag)),
      slot: item.ex.slot || 'base',
      pos: item.entry.pos || '',
      tag,
      revealedLetters: 0,
      solved: false
    });
  }

  if (tiles.length === 0) { showDoneSummary(); return; }
  session.recallTiles = tiles;
  clearTimeout(session.recallTimer);
  clearTimeout(session.recallSweepTimer);
  clearTimeout(session.recallReturnTimer);
  session.recallTimer = null;
  session.recallSweepTimer = null;
  session.recallReturnTimer = null;
  session.lastRecallScrollTargetIdx = null;

  setFinaleRecallLayout(true);
  syncDiacriticsBarVisibility();
  el('finale-title').textContent = `Recall Tiles · 0/${tiles.length}`;
  el('finale-sub').textContent = '';
  el('finale-sub').classList.add('hidden');
  el('btn-finale-skip').classList.add('hidden');
  if (el('btn-recall-skip')) el('btn-recall-skip').classList.remove('hidden');
  if (el('btn-summary-history')) el('btn-summary-history').classList.add('hidden');
  el('panel-blind').classList.add('hidden');
  el('panel-done').classList.add('hidden');
  el('panel-recall').classList.remove('hidden');

  el('recall-complete-banner').classList.add('hidden');
  const subBtn = el('btn-recall-submit');
  if (subBtn) subBtn.classList.remove('hidden');
  const doneBtn = el('btn-recall-done');
  doneBtn.className = 'btn btn-emerald hidden';
  doneBtn.textContent = 'Continue to Summary';
  const inp = el('recall-input');
  inp.classList.remove('hidden');
  inp.value = '';
  syncDiacriticsBarVisibility();
  renderRecallGrid();
  const rScroller = el('recall-scroll-area');
  if (rScroller) rScroller.scrollTop = 0;
  const fPane = el('finale-scroll-pane');
  if (fPane) fPane.scrollTop = 0;
  inp.focus({ preventScroll: true });
}

export function mountRecallTileMask(maskEl, answer, revealedCount, solved, lemmaId = null, userTyped = '', sweeping = false) {
  maskEl.textContent = '';
  if (solved) {
    maskEl.className = 'recall-mask';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recall-tile-pt';
    const hasMismatch = Boolean(userTyped && normNFC(userTyped.trim()) !== normNFC(answer));
    if (sweeping) {
      let charNodes = [];
      if (hasMismatch) {
        const tmp = document.createElement('span');
        renderCorrectedWordWithHighlight(tmp, answer, userTyped);
        const childList = (tmp.childNodes && tmp.childNodes.length) ? tmp.childNodes : (tmp.children || []);
        Array.from(childList).forEach(node => {
          const isMark = Boolean(node && (node.nodeType === 1 || (node.tagName && String(node.tagName).toLowerCase() === 'mark') || (node.classList && node.className)));
          const clsExtra = isMark ? String(node.className || 'char-fix-hl') : '';
          for (const ch of Array.from(node.textContent || '')) {
            charNodes.push({ ch, clsExtra });
          }
        });
      } else {
        charNodes = Array.from(String(answer || '')).map(ch => ({ ch, clsExtra: '' }));
      }
      const stepMs = Math.min(75, Math.max(35, Math.round(520 / Math.max(1, charNodes.length))));
      charNodes.forEach(({ ch, clsExtra }, idx) => {
        const sp = document.createElement('span');
        sp.className = clsExtra ? `recall-sweep-char ${clsExtra}` : 'recall-sweep-char';
        sp.style.animationDelay = `${idx * stepMs}ms`;
        sp.textContent = ch === ' ' ? '\u00A0' : ch;
        btn.appendChild(sp);
      });
    } else if (hasMismatch) {
      renderCorrectedWordWithHighlight(btn, answer, userTyped);
    } else {
      btn.textContent = answer;
    }
    if (lemmaId) {
      btn.setAttribute('data-open-word-detail', lemmaId);
      btn.addEventListener('pointerdown', e => e.preventDefault());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        appActions.openWordDetail(lemmaId);
      });
    }
    maskEl.appendChild(btn);
    return;
  }
  maskEl.className = 'recall-mask';
  const chars = Array.from(String(answer || ''));
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      const gap = document.createElement('span');
      gap.className = 'recall-mask-gap';
      maskEl.appendChild(gap);
    } else if (ch === '-' || ch === "'") {
      const p = document.createElement('span');
      p.style.margin = '0 2px';
      p.textContent = ch;
      maskEl.appendChild(p);
    } else {
      const slot = document.createElement('span');
      slot.style.marginRight = '3px';
      slot.textContent = i < revealedCount ? ch : '_';
      maskEl.appendChild(slot);
    }
  });
}

export function renderRecallGrid() {
  const solvedCount = session.recallTiles.filter(t => t.solved).length;
  el('recall-progress-badge').textContent = `${solvedCount} / ${session.recallTiles.length} recalled`;
  if (el('panel-recall') && !el('panel-recall').classList.contains('hidden')) {
    el('finale-title').textContent = `Recall Tiles · ${solvedCount}/${session.recallTiles.length}`;
  }
  const grid = el('recall-grid');
  grid.textContent = '';

  session.recallTiles.forEach((tile, tileIdx) => {
    const box = document.createElement('div');
    box.className = `recall-tile ${tile.solved ? 'solved' : ''} ${tile.sweeping ? 'recall-tile-sweeping' : ''}`.trim();
    box.dataset.recallIdx = String(tileIdx);
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');

    const top = document.createElement('div');
    top.className = 'recall-tile-top';
    const gloss = document.createElement('span');
    gloss.className = 'recall-gloss recall-tile-en';
    gloss.textContent = tile.gloss;

    const rightControls = document.createElement('div');
    rightControls.style.display = 'inline-flex';
    rightControls.style.alignItems = 'center';
    rightControls.style.gap = '4px';
    if (tile.solved) {
      const chk = document.createElement('span');
      chk.className = 'recall-check-icon';
      chk.textContent = '✓';
      rightControls.appendChild(chk);
    }

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'btn btn-ghost btn-xs';
    speakBtn.style.minHeight = '30px';
    speakBtn.setAttribute('aria-label', 'Hear word');
    speakBtn.appendChild(makeSpeakerIcon(14));
    speakBtn.addEventListener('pointerdown', e => e.preventDefault());
    speakBtn.addEventListener('click', e => {
      e.stopPropagation();
      speakPT(tile.answer, { rate: 0.96, keepVoice: false });
      scrollRecallTileIntoView(box, 10);
      if (!session.recallTiles.every(t => t.solved)) el('recall-input').focus({ preventScroll: true });
    });

    rightControls.appendChild(speakBtn);
    top.append(gloss, rightControls);
    box.appendChild(top);
    if (tile.tag && tile.tag.label) {
      const badgeRow = document.createElement('div');
      badgeRow.style.display = 'flex';
      badgeRow.style.flexWrap = 'wrap';
      badgeRow.style.gap = '4px';
      if (tile.tag.gender || tile.tag.number) {
        if (tile.tag.gender) {
          const gb = document.createElement('span');
          gb.className = 'recall-slot-badge pill-icon-wrap';
          gb.dataset.tint = tile.tag.gender === 'f' ? 'pill-fem' : (tile.tag.gender === 'm' ? 'pill-masc' : 'pill-mf');
          if (tile.tag.gender === 'm' || tile.tag.gender === 'f') {
            setPillWithIcon(gb, tile.tag.gender, tile.tag.gender === 'm' ? 'Masc.' : 'Fem.');
          } else {
            gb.textContent = 'Masc. / Fem.';
          }
          badgeRow.appendChild(gb);
        }
        if (tile.tag.number) {
          const nb = document.createElement('span');
          nb.className = 'recall-slot-badge pill-icon-wrap';
          nb.dataset.tint = tile.tag.number === 'sg' ? 'pill-sg' : 'pill-pl';
          setPillWithIcon(nb, tile.tag.number, tile.tag.number === 'sg' ? 'Singular' : 'Plural');
          badgeRow.appendChild(nb);
        }
      } else {
        const sb = document.createElement('span');
        sb.className = 'recall-slot-badge';
        if (tile.tag.tint) sb.dataset.tint = tile.tag.tint;
        sb.textContent = tile.tag.label;
        badgeRow.appendChild(sb);
      }
      box.appendChild(badgeRow);
    }
    const mask = document.createElement('div');
    mountRecallTileMask(mask, tile.answer, tile.revealedLetters, tile.solved, tile.lemmaId, tile.userTyped || '', Boolean(tile.sweeping));
    box.appendChild(mask);
    box.addEventListener('pointerdown', e => e.preventDefault());
    box.addEventListener('click', () => {
      if (tile.solved) {
        speakPT(tile.answer, { rate: 0.96, keepVoice: false });
        scrollRecallTileIntoView(box, 10);
        return;
      }
      tile.revealedLetters = Math.min(tile.answer.length, tile.revealedLetters + 1);
      renderRecallGrid();
      el('recall-input').focus({ preventScroll: true });
    });
    grid.appendChild(box);
  });
}

export function scrollRecallTileIntoView(tileEl, paddingTop = 10) {
  const scroller = el('recall-scroll-area');
  if (!scroller || !tileEl) return;
  if (typeof scroller.getBoundingClientRect === 'function' && typeof tileEl.getBoundingClientRect === 'function') {
    const sRect = scroller.getBoundingClientRect();
    const tRect = tileEl.getBoundingClientRect();
    if (tRect.top < sRect.top + paddingTop || tRect.bottom > sRect.bottom - 10) {
      const nextTop = Math.max(0, (scroller.scrollTop || 0) + (tRect.top - sRect.top) - paddingTop);
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: nextTop, behavior: 'smooth' });
      else scroller.scrollTop = nextTop;
    }
  } else {
    const nextTop = Math.max(0, (tileEl.offsetTop || 0) - paddingTop);
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: nextTop, behavior: 'smooth' });
    else scroller.scrollTop = nextTop;
  }
}

export function scrollToNextUnsolvedRecallTile() {
  const grid = el('recall-grid');
  if (!grid) return;
  const tiles = Array.from(grid.children || []);
  const nextUnsolved = tiles.find(node => node && node.classList && !node.classList.contains('solved'));
  if (nextUnsolved) scrollRecallTileIntoView(nextUnsolved, 10);
}

export function cancelRecallReturnDwellAndFocusNext() {
  if (!session.recallReturnTimer) return false;
  clearTimeout(session.recallReturnTimer);
  session.recallReturnTimer = null;
  const firstUnsolvedIdx = session.recallTiles.findIndex(t => !t.solved);
  if (firstUnsolvedIdx !== -1) {
    session.lastRecallScrollTargetIdx = firstUnsolvedIdx;
    scrollToNextUnsolvedRecallTile();
  }
  return true;
}

export function matchRecallTile(rawText, forceCommit = false) {
  const normIn = normNFC(rawText);
  if (!normIn) return;
  const strict = userStore.settings.strictDiacritics;
  const foldedIn = foldMarks(normIn);
  const normNoSpaceIn = normIn.replace(/\s+/g, '');
  const foldedNoSpaceIn = foldedIn.replace(/\s+/g, '');

  const unrevealed = session.recallTiles.filter(t => !t.solved);
  const exactMatch = unrevealed.find(t => {
    if (normIn === t.normAns) return true;
    if (!strict && foldedIn === t.foldedAns) return true;
    if (/\s/.test(t.normAns)) {
      if (strict ? normNoSpaceIn === t.normAns.replace(/\s+/g, '') : foldedNoSpaceIn === t.foldedAns.replace(/\s+/g, '')) return true;
    }
    return false;
  });
  if (!exactMatch) return;

  const hasLongerPrefix = unrevealed.some(t => {
    if (t === exactMatch) return false;
    const targetCmp = strict ? t.normAns : t.foldedAns;
    const inCmp = strict ? normIn : foldedIn;
    return targetCmp.startsWith(inCmp) && targetCmp.length > inCmp.length;
  });

  if (hasLongerPrefix && !forceCommit) {
    clearTimeout(session.recallTimer);
    session.recallTimer = setTimeout(() => matchRecallTile(el('recall-input').value, true), 600);
    return;
  }

  clearTimeout(session.recallTimer);
  clearTimeout(session.recallSweepTimer);
  clearTimeout(session.recallReturnTimer);
  session.recallTimer = null;
  session.recallSweepTimer = null;
  session.recallReturnTimer = null;

  const firstUnsolvedBefore = session.recallTiles.findIndex(t => !t.solved);
  session.recallTiles.forEach(t => { t.sweeping = false; });
  exactMatch.solved = true;
  exactMatch.sweeping = true;
  exactMatch.userTyped = String(rawText || '').trim();
  const matchedIdx = session.recallTiles.indexOf(exactMatch);
  const wasOutOfOrder = firstUnsolvedBefore !== -1 && matchedIdx !== firstUnsolvedBefore;
  const recallInp = el('recall-input');
  recallInp.value = '';
  renderRecallGrid();

  // Out-of-order recall: scroll to the matched tile FIRST and stay on it during sweep + audio + dwell
  const grid = el('recall-grid');
  const matchedBox = grid && grid.children ? grid.children[matchedIdx] : null;
  if (matchedBox) scrollRecallTileIntoView(matchedBox, 10);
  session.lastRecallScrollTargetIdx = matchedIdx;

  const chars = Array.from(String(exactMatch.answer || ''));
  const sweepMs = Math.min(900, Math.max(450, chars.length * 65));
  let sweepDone = false;
  let audioDone = false;
  let dwellDone = !wasOutOfOrder;
  let sweepFinalized = false;
  let returnFinalized = false;

  const returnToNextUnsolved = () => {
    if (returnFinalized) return;
    returnFinalized = true;
    clearTimeout(session.recallReturnTimer);
    session.recallReturnTimer = null;
    const firstUnsolvedIdx = session.recallTiles.findIndex(t => !t.solved);
    if (firstUnsolvedIdx !== -1) {
      session.lastRecallScrollTargetIdx = firstUnsolvedIdx;
      scrollToNextUnsolvedRecallTile();
      recallInp.focus({ preventScroll: true });
    }
  };

  const finalizeSweep = () => {
    if (sweepFinalized) return;
    sweepFinalized = true;
    clearTimeout(session.recallSweepTimer);
    session.recallSweepTimer = null;
    exactMatch.sweeping = false;
    renderRecallGrid();
    if (!wasOutOfOrder) returnToNextUnsolved();
  };

  const maybeFinishSweep = () => {
    if (sweepDone && audioDone) finalizeSweep();
  };
  const maybeFinishReturn = () => {
    if (sweepFinalized && audioDone && dwellDone) returnToNextUnsolved();
  };

  setTimeout(() => { sweepDone = true; maybeFinishSweep(); }, sweepMs);
  session.recallSweepTimer = setTimeout(() => { finalizeSweep(); maybeFinishReturn(); }, 1150);
  if (wasOutOfOrder) {
    session.recallReturnTimer = setTimeout(() => {
      session.recallReturnTimer = null;
      dwellDone = true;
      maybeFinishReturn();
    }, 1400);
    setTimeout(returnToNextUnsolved, 2400);
  }
  speakPT(exactMatch.answer, {
    rate: getNormalSpeechRate(),
    keepVoice: false,
    onDone: () => { audioDone = true; maybeFinishSweep(); maybeFinishReturn(); }
  });
  recallInp.focus({ preventScroll: true });

  if (session.recallTiles.every(t => t.solved)) {
    try { recallInp.blur(); } catch (_) {}
    recallInp.classList.add('hidden');
    const rBar = el('recall-diacritic-bar');
    if (rBar) rBar.classList.add('hidden');
    const b = el('recall-complete-banner');
    b.textContent = `All ${session.recallTiles.length} words recalled!`;
    b.classList.remove('hidden');
    const subBtn = el('btn-recall-submit');
    if (subBtn) subBtn.classList.add('hidden');
    const doneBtn = el('btn-recall-done');
    doneBtn.className = 'btn btn-emerald';
    doneBtn.textContent = 'Continue to Summary';
  }
}

// Rich Summary: 1 full example sentence + English + speaker & 0.75x for EVERY New & Tricky word
export async function showDoneSummary() {
  clearTimeout(session.recallTimer);
  clearTimeout(session.recallSweepTimer);
  clearTimeout(session.recallReturnTimer);
  session.recallTimer = null;
  session.recallSweepTimer = null;
  session.recallReturnTimer = null;
  setFinaleRecallLayout(false);
  el('finale-title').textContent = 'Summary';
  el('finale-sub').textContent = '';
  el('finale-sub').classList.add('hidden');
  el('btn-finale-skip').classList.add('hidden');
  if (el('btn-recall-skip')) el('btn-recall-skip').classList.add('hidden');
  if (el('btn-summary-history')) el('btn-summary-history').classList.remove('hidden');
  el('panel-blind').classList.add('hidden');
  el('panel-recall').classList.add('hidden');
  el('panel-done').classList.remove('hidden');

  el('done-heading').textContent = session.mode === 'verb_drill' ? 'Verb Drill Complete' : 'Session Complete';

  // Mutually exclusive 2-section partitioning of ALL unique practiced forms (excludes pre-answer skippedKnown, 0 duplicates, 100% KPI parity)
  const trickyItems = [];
  const cleanItems = [];
  const seen = new Set();

  for (const [logKey, log] of session.sessionLog.entries()) {
    if (!log || log.skippedKnown) continue;
    if (seen.has(logKey)) continue;
    seen.add(logKey);
    const lemmaId = log.lemmaId || String(logKey).split('::')[0];
    const entry = contentStore.entriesById.get(lemmaId);
    if (!entry) continue;
    const isTricky = Boolean(log.tricky || log.grade < 3);
    const isNew = Boolean(log.wasNew);
    const rec = { entry, log, isNew, isTricky };
    if (isTricky) trickyItems.push(rec);
    else cleanItems.push(rec);
  }

  const cleanTotal = cleanItems.length;
  const trickyTotal = trickyItems.length;
  const reviewedTotal = cleanTotal + trickyTotal;
  const newTotal = cleanItems.filter(x => x.isNew).length + trickyItems.filter(x => x.isNew).length;
  el('done-reviewed').textContent = String(reviewedTotal);
  if (el('done-new')) el('done-new').textContent = String(newTotal);
  el('done-clean').textContent = String(cleanTotal);
  el('done-tricky').textContent = String(trickyTotal);
  const nextSessionBtn = el('btn-done-next-session');
  if (nextSessionBtn) {
    const { dueCount } = computeAvailableSessionCounts();
    nextSessionBtn.classList.toggle('hidden', dueCount <= 0);
  }
  if (reviewedTotal > 0) playSummaryChord();

  const trickyTitleEl = el('done-tricky-title');
  if (trickyTitleEl && trickyTitleEl.children[1]) trickyTitleEl.children[1].textContent = `TRICKY WORDS · ${trickyItems.length}`;
  const cleanTitleEl = el('done-clean-title');
  if (cleanTitleEl && cleanTitleEl.children[1]) cleanTitleEl.children[1].textContent = `REVIEWED CLEANLY · ${cleanItems.length}`;

  const renderRichCards = async (secId, boxId, items) => {
    el(secId).classList.toggle('hidden', items.length === 0);
    const box = el(boxId);
    box.textContent = '';

    for (const { entry, log, isNew } of items) {
      const exs = await getExamplesForEntry(entry);
      const ex = (log && exs.find(e => e.exId === log.exId))
        || (log && log.answer && exs.find(e => normNFC(e.answer) === normNFC(log.answer)))
        || exs[0];
      const practicedWord = (log && log.answer) || (ex && ex.answer) || entry.lemma;
      const practicedGloss = (log && log.cleanedHint)
        || (ex && (resolveGrammaticalTags(entry, ex).cleanedHint || ex.clean_hint_en))
        || entry.en_gloss;

      const card = document.createElement('div');
      card.className = 'summary-word-card';

      // Row 1: Word Header (Left: practiced word + frameless inline word speaker + gloss; Right: ONLY New pill if new)
      const top = document.createElement('div');
      top.className = 'sum-word-row';

      const left = document.createElement('div');
      left.className = 'sum-word-left';

      const wordBtn = document.createElement('button');
      wordBtn.type = 'button';
      wordBtn.className = 'sum-word-btn';
      wordBtn.textContent = practicedWord;
      wordBtn.addEventListener('click', () => appActions.openWordDetailsModal(entry));

      const wSpk = document.createElement('button');
      wSpk.type = 'button';
      wSpk.className = 'sum-speak-word';
      wSpk.setAttribute('aria-label', `Hear word ${practicedWord}`);
      wSpk.appendChild(makeSpeakerIcon(14));
      wSpk.addEventListener('click', e => {
        e.stopPropagation();
        speakPT(practicedWord, { rate: 0.96, keepVoice: false });
      });

      const dotSep = document.createElement('span');
      dotSep.className = 'sum-word-gloss';
      dotSep.textContent = '·';

      const gl = document.createElement('span');
      gl.className = 'sum-word-gloss';
      gl.textContent = practicedGloss;

      left.append(wordBtn, wSpk, dotSep, gl);

      const right = document.createElement('div');
      right.style.flexShrink = '0';
      if (isNew) {
        const nb = document.createElement('span');
        nb.className = 'badge-new-pill';
        nb.textContent = 'New';
        right.appendChild(nb);
      }
      top.append(left, right);
      card.appendChild(top);

      // Row 2: Example sentence + bordered soft-indigo sentence speaker (2nd-tap 0.75x turtle)
      if (ex) {
        const exRow = document.createElement('div');
        exRow.className = 'summary-ex-row';
        const col = document.createElement('div');
        col.style.flex = '1';
        col.style.minWidth = '0';
        const pt = document.createElement('div');
        pt.className = 'sum-pt-sent';
        renderClozeSentence(pt, ex, { revealed: true, lemmaId: entry.id });
        const en = document.createElement('div');
        en.className = 'sum-en-sent';
        renderHighlightedEnglish(en, ex.en, practicedGloss, entry.en_gloss, ex.answer);
        col.append(pt, en);
        const sumNote = getCombinedNoteText(entry, ex);
        if (sumNote) {
          const snEl = document.createElement('div');
          snEl.className = 'wd-ex-note';
          renderRichGrammarNote(snEl, sumNote, entry.id);
          col.appendChild(snEl);
        }

        const s1 = document.createElement('button');
        s1.type = 'button';
        s1.className = 'sum-speak-sent';
        s1.setAttribute('aria-label', 'Hear sentence');
        bindProgressiveExampleBtn(s1, normalizeColloquialContext(ex).pt, 15);
        exRow.append(col, s1);
        card.appendChild(exRow);
      }
      box.appendChild(card);
    }
  };

  await renderRichCards('done-tricky-section', 'done-tricky-cards', trickyItems);
  await renderRichCards('done-clean-section', 'done-clean-cards', cleanItems);
  renderDrillRecommendationCard('done-drill-rec', getConfusableRecommendations()[0] || null);
}

export async function openSessionHistoryModal() {
  const modal = el('modal-session-history');
  const list = el('session-history-list');
  const countEl = el('session-history-count');
  if (!modal || !list) return;

  list.textContent = '';
  let rows = Array.isArray(session.mainHistory) && session.mainHistory.length > 0 ? [...session.mainHistory] : [];
  if (rows.length === 0 && session.sessionLog instanceof Map) {
    for (const log of session.sessionLog.values()) {
      if (!log) continue;
      const entry = contentStore.entriesById.get(log.lemmaId);
      let pt = '';
      if (entry && log.exId) {
        const exs = await getExamplesForEntry(entry);
        const found = exs.find(e => e.exId === log.exId);
        if (found) pt = found.pt || '';
      }
      rows.push({
        exId: log.exId || '',
        lemmaId: log.lemmaId || '',
        pt,
        answer: log.answer || (entry ? entry.lemma : ''),
        outcome: log.skippedKnown ? 'known' : ((log.tricky || log.grade < 3) ? (log.grade === 2 ? 'hard' : 'missed') : 'clean')
      });
    }
  }

  if (countEl) countEl.textContent = String(rows.length);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted-xs';
    empty.style.padding = '12px 4px';
    empty.textContent = 'No sentences recorded in this session.';
    list.appendChild(empty);
  } else {
    rows.forEach((h, idx) => {
      const card = document.createElement('div');
      card.className = 'history-item';

      const head = document.createElement('div');
      head.className = 'history-head';
      const idEl = document.createElement('span');
      idEl.className = 'history-exid';
      idEl.textContent = `#${idx + 1} · ${h.exId || 'unknown'}`;

      const badge = document.createElement('span');
      const out = h.outcome || 'clean';
      badge.className = `badge ${out === 'clean' ? 'badge-emerald' : (out === 'hard' ? 'badge-amber' : (out === 'known' ? 'badge-primary' : 'badge-rose'))}`;
      badge.textContent = out === 'clean' ? 'Clean' : (out === 'hard' ? 'Hard' : (out === 'known' ? 'Known' : 'Missed'));
      head.append(idEl, badge);

      const ptEl = document.createElement('div');
      ptEl.className = 'history-pt';
      ptEl.textContent = h.pt || h.answer || '';

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const ansEl = document.createElement('span');
      ansEl.textContent = `Answer: ${h.answer || ''}`;
      const repBtn = document.createElement('button');
      repBtn.type = 'button';
      const alreadyRep = isSentenceReported(h.exId);
      repBtn.className = `history-report-btn${alreadyRep ? ' reported' : ''}`;
      repBtn.textContent = alreadyRep ? 'Reported' : 'Report';
      repBtn.addEventListener('click', () => {
        openReportModal({
          exId: h.exId || '',
          lemmaId: h.lemmaId || '',
          cardKey: h.lemmaId || '',
          pt: h.pt || '',
          en: h.en || '',
          answer: h.answer || '',
          userInput: ''
        });
      });
      meta.append(ansEl, repBtn);

      card.append(head, ptEl, meta);
      list.appendChild(card);
    });
  }
  list.scrollTop = 0;
  modal.classList.remove('hidden');
}

export function closeSessionHistoryModal() {
  const modal = el('modal-session-history');
  if (modal) modal.classList.add('hidden');
}

export function syncSfxButtonUI() {
  const btn = el('btn-session-sfx');
  if (!btn) return;
  const on = userStore.settings.soundEffects !== false;
  btn.classList.toggle('sfx-muted', !on);
  btn.setAttribute('aria-label', on ? 'Sound effects on' : 'Sound effects off');
  const slash = el('sfx-mute-slash');
  if (slash) slash.classList.toggle('hidden', on);
}

let activeReportTarget = null;
let activeReportReason = 'Wrong PT';

export function setReportReason(reason) {
  activeReportReason = String(reason || 'Other');
  const grid = el('report-reasons-grid');
  if (grid) {
    grid.querySelectorAll('.report-reason-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.reason === activeReportReason);
    });
  }
}

export function openReportModal(explicitTarget = null) {
  let tgt = explicitTarget;
  if (!tgt && session.activeItem && session.activeItem.ex) {
    const it = session.activeItem;
    const inp = el('answer-input');
    tgt = {
      exId: it.ex.exId || '',
      lemmaId: it.entry ? it.entry.id : (it.ex.lemmaId || ''),
      cardKey: it.cardKey || '',
      pt: it.ex.pt || '',
      en: it.ex.en || '',
      answer: it.ex.answer || '',
      userInput: inp ? inp.value : ''
    };
  }
  if (!tgt) return;
  activeReportTarget = tgt;
  setReportReason('Wrong PT');
  const prev = el('report-ex-preview');
  if (prev) prev.textContent = `${tgt.exId || ''} · "${tgt.pt || ''}" (${tgt.en || ''})`;
  const noteInp = el('report-note-input');
  if (noteInp) noteInp.value = '';
  const modal = el('modal-report-sentence');
  if (modal) modal.classList.remove('hidden');
}

export function closeReportModal() {
  const modal = el('modal-report-sentence');
  if (modal) modal.classList.add('hidden');
}

export async function submitSentenceReport() {
  if (!activeReportTarget) return null;
  const noteInp = el('report-note-input');
  const rec = await saveSentenceReport({
    ...activeReportTarget,
    reason: activeReportReason,
    note: noteInp ? noteInp.value : ''
  });
  closeReportModal();
  if (session.activeItem && session.activeItem.ex && session.activeItem.ex.exId === rec.exId) {
    const repBtn = el('btn-report-sentence');
    if (repBtn) repBtn.classList.add('reported');
  }
  if (navState.settingsOpen) appActions.renderSettings();
  const histModal = el('modal-session-history');
  if (histModal && !histModal.classList.contains('hidden')) openSessionHistoryModal();
  showToast('Sentence report saved');
  return rec;
}


export const LOW_WORKLOAD_THRESHOLD = 5;
// dailyGoalState.modalMode and dailyGoalState.addDelta live in state.js dailyGoalState

export function computeTopUpDelta(currentDue, targetSize, remainingUnintroduced) {
  const needed = Math.max(0, Number(targetSize || 10) - Number(currentDue || 0));
  if (remainingUnintroduced != null) return Math.min(needed, Math.max(0, Number(remainingUnintroduced)));
  return needed;
}

export function startStudySession(paused = null, opts = {}) {
  ensureDailyRollover();
  session.mode = 'study';
  session.undoStack = [];
  session.lastPreSnapshot = null;
  session.recentNewVerbStreak = 0;

  if (paused) {
    session.targetCount = paused.targetCount;
    session.reviewedCount = paused.reviewedCount;
    session.cleanCount = paused.cleanCount || 0;
    session.hardCount = paused.hardCount || 0;
    session.missedCount = paused.missedCount || 0;
    session.requeueList = paused.requeueList || [];
    session.missedIds = new Set(paused.missedIds || []);
    session.hardIds = new Set(paused.hardIds || []);
    session.newLearnedIds = new Set(paused.newLearnedIds || []);
    session.mainHistory = Array.isArray(paused.mainHistory) ? paused.mainHistory.slice() : [];
    session.seenMainExIds = new Set(Array.isArray(paused.seenMainExIds) ? paused.seenMainExIds : session.mainHistory.map(h => h && h.exId).filter(Boolean));
    session.failedExactItems = [];
    session.sessionLog = new Map(paused.sessionLog || []);
    appActions.navigateTo('session');
    const { lemmaId, cellClass } = parseCardKey(paused.activeCardKey);
    const entry = contentStore.entriesById.get(lemmaId);
    if (entry) {
      if (Array.isArray(paused.failedExactItems) && paused.failedExactItems.length > 0) {
        Promise.all(paused.failedExactItems.map(async f => {
          if (!f || !f.lemmaId || !f.exId) return null;
          const fe = contentStore.entriesById.get(f.lemmaId);
          if (!fe) return null;
          const fexs = await getExamplesForEntry(fe);
          const fex = fexs.find(e => e.exId === f.exId);
          return fex ? { cardKey: f.cardKey || f.lemmaId, entry: fe, ex: fex, cellClass: f.cellClass || null } : null;
        })).then(items => { session.failedExactItems = items.filter(Boolean); });
      }
      getExamplesForEntry(entry).then(exs => {
        const ex = exs.find(e => e.exId === paused.activeExId) || exs[0];
        if (ex) mountStudyItem({ cardKey: paused.activeCardKey, entry, ex, cellClass });
        else advanceStudy();
      });
      return;
    }
  } else {
    const { dueCount, availNew, unintroducedInLoadedPacks } = computeAvailableSessionCounts();
    const totalAvailable = dueCount + availNew;
    if (totalAvailable === 0) {
      if (unintroducedInLoadedPacks > 0) {
        dailyGoalState.modalMode = 'goal_reached';
        const targetSz = [10, 20, 30].includes(Number(userStore.settings.sessionSize)) ? Number(userStore.settings.sessionSize) : 20;
        dailyGoalState.addDelta = Math.max(1, computeTopUpDelta(0, targetSz, unintroducedInLoadedPacks));
        const tEl = el('dl-title'); if (tEl) tEl.textContent = 'Daily Goal Reached!';
        el('dl-message').textContent = `You've completed today's goal of ${userStore.settings.dailyNewLimit} new words and have no reviews due right now. Add ${dailyGoalState.addDelta} new word${dailyGoalState.addDelta === 1 ? '' : 's'}?`;
        el('btn-dl-not-now').textContent = 'Not Now';
        el('btn-dl-add-10').textContent = `Add ${dailyGoalState.addDelta} New`;
        el('modal-daily-limit').classList.remove('hidden');
      } else {
        showToast('All words in your loaded packs have already been introduced.');
      }
      return;
    }
    if (!opts.bypassLowWorkload && totalAvailable > 0 && totalAvailable < LOW_WORKLOAD_THRESHOLD && unintroducedInLoadedPacks > availNew) {
      dailyGoalState.modalMode = 'low_workload';
      const rawSz = [10, 20, 30].includes(Number(userStore.settings.sessionSize)) ? Number(userStore.settings.sessionSize) : 20;
      const targetSz = Math.max(LOW_WORKLOAD_THRESHOLD, rawSz);
      const actualAdded = Math.max(1, computeTopUpDelta(totalAvailable, targetSz, unintroducedInLoadedPacks - availNew));
      dailyGoalState.addDelta = actualAdded;
      const reachTotal = totalAvailable + actualAdded;
      const tEl = el('dl-title');
      if (tEl) tEl.textContent = `Only ${totalAvailable} Word${totalAvailable === 1 ? '' : 's'} Available`;
      el('dl-message').textContent = `You have ${totalAvailable} word${totalAvailable === 1 ? '' : 's'} queued under today's goal. Practice just ${totalAvailable === 1 ? 'this 1' : `these ${totalAvailable}`}, or add ${actualAdded} new to reach ${reachTotal}?`;
      el('btn-dl-not-now').textContent = `Practice Just ${totalAvailable}`;
      el('btn-dl-add-10').textContent = `Add ${actualAdded} New (+${actualAdded} to reach ${reachTotal})`;
      el('modal-daily-limit').classList.remove('hidden');
      return;
    }
    clearPausedSession();
    const requested = [10, 20, 30].includes(Number(userStore.settings.sessionSize)) ? Number(userStore.settings.sessionSize) : 20;
    session.targetCount = Math.min(requested, totalAvailable);
    session.reviewedCount = 0; session.cleanCount = 0; session.hardCount = 0; session.missedCount = 0;
    session.requeueList = [];
    session.requeuedFormKeys = new Set();
    session.missedIds.clear(); session.hardIds.clear(); session.newLearnedIds.clear();
    session.failedExactItems = []; session.round1Items = []; session.round1Idx = 0; session.round1Total = 0;
    session.mainHistory = [];
    session.seenMainExIds = new Set();
    session.lemmaSenseMap = new Map();
    session.sessionLog.clear();
    appActions.navigateTo('session');
  }
  advanceStudy();
}

export function startVerbDrill(entry, eligible) {
  session.mode = 'verb_drill';
  session.drillQueue = eligible.map(ex => ({ cardKey: entry.id, entry, ex, cellClass: ex.cellClass }));
  session.targetCount = session.drillQueue.length;
  session.reviewedCount = 0; session.cleanCount = 0; session.hardCount = 0; session.missedCount = 0;
  session.undoStack = [];
  el('session-title').textContent = `Verb Drill · ${entry.lemma}`;
  appActions.navigateTo('drill');
  advanceStudy();
}


/* ==========================================================================
   16. KEYBOARD-SAFE EVENT BINDINGS & BOOTSTRAP
   ========================================================================== */
export function handleVisibilityChange() {
  if (document.hidden) {
    if (session.activeItem && !session.revealed && session.timerStartMs > 0) {
      session.timerAccumMs += Math.max(0, Date.now() - session.timerStartMs);
      session.timerStartMs = 0;
    }
    stopTTS();
  } else {
    if (session.activeItem && !session.revealed) {
      session.timerStartMs = Date.now();
    }
  }
}


/* ==========================================================================
   10B. IN-SESSION CONFUSABLE-PAIR MINI-DRILL OVERLAY (STRICTLY UNLOGGED)
   ========================================================================== */
export const CONFUSABLE_PAIRS = [
  ['bom', 'bem'], ['mal', 'mau'], ['ser', 'estar'], ['por', 'para'],
  ['saber', 'conhecer'], ['mas', 'mais'], ['tudo', 'todo'], ['trazer', 'levar'],
  ['ouvir', 'escutar'], ['falar', 'dizer'], ['ir', 'vir'], ['ver', 'olhar'],
  ['onde', 'aonde'], ['sobre', 'sob'], ['este', 'esse'], ['ficar', 'estar'],
  ['do', 'da'], ['no', 'na'], ['pelo', 'pela']
];

export function getConfusableGroup(entry) {
  if (!entry) return null;
  const byId = new Map();
  if (entry.cluster_id) {
    for (const e of contentStore.orderedEntries) {
      if (e.cluster_id === entry.cluster_id && isPackLoadedOrAvailable(e.packId)) {
        byId.set(e.id, e);
      }
    }
  }
  if (byId.size < 2) {
    const lem = normNFC(entry.lemma);
    const pair = CONFUSABLE_PAIRS.find(gr => gr.some(w => normNFC(w) === lem));
    if (pair) {
      for (const w of pair) {
        const nw = normNFC(w);
        const match = contentStore.orderedEntries.find(e => normNFC(e.lemma) === nw && isPackLoadedOrAvailable(e.packId));
        if (match) byId.set(match.id, match);
      }
    }
  }
  const entries = Array.from(byId.values()).slice(0, 3);
  if (entries.length < 2) return null;
  const label = entries.map(e => e.lemma).join(' vs ');
  return { entries, label };
}

export function maybeRecordConfusableMixup(entry, typedInput) {
  if (session.mode !== 'study' || !entry || !typedInput) return null;
  const grp = getConfusableGroup(entry);
  if (!grp || !Array.isArray(grp.entries)) return null;
  const foldedIn = foldMarks(typedInput);
  if (!foldedIn) return null;
  const matchedOther = grp.entries.some(other => {
    if (!other || other.id === entry.id) return false;
    if (foldMarks(other.lemma) === foldedIn) return true;
    return Array.isArray(other.forms) && other.forms.some(f => foldMarks(f) === foldedIn);
  });
  if (!matchedOther) return null;
  return recordConfusableMixup(grp.entries.map(e => e.lemma));
}

export function getAllConfusableGroupsByUnit() {
  const out = [];
  const seenKeys = new Set();
  const highestUnit = Math.max(1, getHighestReachedUnit());
  for (const pair of CONFUSABLE_PAIRS) {
    const entries = [];
    for (const w of pair) {
      const nw = normNFC(w);
      const match = contentStore.orderedEntries.find(e => normNFC(e.lemma) === nw && isPackLoadedOrAvailable(e.packId));
      if (match) entries.push(match);
    }
    if (entries.length < 2) continue;
    const pairKey = makeMixupPairKey(entries.map(e => e.lemma));
    if (seenKeys.has(pairKey)) continue;
    seenKeys.add(pairKey);
    const unlockUnit = Math.max(1, ...entries.map(e => Number(e.unit) || 1));
    out.push({
      pairKey,
      entries,
      label: entries.map(e => e.lemma).join(' vs '),
      unlockUnit,
      unlocked: unlockUnit <= highestUnit
    });
  }
  out.sort((a, b) => a.unlockUnit - b.unlockUnit || a.label.localeCompare(b.label));
  return out;
}

export function getConfusableRecommendations() {
  const groups = getAllConfusableGroupsByUnit();
  const mixups = userStore.mixups && typeof userStore.mixups === 'object' ? userStore.mixups : {};
  const formatCount = n => (n === 1 ? 'once' : (n === 2 ? 'twice' : `${n} times`));
  const recs = [];
  for (const grp of groups) {
    if (!grp.unlocked) continue;
    const rec = mixups[grp.pairKey];
    const mixCount = rec ? (Number(rec.count) || 0) : 0;
    const dismissedRecent = Boolean(rec && rec.dismissedAt && rec.dismissedAt >= (rec.lastTs || 0));
    if (dismissedRecent) continue;
    const slashLabel = grp.entries.map(e => e.lemma).join(' / ');
    if (mixCount >= 1) {
      recs.push({
        pairKey: grp.pairKey,
        group: grp,
        score: mixCount * 10 + (rec.lastTs || 0) / 1e13,
        message: `You mixed up ${slashLabel} ${formatCount(mixCount)} - 2-min drill`
      });
      continue;
    }
    const allIntroduced = grp.entries.every(e => userStore.cards.has(e.id));
    const bothWeak = allIntroduced && grp.entries.every(e => {
      const c = userStore.cards.get(e.id);
      return c && ((c.lapses || 0) >= 1 || (c.stability || 0) < 3);
    });
    if (bothWeak) {
      recs.push({
        pairKey: grp.pairKey,
        group: grp,
        score: 2,
        message: `Practice ${slashLabel} contrast - 2-min drill`
      });
    }
  }
  recs.sort((a, b) => b.score - a.score);
  return recs;
}

export function renderDrillRecommendationCard(prefix, rec) {
  const card = el(prefix);
  const txt = el(`${prefix}-text`);
  const goBtn = el(`btn-${prefix}-go`);
  const disBtn = el(`btn-${prefix}-dismiss`);
  if (!card) return;
  if (!rec) {
    card.classList.add('hidden');
    card.onclick = null;
    return;
  }
  if (txt) {
    txt.textContent = prefix === 'home-drill-rec' && rec.group && Array.isArray(rec.group.entries)
      ? `${rec.group.entries.map(e => e.lemma).join(' / ')} contrast`
      : rec.message;
  }
  card.classList.remove('hidden');
  card.onclick = prefix === 'home-drill-rec' ? () => startClusterDrill(rec.group) : null;
  if (goBtn) {
    goBtn.onclick = evt => {
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      startClusterDrill(rec.group);
    };
  }
  if (disBtn) {
    disBtn.onclick = async evt => {
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      await dismissConfusableRecommendation(rec.pairKey);
      card.classList.add('hidden');
      if (typeof appActions.renderHome === 'function' && navState.view === 'home') appActions.renderHome();
    };
  }
}

export function renderHomeDrillRec() {
  renderDrillRecommendationCard('home-drill-rec', getConfusableRecommendations()[0] || null);
}

export function renderDrillsHub() {
  const mode = userStore.settings.typoTrainerMode === 'real' ? 'real' : 'all';
  userStore.settings.typoTrainerMode = mode;
  const modeGrp = el('typo-mode-group');
  if (modeGrp) {
    modeGrp.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.typoMode === mode);
    });
  }
  const activeTypos = getActiveTypoEntries(mode);
  const cntBadge = el('drills-typo-count');
  if (cntBadge) {
    cntBadge.textContent = `${activeTypos.length} queued`;
    cntBadge.className = `badge ${activeTypos.length > 0 ? 'badge-primary' : 'badge-slate'}`;
  }
  const prevBox = el('drills-typo-preview');
  if (prevBox) {
    prevBox.textContent = '';
    if (activeTypos.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted-xs';
      empty.textContent = mode === 'real'
        ? 'No real spelling mistakes queued.'
        : 'No typos queued yet. Missed accents or spelling slips appear here.';
      prevBox.appendChild(empty);
    } else {
      activeTypos.slice(0, 8).forEach(rec => {
        const chip = document.createElement('span');
        chip.className = 'typo-preview-chip';
        chip.textContent = `${rec.target} (${rec.cleanStreak || 0}/2)`;
        prevBox.appendChild(chip);
      });
    }
  }
  const startTypoBtn = el('btn-start-typo-drill');
  if (startTypoBtn) startTypoBtn.disabled = activeTypos.length === 0;

  const list = el('drills-confusable-list');
  if (!list) return;
  list.textContent = '';
  const groups = getAllConfusableGroupsByUnit();
  const byUnit = new Map();
  groups.forEach(g => {
    if (!byUnit.has(g.unlockUnit)) byUnit.set(g.unlockUnit, []);
    byUnit.get(g.unlockUnit).push(g);
  });
  for (const [unitNum, items] of Array.from(byUnit.entries()).sort((a, b) => a[0] - b[0])) {
    const sec = document.createElement('div');
    sec.className = 'drills-unit-group';
    const lbl = document.createElement('div');
    lbl.className = 'drills-unit-label';
    lbl.textContent = `Unit ${unitNum}`;
    sec.appendChild(lbl);
    items.forEach(grp => {
      const row = document.createElement('div');
      row.className = `drills-pair-row${grp.unlocked ? '' : ' locked'}`;
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.style.fontSize = '13.5px';
      title.style.fontWeight = '700';
      title.textContent = grp.entries.map(e => e.lemma).join(' / ');
      const sub = document.createElement('div');
      sub.className = 'muted-xs';
      sub.textContent = grp.entries.map(e => e.en_gloss).join(' vs ');
      info.append(title, sub);

      if (grp.unlocked) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary-soft btn-xs';
        btn.textContent = 'Drill';
        btn.addEventListener('click', () => startClusterDrill(grp));
        row.append(info, btn);
      } else {
        const lockBadge = document.createElement('span');
        lockBadge.className = 'badge badge-slate';
        lockBadge.textContent = `Unit ${grp.unlockUnit}`;
        row.append(info, lockBadge);
      }
      sec.appendChild(row);
    });
    list.appendChild(sec);
  }
}

export async function startTypoDrill(explicitMode = null) {
  const mode = explicitMode || (userStore.settings.typoTrainerMode === 'real' ? 'real' : 'all');
  const active = getActiveTypoEntries(mode).slice(0, 10);
  if (active.length === 0) { showToast('No spelling items queued for this mode.'); return; }
  const queue = [];
  for (const rec of active) {
    const entry = contentStore.entriesById.get(rec.lemmaId);
    if (!entry) continue;
    const exs = await getExamplesForEntry(entry);
    const ex = (rec.exId && exs.find(e => e.exId === rec.exId))
      || exs.find(e => normNFC(e.answer) === normNFC(rec.target))
      || exs[0];
    if (ex) queue.push({ entry, ex, typoKey: rec.key, target: rec.target });
  }
  if (queue.length === 0) { showToast('Could not load example sentences for queued typos.'); return; }
  stopTTS();
  State.clusterDrill = {
    isTypoDrill: true,
    typoMode: mode,
    group: { label: mode === 'real' ? 'Spelling · Real Typos' : 'Spelling · All Typos', entries: [] },
    queue,
    idx: 0,
    correct: 0,
    revealed: false,
    manualPlayCount: 0,
    lastPhase: 'pre',
    legendVisible: false
  };
  const legendBtn = el('btn-cluster-legend-toggle');
  if (legendBtn) legendBtn.classList.add('hidden');
  el('cd-legend').classList.add('hidden');
  el('cd-title').textContent = State.clusterDrill.group.label;
  el('cd-done-panel').classList.add('hidden');
  el('cd-card-box').classList.remove('hidden');
  el('cd-input-dock').classList.remove('hidden');
  el('view-cluster-drill').classList.remove('hidden');
  appActions.pushHistory('cluster-drill');
  renderClusterDrillCard();
}

export async function startClusterDrill(group) {
  if (!group || !Array.isArray(group.entries) || group.entries.length < 2) return;
  stopTTS();
  const perWord = group.entries.length === 2 ? 3 : 2;
  const buckets = [];
  for (const e of group.entries) {
    const exs = await getEligibleExamples(e, null);
    const picked = [...exs].sort(() => Math.random() - 0.5).slice(0, perWord);
    if (picked.length > 0) buckets.push(picked.map(ex => ({ entry: e, ex })));
  }
  if (buckets.length < 2) { showToast('Not enough examples loaded for mini-drill.'); return; }
  const queue = [];
  const maxLen = Math.max(...buckets.map(b => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const b of buckets) {
      if (b[i]) queue.push(b[i]);
    }
  }
  State.clusterDrill = {
    group, queue, idx: 0, correct: 0, revealed: false, manualPlayCount: 0, lastPhase: 'pre', legendVisible: false
  };
  const legend = el('cd-legend');
  if (legend) {
    legend.textContent = '';
    group.entries.forEach(e => {
      const pill = document.createElement('span');
      pill.className = 'cd-legend-pill';
      const st = document.createElement('strong'); st.textContent = e.lemma;
      const info = document.createElement('span'); info.textContent = `${e.en_gloss} · ${formatPOS(e.pos)}`;
      pill.append(st, info);
      legend.appendChild(pill);
    });
  }
  const legendBtn = el('btn-cluster-legend-toggle');
  if (legendBtn) legendBtn.classList.remove('hidden');
  syncClusterLegendUI();
  el('cd-title').textContent = group.label;
  el('cd-done-panel').classList.add('hidden');
  el('cd-card-box').classList.remove('hidden');
  el('cd-input-dock').classList.remove('hidden');
  el('view-cluster-drill').classList.remove('hidden');
  appActions.pushHistory('cluster-drill');
  renderClusterDrillCard();
}

export function syncClusterLegendUI() {
  const cd = State.clusterDrill;
  const vis = Boolean(cd && cd.legendVisible);
  const legend = el('cd-legend');
  const toggle = el('btn-cluster-legend-toggle');
  if (legend) legend.classList.toggle('hidden', !vis);
  if (toggle) {
    toggle.setAttribute('aria-expanded', vis ? 'true' : 'false');
    toggle.innerHTML = (vis ? ICON_EYE_OFF_SVG : ICON_EYE_SVG) + `<span>${vis ? 'Hide word contrast' : 'Show word contrast'}</span>`;
  }
}

export function focusClusterDrillInput() {
  const inp = el('cd-input');
  if (inp) inp.focus({ preventScroll: true });
}

export function renderClusterDrillCard() {
  const cd = State.clusterDrill;
  if (!cd) return;
  stopTTS();
  const item = cd.queue[cd.idx];
  if (!item) {
    el('cd-card-box').classList.add('hidden');
    el('cd-feedback').classList.add('hidden');
    el('cd-input-dock').classList.add('hidden');
    el('cd-done-score').textContent = `${cd.correct} / ${cd.queue.length} right`;
    el('cd-done-panel').classList.remove('hidden');
    el('cd-progress-fill').style.width = '100%';
    el('cd-counter').textContent = `${cd.queue.length}/${cd.queue.length}`;
    return;
  }
  cd.revealed = false;
  cd.manualPlayCount = 0;
  cd.lastPhase = 'pre';
  pickVoiceForNewCard();

  const { entry, ex } = item;
  el('cd-counter').textContent = `${cd.idx + 1}/${cd.queue.length}`;
  el('cd-progress-fill').style.width = `${Math.round((cd.idx / cd.queue.length) * 100)}%`;

  const posEl = el('cd-pos');
  posEl.textContent = formatPOS(entry.pos);
  posEl.className = `badge ${getPosPillClass(entry.pos)}`;

  const tags = resolveGrammaticalTags(entry, ex);
  const gEl = el('cd-gender');
  if (tags.gender === 'm') { gEl.className = 'badge pill-icon-wrap pill-masc'; setPillWithIcon(gEl, 'm', 'Masculine'); }
  else if (tags.gender === 'f') { gEl.className = 'badge pill-icon-wrap pill-fem'; setPillWithIcon(gEl, 'f', 'Feminine'); }
  else if (tags.gender === 'mf') { gEl.className = 'badge pill-mf'; gEl.textContent = 'Masc. / Fem.'; }
  else gEl.className = 'badge hidden';

  const nEl = el('cd-number');
  if (tags.number) { nEl.className = 'badge pill-icon-wrap pill-slot-num'; setPillWithIcon(nEl, tags.number, tags.number === 'sg' ? 'Singular' : 'Plural'); }
  else nEl.className = 'badge hidden';

  renderClozeSentence(el('cd-pt-box'), ex, { revealed: false, typed: '', revealedPrefixLen: 0, onGapTap: focusClusterDrillInput });
  const hlRes = renderHighlightedEnglish(el('cd-en'), ex.en, tags.cleanedHint, entry.en_gloss, ex.answer);
  const qualMatch = tags.cleanedHint.match(/\(([^()]+)\)/);
  const hEl = el('cd-hint');
  if (hlRes && hlRes.matched && !qualMatch) { hEl.textContent = ''; hEl.classList.add('hidden'); }
  else if (hlRes && hlRes.matched && qualMatch) { hEl.textContent = qualMatch[0]; hEl.classList.remove('hidden'); }
  else { hEl.textContent = tags.cleanedHint; hEl.classList.toggle('hidden', !tags.cleanedHint); }

  el('cd-feedback').classList.add('hidden');
  el('cd-diacritic-bar').classList.toggle('hidden', Boolean(userStore.settings.hideDiacriticsBar));
  renderProgressiveAudioBtn(el('btn-cd-audio'), 'Listen', 0, 15);
  const inp = el('cd-input');
  inp.value = '';
  const subBtn = el('btn-cd-submit');
  subBtn.className = 'btn btn-primary';
  subBtn.textContent = 'Check';
  inp.focus({ preventScroll: true });
}

export async function submitClusterDrillAnswer() {
  const cd = State.clusterDrill;
  if (!cd) return;
  if (cd.revealed) {
    cd.idx += 1;
    renderClusterDrillCard();
    return;
  }
  const item = cd.queue[cd.idx];
  if (!item) return;
  const { entry, ex } = item;
  const inp = el('cd-input');
  const trimmed = inp.value.trim();
  const drillStrict = cd.isTypoDrill ? (cd.typoMode !== 'real') : userStore.settings.strictDiacritics;
  const res = trimmed ? classifyAnswer(trimmed, entry, ex, { strictDiacritics: drillStrict }) : { accepted: false, kind: 'wrong' };

  let typoGradNote = '';
  if (cd.isTypoDrill && item.typoKey) {
    const isCleanSpelling = Boolean(res.accepted && (cd.typoMode === 'real'
      ? (res.kind === 'exact' || res.kind === 'diacritic_accepted' || res.kind === 'diacritic_collision_accepted')
      : res.kind === 'exact'));
    const updated = await recordTypoDrillAttempt(item.typoKey, isCleanSpelling);
    if (updated && updated.graduated) typoGradNote = ' (Graduated!)';
    else if (updated && isCleanSpelling) typoGradNote = ` (${updated.cleanStreak}/2)`;
  }

  cd.revealed = true;
  cd.manualPlayCount = 0;
  cd.lastPhase = 'post';
  renderProgressiveAudioBtn(el('btn-cd-audio'), 'Replay', 0, 15);
  const cdUserTyped = res.accepted ? (res.typed || trimmed) : '';
  renderClozeSentence(el('cd-pt-box'), ex, {
    revealed: true, gapState: res.accepted ? '' : 'wrong', lemmaId: entry.id, userTyped: cdUserTyped
  });
  const cdTargets = { bannerId: 'cd-feedback', msgId: 'cd-feedback-msg', subId: 'cd-feedback-sub', overrideId: null };
  if (res.accepted) {
    cd.correct += 1;
    const isExactOrLenient = res.kind === 'exact' || ((res.kind === 'diacritic_accepted' || res.kind === 'diacritic_collision_accepted') && !drillStrict);
    renderFeedbackBanner({
      tone: isExactOrLenient ? 'ok' : 'soft_ok',
      statusText: (isExactOrLenient ? '✓ Correct' : '✓ Accepted') + typoGradNote,
      wordText: res.matched || ex.answer,
      userTyped: cdUserTyped,
      lemmaId: entry.id,
      showNotes: true,
      ex,
      entry
    }, cdTargets);
    el('btn-cd-submit').className = isExactOrLenient ? 'btn btn-emerald' : 'btn btn-mint-soft';
  } else {
    renderFeedbackBanner({
      tone: 'error',
      statusText: 'Answer:',
      wordText: ex.answer,
      lemmaId: entry.id,
      showNotes: true,
      ex,
      entry
    }, cdTargets);
    el('btn-cd-submit').className = 'btn btn-rose';
  }
  el('btn-cd-submit').textContent = 'Next';
  scrollFeedbackBannerIntoView('cd-feedback');
  if (userStore.settings.autoPlay) speakClozeCard(ex, true, { rate: getNormalSpeechRate(), keepVoice: true });
}

export function closeClusterDrill() {
  stopTTS();
  State.clusterDrill = null;
  el('view-cluster-drill').classList.add('hidden');
  if (navState.view === 'drills') {
    renderDrillsHub();
  } else if ((navState.view === 'session' || navState.view === 'drill') && !userStore.settings.walkMode && session.activeItem) {
    focusAnswerInput();
  }
}

export function handleFinaleBackClick() {
  const inSummary = !el('panel-done').classList.contains('hidden');
  if (inSummary) { appActions.navigateTo('home'); return; }
  const inBlind = !el('panel-blind').classList.contains('hidden');
  if (inBlind && session.blindIdx > 0) {
    stopTTS();
    session.blindIdx -= 1;
    renderBlindStep();
    return;
  }
  stopTTS();
  el('modal-pause-session').classList.remove('hidden');
}

export async function handleStudyBackClick() {
  if (session.mode === 'round1' && Array.isArray(session.round1Items) && session.round1Idx > 0) {
    session.round1Idx -= 1;
    session.round1Queue = session.round1Items.slice(session.round1Idx + 1);
    const prevItem = session.round1Items[session.round1Idx];
    if (prevItem) {
      mountStudyItem(prevItem);
      showToast('Returned to previous word');
      return;
    }
  }
  if ((session.mode === 'study' || session.mode === 'check_known') && session.activeItem && (session.needsCorrection || session.revealed) && session.undoStack.length > 0) {
    const topSnap = session.undoStack[session.undoStack.length - 1];
    const curExId = session.activeItem.ex && session.activeItem.ex.exId;
    if (topSnap && topSnap.exId === curExId && topSnap.cardKey === session.activeItem.cardKey) {
      const curSnap = session.undoStack.pop();
      session.lastPreSnapshot = null;
      await restoreSnapshot(curSnap);
      if (session.undoStack.length > 0) {
        await performUndo();
        return;
      }
      if (session.mode === 'study' && session.reviewedCount === 0) {
        stopTTS();
        clearPausedSession();
        appActions.navigateTo('home');
        return;
      }
      stopTTS();
      el('modal-pause-session').classList.remove('hidden');
      return;
    }
  }
  if ((session.mode === 'study' || session.mode === 'check_known' || session.mode === 'round1') && session.undoStack.length > 0) {
    await performUndo();
    return;
  }
  if (session.mode === 'study' && session.reviewedCount === 0) {
    stopTTS();
    clearPausedSession();
    appActions.navigateTo('home');
    return;
  }
  if (session.mode === 'round1' || session.reviewedCount > 0) {
    stopTTS();
    el('modal-pause-session').classList.remove('hidden');
    return;
  }
  stopTTS();
  appActions.navigateTo('home');
}

export function bindKeepKeyboard(btn, handler) {
  btn.addEventListener('pointerdown', e => e.preventDefault());
  btn.addEventListener('click', () => {
    handler();
    if ((navState.view === 'session' || navState.view === 'drill') && !navState.settingsOpen && !userStore.settings.walkMode) {
      el('answer-input').focus({ preventScroll: true });
    }
  });
}

export function insertAtCursor(recallInp, ch) {
  if (session.revealed) return;
  const start = recallInp.selectionStart != null ? recallInp.selectionStart : recallInp.value.length;
  const end = recallInp.selectionEnd != null ? recallInp.selectionEnd : recallInp.value.length;
  recallInp.value = recallInp.value.slice(0, start) + ch + recallInp.value.slice(end);
  const nextPos = start + ch.length;
  try { recallInp.setSelectionRange(nextPos, nextPos); } catch (_) {}
  recallInp.dispatchEvent(new Event('input', { bubbles: true }));
}
