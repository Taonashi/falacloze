import { DAY_ROLLOVER_HOUR, ICON_FEM_SVG, ICON_MASC_SVG, ICON_PLURAL_SVG, ICON_SINGULAR_SVG, SLOT_TO_TENSE_GROUP, State, TENSE_GROUPS, TURTLE_SVG, appActions, consumeToastUndo, contentStore, dailyGoalState, deepClone, el, formatPOS, formatSlot, getLogicalDay, getLogicalDayStartMs, makeTurtleIcon, navState, normNFC, placementState, session, showToast, userStore } from './state.js';
import { FSRS6, createBlankCardRecord, sanitizeRetention } from './fsrs.js';
import { autoLoadHostedFiles, buildClozeSplit, buildExportPayload, buildReportsExportJson, buildVersionedAssetUrl, cleanFilename, clearSentenceReports, computeAvailableSessionCounts, dismissConfusableRecommendation, ensureDailyRollover, exportProgress, getActiveTypoEntries, getEffectiveDailyNewCap, getEligibleExamples, getExampleFormKey, getExamplesForEntry, getFastAnswerThresholdMs, getGlossSenseClusters, getHighestReachedUnit, getLemmaStatusBadge, getManifestHashForPath, getStudiedBaseLemmaIds, handleMultipleFileUpload, idbClear, idbGetAll, idbPut, identifyUploadedJson, ingestJsonFile, initStorageDB, isCardDueNow, isClusterBlocked, isColloquialDeferred, isExampleFormKnown, isIntroReadyExample, isMultiFormEntry, isPackLoadedOrAvailable, isSentenceReported, isSiblingBuried, isValidCardKey, loadPackOrExt, makeMixupPairKey, makeTypoLogKey, mergeProgressObject, migrateFromV24IfNeeded, parseBackupJsonText, pickBestExample, preloadUpcomingPacks, putPackInCache, readFileTextResilient, rebuildContentIndexes, recordConfusableMixup, recordTypoDrillAttempt, recordTypoEvent, resolveExampleSenseCluster, saveCellStats, saveMixups, saveSentenceReport, saveSettings, saveToday, saveTypoLog } from './storage.js';
import { ICON_BOOK_CLOSED_SVG, ICON_EYE_OFF_SVG, ICON_EYE_SVG, buildGenderPill, buildNumberPill, buildPosPill, buildSlotPill, buildUnifiedPostAnswerSub, classifyAnswer, classifyAnswerWithPrefix, damerauLevenshtein, formatLexiconDisplayLemma, formatRecallTag, getSlotPillClass, isBlindAudioEligible, isColloquialContextDeferred, isDiacriticOnlyDiff, mountExample, normalizeColloquialContext, renderClozeSentence, renderCorrectedWordWithHighlight, renderCorrectionProgress, renderFeedbackBanner, renderHighlightedEnglish, renderMask, renderRichGrammarNote, resolveEntryBaseGender, resolveGrammaticalTags, resolveLexiconLemmaIdForToken, stripRedundantGenderNumberHint, updateLiveBlankMirror } from './grading.js';
import { bindProgressiveExampleBtn, cancelSpeech, clearSpokenLog, getLastSpokenLog, getNormalSpeechRate, initTTS, pickPitch, playCorrectChime, playSummaryChord, renderProgressiveAudioBtn, speakClozeCard, speakClozeItem, speakPT, stopTTS, stripOrphanedTtsPunct, unlockSoundEffects } from './tts.js';
import { COVERAGE_PREVIEW_PT, SESSION_PRESETS, animateCoverageReturn, applyPlacement, bindSessionOptionsDrag, cancelCoverageReturnAnim, closeSessionOptionsSheet, computePlacementCutoff, computeSessionDurationEstimate, easeCubicBezier, getCoverageLastUserWords, normalizeSessionSize, openPlacementModal, openSessionOptionsSheet, renderCoverageCurve, renderHome, renderPlacementDiagnostic, resolveCoverageTokenRank, samplePlacementWords, startCheckKnownSession, updateAfterPills, wordsToCoverageFloat, wordsToCoveragePct } from './views/home.js';
import { CONFUSABLE_PAIRS, LOW_WORKLOAD_THRESHOLD, advanceRevealedPrefix, advanceStudy, applyBlindAudioMissSrs, bindKeepKeyboard, cancelRecallReturnDwellAndFocusNext, captureSnapshot, clearPausedSession, closeClusterDrill, closeReportModal, closeSessionHistoryModal, commitReview, computeTopUpDelta, dripInFormSubCard, focusAnswerInput, focusClusterDrillInput, getActiveFinaleModes, getAllConfusableGroupsByUnit, getConfusableGroup, getConfusableRecommendations, getSeenMainExIdSet, handleAlreadyKnowClick, handleFinaleBackClick, handleHint, handleOverrideWrong, handlePrimarySubmit, handleStudyBackClick, handleVisibilityChange, insertAtCursor, makeSessionLogKey, matchRecallTile, maybeRecordConfusableMixup, mountStudyItem, openReportModal, openSessionHistoryModal, performUndo, persistPausedSession, pickNextStudyItem, renderBlindStep, renderDrillRecommendationCard, renderDrillsHub, renderHomeDrillRec, resolveAllSessionItems, revealPostAnswerNotes, scrollFeedbackBannerIntoView, scrollRecallTileIntoView, scrollToNextUnsolvedRecallTile, setPrimaryAction, setReportReason, showDoneSummary, startBlindAudio, startClusterDrill, startRecallTiles, startStudySession, startTypoDrill, startVerbDrill, submitClusterDrillAnswer, submitSentenceReport, syncAudioControlsVisibility, syncClusterLegendUI, syncDiacriticsBarVisibility, syncSfxButtonUI, triggerClozeAudio, updateSessionHeader } from './views/session.js';
import { SPOKEN_VERB_PARENTS, VOCAB_FILTER_DESCRIPTIONS, closeWordDetailModal, executeBulkAction, getFilteredVocabEntries, getSpokenParentEntry, navigateTo, openVocab, openWordDetail, openWordDetailsModal, pushHistory, renderRoute, renderSettings, renderVocabList, renderVoicesSettings, resolveVerbDrillTarget, speakVocabWord, toggleVocabSelection } from './views/dictionary.js';

Object.assign(appActions, {
  renderHome,
  renderSettings,
  renderVoicesSettings,
  openWordDetail,
  openWordDetailsModal,
  navigateTo,
  pushHistory,
  renderRoute,
  openVocab,
  advanceStudy,
  mountStudyItem,
  startStudySession,
  startVerbDrill,
  focusAnswerInput,
  updateSessionHeader,
  closeClusterDrill,
  renderDrillsHub,
  renderHomeDrillRec,
  initTTS,
});

initTTS();

window.addEventListener('error', e => showToast('Error: ' + (e && e.message ? e.message : 'Unexpected issue')));
window.addEventListener('unhandledrejection', e => {
  const msg = e && e.reason ? (e.reason.message || String(e.reason)) : 'Async error';
  showToast('Notice: ' + msg);
});

window.addEventListener('popstate', async () => {
  // 1. Close open modals/sheets/Settings first (restoring Vocab scroll position)
  if (!el('modal-word-details').classList.contains('hidden')) {
    el('modal-word-details').classList.add('hidden');
    if (navState.view === 'vocab') el('vocab-list').scrollTop = State.vocabScrollTop;
    else if ((navState.view === 'session' || navState.view === 'drill') && !userStore.settings.walkMode && session.activeItem) focusAnswerInput();
    return;
  }
  if (!el('view-cluster-drill').classList.contains('hidden')) { closeClusterDrill(); return; }
  if (el('modal-report-sentence') && !el('modal-report-sentence').classList.contains('hidden')) { closeReportModal(); return; }
  if (!el('modal-session-history').classList.contains('hidden')) { closeSessionHistoryModal(); return; }
  if (!el('modal-pause-session').classList.contains('hidden')) { el('modal-pause-session').classList.add('hidden'); return; }
  if (!el('modal-paste-backup').classList.contains('hidden')) { el('modal-paste-backup').classList.add('hidden'); return; }
  if (!el('modal-daily-limit').classList.contains('hidden')) { el('modal-daily-limit').classList.add('hidden'); return; }
  if (!el('modal-placement').classList.contains('hidden')) { el('modal-placement').classList.add('hidden'); return; }
  if (el('sheet-session-options') && el('sheet-session-options').classList.contains('is-open')) { closeSessionOptionsSheet(); return; }
  if (!el('sheet-session-menu').classList.contains('hidden')) { el('sheet-session-menu').classList.add('hidden'); return; }
  if (navState.settingsOpen) {
    const inSession = navState.view === 'session' || navState.view === 'drill';
    renderRoute(navState.view, false);
    if (inSession && !userStore.settings.walkMode && session.activeItem) focusAnswerInput();
    return;
  }
  // 2. Hardware back on study screen pauses session & returns Home
  if (navState.view === 'session' || navState.view === 'drill') {
    if (session.mode === 'study') { await persistPausedSession(); showToast('Session paused & saved'); }
    renderRoute('home', false);
    return;
  }
  if (navState.view !== 'home') renderRoute('home', false);
});


function bindEvents() {
  el('toast-undo-btn').addEventListener('click', () => {
    const fn = consumeToastUndo(); if (fn) { el('toast').classList.remove('show'); fn(); }
  });

  if (el('btn-home-nav-drills')) el('btn-home-nav-drills').addEventListener('click', () => navigateTo('drills'));
  if (el('btn-drills-back')) el('btn-drills-back').addEventListener('click', () => navigateTo('home'));
  if (el('typo-mode-group')) {
    el('typo-mode-group').querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        userStore.settings.typoTrainerMode = btn.dataset.typoMode === 'real' ? 'real' : 'all';
        saveSettings();
        renderDrillsHub();
      });
    });
  }
  if (el('btn-start-typo-drill')) el('btn-start-typo-drill').addEventListener('click', () => startTypoDrill());
  el('btn-home-nav-vocab').addEventListener('click', () => openVocab({ bucket: 'studied' }));
  el('btn-home-nav-settings').addEventListener('click', () => { pushHistory('settings'); renderRoute(navState.view, true); });
  el('home-cnt-due').addEventListener('click', () => openVocab({ bucket: 'due' }));
  el('home-cnt-learning').addEventListener('click', () => openVocab({ bucket: 'review' }));
  el('home-cnt-mastered').addEventListener('click', () => openVocab({ bucket: 'known' }));

  el('btn-start-study').addEventListener('click', () => startStudySession(null));
  el('btn-resume-session').addEventListener('click', () => { if (userStore.activeSession) startStudySession(userStore.activeSession); });
  el('btn-discard-session').addEventListener('click', async () => { await clearPausedSession(); renderHome(); showToast('Paused session discarded'); });
  el('btn-open-placement').addEventListener('click', openPlacementModal);
  el('btn-placement-close').addEventListener('click', () => el('modal-placement').classList.add('hidden'));
  const skipPlaceBtn = el('btn-placement-skip');
  if (skipPlaceBtn) skipPlaceBtn.addEventListener('click', () => el('modal-placement').classList.add('hidden'));
  const covSlider = el('coverage-slider');
  if (covSlider) {
    covSlider.addEventListener('pointerdown', cancelCoverageReturnAnim);
    covSlider.addEventListener('touchstart', cancelCoverageReturnAnim, { passive: true });
    covSlider.addEventListener('input', () => {
      cancelCoverageReturnAnim();
      const pct = Number(covSlider.value) || 0;
      const w = Math.round((pct / 100) * 5000);
      renderCoverageCurve(w, getCoverageLastUserWords(), false);
    });
  }
  const covSnapBtn = el('btn-coverage-snap-user');
  if (covSnapBtn) {
    covSnapBtn.addEventListener('click', () => {
      const uWords = getStudiedBaseLemmaIds().length;
      animateCoverageReturn(uWords, 560);
    });
  }
  el('btn-apply-placement').addEventListener('click', () => applyPlacement(null));
  const more10Btn = el('btn-placement-more10');
  if (more10Btn) {
    more10Btn.addEventListener('click', () => {
      const existing = new Set(placementState.items.map(e => e.id));
      const extra = samplePlacementWords(10, existing);
      placementState.items = [...placementState.items, ...extra].sort((a, b) => a.curriculumIndex - b.curriculumIndex);
      renderPlacementDiagnostic();
    });
  }
  const closeDailyLimitModal = () => el('modal-daily-limit').classList.add('hidden');
  el('btn-dl-close').addEventListener('click', closeDailyLimitModal);
  el('btn-dl-not-now').addEventListener('click', () => {
    closeDailyLimitModal();
    if (dailyGoalState.modalMode === 'low_workload') startStudySession(null, { bypassLowWorkload: true });
  });
  el('btn-dl-add-10').addEventListener('click', async () => {
    const delta = Math.max(1, Number(dailyGoalState.addDelta) || 10);
    userStore.today.bonusNew = (Number(userStore.today.bonusNew) || 0) + delta;
    await saveToday();
    closeDailyLimitModal();
    showToast(`Added ${delta} new card${delta === 1 ? '' : 's'}`);
    renderHome();
    startStudySession(null);
  });
  el('btn-check-known').addEventListener('click', startCheckKnownSession);

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', unlockSoundEffects, { once: true, passive: true });
    document.addEventListener('keydown', unlockSoundEffects, { once: true, passive: true });
  }
  if (el('btn-session-options')) {
    el('btn-session-options').addEventListener('click', evt => {
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      openSessionOptionsSheet();
    });
  }
  if (el('btn-session-options-done')) {
    el('btn-session-options-done').addEventListener('click', evt => {
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      closeSessionOptionsSheet();
    });
  }
  if (el('sheet-session-options')) {
    el('sheet-session-options').addEventListener('click', evt => {
      if (evt.target === el('sheet-session-options')) closeSessionOptionsSheet();
    });
  }
  bindSessionOptionsDrag();
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', evt => {
      if (evt.key === 'Escape' && el('sheet-session-options') && el('sheet-session-options').classList.contains('is-open')) {
        closeSessionOptionsSheet();
      }
    });
  }
  el('home-len-chips').querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      userStore.settings.sessionSize = normalizeSessionSize(btn.dataset.len);
      saveSettings(); renderHome();
    });
  });
  if (el('home-post-toggles')) {
    el('home-post-toggles').querySelectorAll('[data-post-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.postMode;
        if (mode === 'fix') {
          userStore.settings.enableFixRound = !(userStore.settings.enableFixRound !== false);
        } else if (mode === 'recall' || mode === 'blind') {
          const cur = [...getActiveFinaleModes()];
          const idx = cur.indexOf(mode);
          if (idx === -1) cur.push(mode); else cur.splice(idx, 1);
          userStore.settings.finaleModes = cur;
        }
        saveSettings();
        renderHome();
        if (navState.settingsOpen) renderSettings();
      });
    });
  }

  el('toggle-walk').addEventListener('click', () => { userStore.settings.walkMode = !userStore.settings.walkMode; saveSettings(); renderHome(); });
  el('input-import-files').addEventListener('change', e => { handleMultipleFileUpload(e.target.files); e.target.value = ''; });
  el('input-import-folder').addEventListener('change', e => { handleMultipleFileUpload(e.target.files); e.target.value = ''; });

  let armedResetContent = false;
  el('btn-reset-content').addEventListener('click', async () => {
    if (!armedResetContent) {
      armedResetContent = true; el('btn-reset-content').textContent = 'Tap again to clear imported files';
      setTimeout(() => { armedResetContent = false; el('btn-reset-content').textContent = 'Reset Imported Content'; }, 3500);
      return;
    }
    armedResetContent = false; el('btn-reset-content').textContent = 'Reset Imported Content';
    await idbClear('customFiles');
    contentStore.customFiles.clear(); contentStore.packCache.clear();
    contentStore.availablePackIds.clear(); contentStore.availableExtIds.clear();
    contentStore.manifest = null; contentStore.lexicon = null; contentStore.curriculum = null; contentStore.ambiguous = null;
    contentStore.legacyMode = false;
    rebuildContentIndexes(); renderHome();
    showToast('Imported content cleared (FSRS progress kept)');
  });

  // Study Header: Big Top-Left Back = Previous Word (performUndo), Right = SFX + Settings + Menu
  bindKeepKeyboard(el('btn-prev-word'), handleStudyBackClick);
  if (el('btn-session-sfx')) {
    el('btn-session-sfx').addEventListener('click', () => {
      userStore.settings.soundEffects = !(userStore.settings.soundEffects !== false);
      if (userStore.settings.soundEffects) unlockSoundEffects();
      saveSettings();
      syncSfxButtonUI();
      if (navState.settingsOpen) renderSettings();
    });
  }
  if (el('btn-report-sentence')) {
    el('btn-report-sentence').addEventListener('click', () => openReportModal());
  }
  el('btn-session-settings').addEventListener('click', () => { pushHistory('settings'); renderRoute(navState.view, true); });
  el('btn-session-menu').addEventListener('click', () => {
    pushHistory('menu');
    el('btn-sheet-finish').classList.toggle('hidden', session.mode !== 'study' || session.reviewedCount < 1);
    el('sheet-session-menu').classList.remove('hidden');
  });
  el('sheet-session-menu').addEventListener('click', e => {
    if (e.target === el('sheet-session-menu')) el('sheet-session-menu').classList.add('hidden');
  });
  el('btn-sheet-details').addEventListener('click', () => {
    el('sheet-session-menu').classList.add('hidden');
    if (session.activeItem) openWordDetailsModal(session.activeItem.entry);
  });
  el('btn-sheet-suspend').addEventListener('click', async () => {
    el('sheet-session-menu').classList.add('hidden');
    if (!session.activeItem) return;
    const { cardKey, entry } = session.activeItem;
    const rec = userStore.cards.has(cardKey) ? deepClone(userStore.cards.get(cardKey)) : createBlankCardRecord(cardKey);
    rec.suspended = true; rec.updatedAt = Date.now();
    userStore.cards.set(cardKey, rec);
    await idbPut('cards', rec);
    showToast(`Suspended "${entry.lemma}"`);
    await advanceStudy();
  });
  el('btn-sheet-finish').addEventListener('click', async () => {
    el('sheet-session-menu').classList.add('hidden');
    await clearPausedSession();
    session.reviewedCount = session.targetCount;
    await advanceStudy();
  });
  el('btn-sheet-exit').addEventListener('click', async () => {
    el('sheet-session-menu').classList.add('hidden');
    if (session.mode === 'study') await persistPausedSession();
    navigateTo('home');
  });

  // Tap card or blank to focus keyboard
  el('sc-card-box').addEventListener('click', focusAnswerInput);

  // Persistent #answer-input with IME composition + 180ms Android ghost-commit guard
  const recallInp = el('answer-input');
  recallInp.addEventListener('compositionstart', () => { session.isComposing = true; });
  recallInp.addEventListener('compositionend', () => { session.isComposing = false; onAnswerInput(); });

  function onAnswerInput() {
    if (!session.activeItem) return;
    if (session.revealed && !session.needsCorrection) { recallInp.value = ''; return; }
    if (session.lastSubmittedVal && (Date.now() - session.cardOpenedAt) < 180 &&
        normNFC(recallInp.value) === normNFC(session.lastSubmittedVal)) {
      recallInp.value = '';
      mountExample(el('sc-pt-box'), session.activeItem.ex, {
        revealed: false, typed: '', revealedPrefixLen: session.revealedPrefixLen, onGapTap: focusAnswerInput
      });
      setPrimaryAction(session.needsCorrection ? 'check' : 'dont_know');
      return;
    }
    if (session.firstKeystrokeMs === null && recallInp.value.length > 0) {
      session.firstKeystrokeMs = session.timerAccumMs + (session.timerStartMs ? Date.now() - session.timerStartMs : 0);
    }
    if (session.needsCorrection) {
      session.dontKnowSkipArmed = false;
      renderCorrectionProgress(el('sc-pt-box'), session.activeItem.ex, recallInp.value);
      setPrimaryAction(recallInp.value.trim().length > 0 ? 'check' : 'check_soft');
      return;
    }
    setPrimaryAction(recallInp.value.trim().length > 0 ? 'check' : 'dont_know');
    updateLiveBlankMirror(el('sc-pt-box'), session.activeItem.ex, recallInp.value, {
      revealedPrefixLen: session.revealedPrefixLen, onGapTap: focusAnswerInput
    });
  }

  recallInp.addEventListener('input', onAnswerInput);
  recallInp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !session.isComposing) { e.preventDefault(); handlePrimarySubmit(); }
  });

  el('diacritic-bar').querySelectorAll('.diac-key').forEach(btn => {
    bindKeepKeyboard(btn, () => insertAtCursor(recallInp, btn.dataset.ch));
  });
  const rDiac = el('recall-diacritic-bar');
  if (rDiac) {
    rDiac.querySelectorAll('.diac-key').forEach(btn => {
      btn.addEventListener('pointerdown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        const ri = el('recall-input');
        const st = ri.selectionStart != null ? ri.selectionStart : ri.value.length;
        const en = ri.selectionEnd != null ? ri.selectionEnd : ri.value.length;
        ri.value = ri.value.slice(0, st) + btn.dataset.ch + ri.value.slice(en);
        try { ri.setSelectionRange(st + btn.dataset.ch.length, st + btn.dataset.ch.length); } catch (_) {}
        ri.dispatchEvent(new Event('input', { bubbles: true }));
        ri.focus({ preventScroll: true });
      });
    });
  }
  document.addEventListener('visibilitychange', handleVisibilityChange);

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.code === 'Space' && (navState.view === 'session' || navState.view === 'drill') && !navState.settingsOpen) {
      e.preventDefault();
      if (session.activeItem) triggerClozeAudio();
    }
  });

  bindKeepKeyboard(el('btn-primary-action'), handlePrimarySubmit);
  bindKeepKeyboard(el('btn-hint'), handleHint);
  bindKeepKeyboard(el('btn-override-wrong'), handleOverrideWrong);
  el('btn-cd-back').addEventListener('click', closeClusterDrill);
  el('btn-cd-return').addEventListener('click', closeClusterDrill);
  el('btn-cd-again').addEventListener('click', () => {
    const cd = State.clusterDrill;
    if (!cd) return;
    if (cd.isTypoDrill) startTypoDrill(cd.typoMode);
    else startClusterDrill(cd.group);
  });
  el('btn-cd-submit').addEventListener('click', submitClusterDrillAnswer);
  const cdLegendBtn = el('btn-cluster-legend-toggle');
  if (cdLegendBtn) {
    cdLegendBtn.addEventListener('click', () => {
      if (!State.clusterDrill) return;
      State.clusterDrill.legendVisible = !State.clusterDrill.legendVisible;
      syncClusterLegendUI();
    });
  }
  el('cd-card-box').addEventListener('click', () => {
    if (State.clusterDrill && !State.clusterDrill.revealed) focusClusterDrillInput();
  });
  el('cd-input').addEventListener('input', () => {
    const cd = State.clusterDrill;
    if (!cd || cd.revealed || !cd.queue[cd.idx]) return;
    updateLiveBlankMirror(el('cd-pt-box'), cd.queue[cd.idx].ex, el('cd-input').value, { onGapTap: focusClusterDrillInput });
  });
  el('cd-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitClusterDrillAnswer(); } });
  el('btn-cd-audio').addEventListener('click', () => {
    const cd = State.clusterDrill;
    if (!cd || !cd.queue[cd.idx]) return;
    cd.manualPlayCount += 1;
    const rate = cd.manualPlayCount >= 2 ? 0.75 : getNormalSpeechRate();
    renderProgressiveAudioBtn(el('btn-cd-audio'), cd.revealed ? 'Replay' : 'Listen', cd.manualPlayCount, 15);
    speakClozeCard(cd.queue[cd.idx].ex, cd.revealed, { rate, keepVoice: true });
  });
  const cdDiac = el('cd-diacritic-bar');
  if (cdDiac) {
    cdDiac.querySelectorAll('.diac-key').forEach(btn => {
      btn.addEventListener('pointerdown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        const ci = el('cd-input');
        const st = ci.selectionStart != null ? ci.selectionStart : ci.value.length;
        const en = ci.selectionEnd != null ? ci.selectionEnd : ci.value.length;
        ci.value = ci.value.slice(0, st) + btn.dataset.ch + ci.value.slice(en);
        try { ci.setSelectionRange(st + btn.dataset.ch.length, st + btn.dataset.ch.length); } catch (_) {}
        ci.dispatchEvent(new Event('input', { bubbles: true }));
        ci.focus({ preventScroll: true });
      });
    });
  }
  bindKeepKeyboard(el('btn-replay-audio'), triggerClozeAudio);

  bindKeepKeyboard(el('btn-known'), handleAlreadyKnowClick);

  // Walk mode
  el('btn-walk-reveal').addEventListener('click', () => {
    if (!session.activeItem) return;
    const { entry, ex } = session.activeItem;
    session.revealed = true;
    mountExample(el('sc-pt-box'), ex, { revealed: true, lemmaId: entry.id });
    revealPostAnswerNotes(entry, ex);
    syncAudioControlsVisibility();
    el('btn-walk-reveal').classList.add('hidden');
    el('walk-grade-row').classList.remove('hidden');
    if (userStore.settings.autoPlay) speakClozeItem(ex, true);
  });
  el('btn-walk-again').addEventListener('click', async () => { if (session.activeItem && Date.now() >= session.transitionLockUntil) { await commitReview(captureSnapshot(), 1); await advanceStudy(); } });
  el('btn-walk-good').addEventListener('click', async () => { if (session.activeItem && Date.now() >= session.transitionLockUntil) { await commitReview(captureSnapshot(), 3); await advanceStudy(); } });
  el('btn-walk-undo').addEventListener('click', performUndo);
  el('btn-walk-audio').addEventListener('click', triggerClozeAudio);

  // Finale controls (Blind Audio speaks WORDS only; Sentence reveal box has on-demand buttons)
  el('btn-finale-back').addEventListener('click', handleFinaleBackClick);
  const closePauseModal = () => {
    el('modal-pause-session').classList.add('hidden');
    if ((navState.view === 'session' || navState.view === 'drill') && !userStore.settings.walkMode && session.activeItem) focusAnswerInput();
  };
  el('btn-pause-close').addEventListener('click', closePauseModal);
  el('btn-pause-keep').addEventListener('click', closePauseModal);
  el('btn-pause-exit').addEventListener('click', async () => {
    el('modal-pause-session').classList.add('hidden');
    await persistPausedSession();
    showToast('Session paused & saved');
    navigateTo('home');
  });
  el('btn-finale-skip').addEventListener('click', () => {
    if (session.blindChainItems && session.blindChainItems.length > 0 && !el('panel-blind').classList.contains('hidden')) startRecallTiles(session.blindChainItems);
    else showDoneSummary();
  });
  if (el('btn-recall-skip')) {
    el('btn-recall-skip').addEventListener('click', () => {
      stopTTS();
      showDoneSummary();
    });
  }
  if (el('btn-done-next-session')) {
    el('btn-done-next-session').addEventListener('click', () => startStudySession(null));
  }
  el('btn-done-home').addEventListener('click', () => navigateTo('home'));
  el('btn-blind-play').addEventListener('click', () => {
    const it = session.blindQueue[session.blindIdx];
    if (!it) return;
    session.blindWordPlayCount += 1;
    const rate = session.blindWordPlayCount >= 2 ? 0.75 : getNormalSpeechRate();
    renderProgressiveAudioBtn(el('btn-blind-play'), '', session.blindWordPlayCount, 26);
    speakPT(it.ex.answer, { rate, keepVoice: true });
  });
  el('btn-blind-sent-play').addEventListener('click', () => {
    const it = session.blindQueue[session.blindIdx];
    if (!it) return;
    session.blindSentPlayCount += 1;
    const rate = session.blindSentPlayCount >= 2 ? 0.75 : getNormalSpeechRate();
    renderProgressiveAudioBtn(el('btn-blind-sent-play'), 'Sentence', session.blindSentPlayCount, 15);
    speakPT(normalizeColloquialContext(it.ex).pt, { rate, keepVoice: true });
  });
  el('btn-blind-next').addEventListener('click', () => { session.blindIdx += 1; renderBlindStep(); });

  const rInp = el('recall-input');
  rInp.addEventListener('input', () => {
    clearTimeout(session.recallTimer);
    if (rInp.value.trim().length > 0) cancelRecallReturnDwellAndFocusNext();
    matchRecallTile(rInp.value, false);
  });
  rInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (session.recallTiles.length > 0 && session.recallTiles.every(t => t.solved)) showDoneSummary(); else matchRecallTile(rInp.value, true); } });
  const rSub = el('btn-recall-submit');
  if (rSub) {
    rSub.addEventListener('pointerdown', e => e.preventDefault());
    rSub.addEventListener('click', () => {
      clearTimeout(session.recallTimer);
      matchRecallTile(rInp.value, true);
      if (!session.recallTiles.every(t => t.solved)) rInp.focus({ preventScroll: true });
    });
  }
  el('btn-recall-done').addEventListener('click', showDoneSummary);
  if (el('btn-summary-history')) el('btn-summary-history').addEventListener('click', openSessionHistoryModal);
  if (el('btn-session-history-close')) el('btn-session-history-close').addEventListener('click', closeSessionHistoryModal);
  if (el('modal-session-history')) {
    el('modal-session-history').addEventListener('click', e => {
      if (e.target === el('modal-session-history')) closeSessionHistoryModal();
    });
  }

  // Vocab (100ms debounced search + Bulk Select controls)
  el('btn-vocab-back').addEventListener('click', () => navigateTo('home'));
  let vocabSearchTimer = null;
  el('vocab-search').addEventListener('input', () => {
    clearTimeout(vocabSearchTimer);
    vocabSearchTimer = setTimeout(renderVocabList, 100);
  });
  el('btn-vocab-clear').addEventListener('click', () => { el('vocab-search').value = ''; renderVocabList(); el('vocab-search').focus(); });
  el('vocab-tabs').querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => { navState.vocabBucket = btn.dataset.bucket; renderVocabList(); });
  });
  el('btn-toggle-bulk').addEventListener('click', () => {
    State.vocabSelectMode = !State.vocabSelectMode;
    if (!State.vocabSelectMode) State.vocabSelected.clear();
    renderVocabList();
  });
  el('btn-bulk-select-all').addEventListener('click', () => {
    getFilteredVocabEntries().forEach(e => State.vocabSelected.add(e.id));
    renderVocabList();
  });
  el('btn-bulk-clear').addEventListener('click', () => { State.vocabSelected.clear(); State.vocabSelectMode = false; renderVocabList(); });
  el('btn-bulk-known').addEventListener('click', () => executeBulkAction('known', false));
  el('btn-bulk-to-learn').addEventListener('click', () => executeBulkAction('to_learn', false));
  el('btn-bulk-suspend').addEventListener('click', () => executeBulkAction('suspend', false));
  el('btn-bulk-confirm-go').addEventListener('click', () => {
    if (State.pendingBulkAction) executeBulkAction(State.pendingBulkAction, true);
  });

  // Settings
  el('btn-settings-close').addEventListener('click', () => {
    const inSession = navState.view === 'session' || navState.view === 'drill';
    renderRoute(navState.view, false);
    syncDiacriticsBarVisibility();
    if (inSession && !userStore.settings.walkMode && session.activeItem) focusAnswerInput();
  });
  el('toggle-strict-diacritics').addEventListener('click', () => { userStore.settings.strictDiacritics = !userStore.settings.strictDiacritics; saveSettings(); renderSettings(); });
  el('toggle-hide-diacritics').addEventListener('click', () => {
    userStore.settings.hideDiacriticsBar = !userStore.settings.hideDiacriticsBar;
    saveSettings(); syncDiacriticsBarVisibility(); renderSettings();
  });
  const defColBtn = el('toggle-defer-colloquial');
  if (defColBtn) defColBtn.addEventListener('click', () => {
    userStore.settings.deferColloquial = !userStore.settings.deferColloquial;
    saveSettings(); renderSettings(); renderHome();
  });
  el('max-attempts-group').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      userStore.settings.maxAttempts = btn.dataset.attempts === 'unlimited' ? 'unlimited' : 3;
      saveSettings(); renderSettings();
    });
  });
  if (el('toggle-fix-round')) {
    el('toggle-fix-round').addEventListener('click', () => {
      userStore.settings.enableFixRound = !(userStore.settings.enableFixRound !== false);
      saveSettings(); renderSettings(); renderHome();
    });
  }
  el('finale-mode-group').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.finale;
      const cur = [...getActiveFinaleModes()];
      const idx = cur.indexOf(m);
      if (idx === -1) cur.push(m); else cur.splice(idx, 1);
      userStore.settings.finaleModes = cur;
      saveSettings(); renderSettings(); renderHome();
    });
  });
  if (el('toggle-sound-effects')) {
    el('toggle-sound-effects').addEventListener('click', () => {
      userStore.settings.soundEffects = !(userStore.settings.soundEffects !== false);
      if (userStore.settings.soundEffects) unlockSoundEffects();
      saveSettings(); syncSfxButtonUI(); renderSettings();
    });
  }
  el('toggle-autoplay').addEventListener('click', () => { userStore.settings.autoPlay = !userStore.settings.autoPlay; saveSettings(); renderSettings(); });
  el('toggle-rotate-voices').addEventListener('click', () => { userStore.settings.rotateVoices = !userStore.settings.rotateVoices; saveSettings(); renderSettings(); });
  el('toggle-vary-pitch').addEventListener('click', () => { userStore.settings.varyPitch = !(userStore.settings.varyPitch !== false); saveSettings(); renderSettings(); });
  el('pitch-range-group').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      userStore.settings.pitchRange = btn.dataset.pitchRange === 'wide' ? 'wide' : 'subtle';
      saveSettings(); renderSettings();
    });
  });
  el('set-new-lemmas').addEventListener('change', e => {
    userStore.settings.dailyNewLimit = Math.max(1, parseInt(e.target.value, 10) || 10);
    saveSettings();
    renderHome();
  });
  el('set-retention').addEventListener('wheel', () => {
    if (document.activeElement === el('set-retention')) el('set-retention').blur();
  }, { passive: true });
  el('set-retention').addEventListener('input', e => {
    const preview = sanitizeRetention(e.target.value, userStore.settings.desiredRetention);
    el('set-retention-val').textContent = preview.toFixed(2);
  });
  el('set-retention').addEventListener('change', e => {
    const saved = sanitizeRetention(e.target.value, userStore.settings.desiredRetention);
    userStore.settings.desiredRetention = saved;
    e.target.value = saved.toFixed(2);
    el('set-retention-val').textContent = saved.toFixed(2);
    saveSettings();
  });

  el('btn-standalone-blind').addEventListener('click', async () => {
    const pool = [];
    for (const entry of contentStore.orderedEntries.slice(0, 120)) {
      if (!isPackLoadedOrAvailable(entry.packId)) continue;
      const exs = await getEligibleExamples(entry);
      const ok = exs.find(ex => isBlindAudioEligible(entry, ex));
      if (ok) pool.push({ entry, ex: ok });
      if (pool.length >= 12) break;
    }
    if (pool.length === 0) { showToast('No Blind Audio eligible items loaded yet.'); return; }
    session.isStandaloneBlind = true;
    renderRoute('finale', false);
    startBlindAudio(pool.sort(() => Math.random() - 0.5).slice(0, 6), false);
  });

  async function importBackupText(rawText) {
    const summary = { imported: 0, skipped: 0, pruned: 0 };
    const parsed = parseBackupJsonText(rawText);
    await mergeProgressObject(parsed, { pruneUnknown: true, summary });
    renderHome();
    renderSettings();
    showToast(`Imported ${summary.imported} cards (${summary.skipped} skipped).`);
    return summary;
  }

  function formatBackupImportError(err) {
    const name = err && err.name ? err.name : 'Error';
    const msg = err && err.message ? err.message : String(err);
    return `Import failed (${name}): ${msg}`;
  }

  el('btn-export-progress').addEventListener('click', exportProgress);
  el('input-merge-progress').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const raw = await readFileTextResilient(f);
      await importBackupText(raw);
    } catch (err) {
      console.error('[FalaCloze] Backup import failed:', err);
      showToast(formatBackupImportError(err));
    }
    e.target.value = '';
  });

  const openPasteBackupBtn = el('btn-open-paste-backup');
  const closePasteBackupModal = () => el('modal-paste-backup').classList.add('hidden');
  if (openPasteBackupBtn) {
    openPasteBackupBtn.addEventListener('click', () => {
      el('input-paste-backup').value = '';
      el('modal-paste-backup').classList.remove('hidden');
      try { el('input-paste-backup').focus(); } catch (_) {}
    });
  }
  if (el('btn-paste-backup-close')) el('btn-paste-backup-close').addEventListener('click', closePasteBackupModal);
  if (el('btn-paste-backup-cancel')) el('btn-paste-backup-cancel').addEventListener('click', closePasteBackupModal);
  if (el('modal-paste-backup')) {
    el('modal-paste-backup').addEventListener('click', e => {
      if (e.target === el('modal-paste-backup')) closePasteBackupModal();
    });
  }
  if (el('btn-paste-backup-apply')) {
    el('btn-paste-backup-apply').addEventListener('click', async () => {
      try {
        await importBackupText(el('input-paste-backup').value);
        closePasteBackupModal();
      } catch (err) {
        console.error('[FalaCloze] Pasted backup import failed:', err);
        showToast(formatBackupImportError(err));
      }
    });
  }

  if (el('btn-copy-reports')) {
    el('btn-copy-reports').addEventListener('click', async () => {
      const jsonText = buildReportsExportJson();
      try {
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(jsonText);
          showToast('Copied sentence reports JSON');
          return;
        }
      } catch (_) {}
      showToast(`Prepared ${userStore.reports.length} report(s)`);
    });
  }
  if (el('btn-export-reports')) {
    el('btn-export-reports').addEventListener('click', () => {
      const blob = new Blob([buildReportsExportJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `falacloze_reports_${getLogicalDay()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Reports exported');
    });
  }
  if (el('btn-clear-reports')) {
    el('btn-clear-reports').addEventListener('click', async () => {
      await clearSentenceReports();
      renderSettings();
      if (session.activeItem && el('btn-report-sentence')) el('btn-report-sentence').classList.remove('reported');
      showToast('Sentence reports cleared');
    });
  }
  if (el('report-reasons-grid')) {
    el('report-reasons-grid').querySelectorAll('.report-reason-chip').forEach(btn => {
      btn.addEventListener('click', () => setReportReason(btn.dataset.reason));
    });
  }
  if (el('btn-report-close')) el('btn-report-close').addEventListener('click', closeReportModal);
  if (el('btn-report-cancel')) el('btn-report-cancel').addEventListener('click', closeReportModal);
  if (el('btn-report-submit')) el('btn-report-submit').addEventListener('click', submitSentenceReport);
  if (el('modal-report-sentence')) {
    el('modal-report-sentence').addEventListener('click', e => {
      if (e.target === el('modal-report-sentence')) closeReportModal();
    });
  }

  let armedReset = false;
  if (el('btn-refresh-ui')) {
    el('btn-refresh-ui').addEventListener('click', () => { forceRefreshAppUI(); });
  }
  el('btn-reset-progress').addEventListener('click', async () => {
    if (!armedReset) {
      armedReset = true; el('btn-reset-progress').textContent = 'Tap again to reset';
      setTimeout(() => { armedReset = false; el('btn-reset-progress').textContent = 'Reset Study Progress'; }, 3500);
      return;
    }
    armedReset = false; el('btn-reset-progress').textContent = 'Reset Study Progress';
    await idbClear('cards'); await idbClear('reviews');
    userStore.cards.clear(); userStore.reviews = []; userStore.cellStats = {};
    userStore.today = { day: getLogicalDay(), newLemmas: 0, clustersToday: [], reviewedLemmasToday: [], shownSentencesToday: [] };
    await clearPausedSession(); await saveToday(); await saveCellStats();
    showToast('Study progress reset.'); navigateTo('home');
  });

  el('btn-wd-close').addEventListener('click', closeWordDetailModal);
  el('modal-word-details').addEventListener('click', e => {
    if (e.target === el('modal-word-details')) closeWordDetailModal();
  });
}


export async function forceRefreshAppUI() {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all((regs || []).map(r => r.unregister().catch(() => false)));
    }
  } catch (_) {}
  try {
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      const keys = await caches.keys();
      await Promise.all((keys || []).map(k => caches.delete(k).catch(() => false)));
    }
  } catch (_) {}
  try {
    const baseHref = (typeof location !== 'undefined' && location.href) ? String(location.href) : './';
    const nextUrl = new URL(baseHref, 'https://app.local/');
    nextUrl.searchParams.set('refresh', String(Date.now()));
    const target = /^https?:|^file:/i.test(baseHref)
      ? nextUrl.toString()
      : `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    if (typeof location !== 'undefined' && typeof location.replace === 'function') {
      location.replace(target);
    }
    return target;
  } catch (_) {
    return null;
  }
}

function buildOfflineSWCode() {
  return `
    const CACHE = 'falacloze-v25-cache-m1';
    self.addEventListener('activate', e => {
      e.waitUntil(
        caches.keys()
          .then(keys => Promise.all(keys.filter(k => k.startsWith('falacloze-') && k !== CACHE).map(k => caches.delete(k))))
          .then(() => self.clients.claim())
      );
    });
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET') return;
      const url = new URL(e.request.url);
      const lowerPath = url.pathname.toLowerCase();
      // 1. manifest.json: strictly network-first (fallback to cache only when offline)
      if (lowerPath.endsWith("/manifest.json") || lowerPath === "manifest.json") {
        e.respondWith(
          fetch(e.request, { cache: 'no-store' }).then(res => {
            if (res && res.ok) {
              const cp = res.clone();
              caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {});
            }
            return res;
          }).catch(() => caches.match(e.request))
        );
        return;
      }
      // 2. Modular app HTML/CSS/JS and root shell: network-first (even with ?v= query)
      if (
        lowerPath === '/' ||
        lowerPath.endsWith('/') ||
        lowerPath.endsWith('/index.html') ||
        (lowerPath.includes('/app/') && (lowerPath.endsWith('.html') || lowerPath.endsWith('.css') || lowerPath.endsWith('.js')))
      ) {
        e.respondWith(
          fetch(e.request, { cache: 'no-cache' }).then(res => {
            if (res && res.ok) {
              const cp = res.clone();
              caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {});
            }
            return res;
          }).catch(() => caches.match(e.request).then(cached => cached || caches.match(e.request, { ignoreSearch: true })))
        );
        return;
      }
      // 3. Versioned ?v=<hash> data assets: cache-first by exact versioned URL, evicting stale ?v= entries for same pathname
      if (url.searchParams.has('v')) {
        e.respondWith(
          caches.open(CACHE).then(cache =>
            cache.match(e.request).then(cached => {
              if (cached) return cached;
              return fetch(e.request).then(res => {
                if (res && res.ok) {
                  const cp = res.clone();
                  cache.keys().then(keys =>
                    Promise.all(keys.map(k => {
                      try {
                        const ku = new URL(k.url);
                        if (ku.pathname === url.pathname && k.url !== e.request.url) return cache.delete(k);
                      } catch (_) {}
                      return null;
                    }))
                  ).then(() => cache.put(e.request, cp)).catch(() => {});
                }
                return res;
              });
            })
          )
        );
        return;
      }
      // 4. Other GET requests: cache-first with background refresh
      e.respondWith(caches.match(e.request).then(cached => {
        const net = fetch(e.request).then(res => {
          if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {}); }
          return res;
        }).catch(() => cached);
        return cached || net;
      }));
    });
  `;
}

function registerOfflineSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  try {
    const inAppDir = /\/app\//.test(location.pathname || '');
    const swUrl = inAppDir ? '../sw.js' : './sw.js';
    const swScope = inAppDir ? '../' : './';
    navigator.serviceWorker.register(swUrl, { scope: swScope, updateViaCache: 'none' }).catch(() => {});
  } catch (_) {}
}

async function boot() {
  await initStorageDB();
  const [cards, metas, reviews, customFiles, reports] = await Promise.all([
    idbGetAll('cards'), idbGetAll('meta'), idbGetAll('reviews'), idbGetAll('customFiles'), idbGetAll('reports')
  ]);
  cards.forEach(c => userStore.cards.set(c.key, c));
  userStore.reviews = reviews;
  userStore.reports = Array.isArray(reports) ? reports : [];
  function applySettingsMigrations(sObj) {
    let dirty = false;
    if ((sObj.settingsVersion || 0) < 4) {
      if (sObj.sessionSize === 'all' || sObj.sessionSize === 'ALL' || !SESSION_PRESETS.includes(Number(sObj.sessionSize))) {
        sObj.sessionSize = 20; dirty = true;
      } else {
        sObj.sessionSize = Number(sObj.sessionSize);
      }
      if (typeof sObj.enableFixRound !== 'boolean') { sObj.enableFixRound = true; dirty = true; }
      if (typeof sObj.soundEffects !== 'boolean') { sObj.soundEffects = true; dirty = true; }
      if ((sObj.settingsVersion || 0) < 3) {
        if (sObj.dailyNewLemmaCap === 15 || sObj.dailyNewLimit === 15) {
          sObj.dailyNewLimit = 10; dirty = true;
        }
        delete sObj.sessionLength;
        delete sObj.dailyNewLemmaCap;
      }
      sObj.settingsVersion = 4;
      dirty = true;
    }
    if (!Array.isArray(sObj.finaleModes)) {
      const legacy = sObj.finaleMode;
      if (legacy === 'blind') sObj.finaleModes = ['blind'];
      else if (legacy === 'recall') sObj.finaleModes = ['recall'];
      else if (legacy === 'off') sObj.finaleModes = [];
      else sObj.finaleModes = ['blind', 'recall'];
      delete sObj.finaleMode;
      dirty = true;
    }
    return dirty;
  }
  let settingsMigrated = false;
  for (const m of metas) {
    if (m.k === 'settings') {
      const savedRet = sanitizeRetention(m.v && m.v.desiredRetention, userStore.settings.desiredRetention);
      userStore.settings = { ...userStore.settings, ...m.v, desiredRetention: savedRet };
      if (typeof userStore.settings.varyPitch !== 'boolean') userStore.settings.varyPitch = true;
      settingsMigrated = applySettingsMigrations(userStore.settings);
    }
    else if (m.k === 'today') userStore.today = { ...userStore.today, ...m.v };
    else if (m.k === 'cellStats') userStore.cellStats = m.v || {};
    else if (m.k === 'typoLog') userStore.typoLog = m.v && typeof m.v === 'object' ? m.v : {};
    else if (m.k === 'mixups') userStore.mixups = m.v && typeof m.v === 'object' ? m.v : {};
    else if (m.k === 'activeSession') userStore.activeSession = m.v || null;
  }
  if (!Array.isArray(userStore.settings.unlockedTenses) || !userStore.settings.unlockedTenses.includes('pres_base')) {
    userStore.settings.unlockedTenses = ['pres_base'];
  }
  for (const cf of customFiles) {
    contentStore.customFiles.set(cf.path, cf.data);
    if (cf.path === 'manifest.json') contentStore.manifest = cf.data;
    else if (cf.path === 'lexicon.json') contentStore.lexicon = cf.data;
    else if (cf.path === 'curriculum.json') contentStore.curriculum = cf.data;
    else if (cf.path === 'ambiguous.json') contentStore.ambiguous = cf.data;
    else if (cf.path.startsWith('packs/') && cf.data && cf.data.packId) contentStore.availablePackIds.add(cf.data.packId);
    else if (cf.path.startsWith('extensions/') && cf.data && cf.data.extensionId) contentStore.availableExtIds.add(cf.data.extensionId);
  }

  if (settingsMigrated) await saveSettings();
  await migrateFromV24IfNeeded();
  ensureDailyRollover();
  rebuildContentIndexes();
  bindEvents();
  initTTS();
  renderRoute('home', false);
  registerOfflineSW();
  await autoLoadHostedFiles();
}

// Expose testable internals for ./scripts/verify_falacloze_v25.mjs
window.__FALACLOZE_V25__ = {
  identifyUploadedJson, cleanFilename, buildClozeSplit, formatSlot, formatPOS,
  damerauLevenshtein, classifyAnswer, classifyAnswerWithPrefix,
  renderMask, isBlindAudioEligible, isIntroReadyExample, advanceRevealedPrefix,
  mountStudyItem, handlePrimarySubmit, performUndo, startBlindAudio, renderBlindStep,
  startRecallTiles, matchRecallTile, syncDiacriticsBarVisibility, syncAudioControlsVisibility,
  triggerClozeAudio, speakClozeItem, isCardDueNow, getLemmaStatusBadge, getFilteredVocabEntries,
  toggleVocabSelection, TURTLE_SVG, makeTurtleIcon, bindProgressiveExampleBtn,
  isClusterBlocked, isSiblingBuried, dripInFormSubCard, pickNextStudyItem, pickBestExample,
  buildExportPayload, mergeProgressObject, isValidCardKey, readFileTextResilient, parseBackupJsonText, samplePlacementWords, computePlacementCutoff, applyPlacement,
  openPlacementModal, openSessionOptionsSheet, closeSessionOptionsSheet, updateAfterPills, commitReview, captureSnapshot, persistPausedSession, preloadUpcomingPacks, putPackInCache, loadPackOrExt, getManifestHashForPath, buildVersionedAssetUrl, buildOfflineSWCode, forceRefreshAppUI, handleVisibilityChange,
  wordsToCoverageFloat, wordsToCoveragePct, resolveCoverageTokenRank, renderCoverageCurve, COVERAGE_PREVIEW_PT, placementState, renderPlacementDiagnostic,
  speakClozeCard, cancelSpeech, handleOverrideWrong, stripOrphanedTtsPunct, computeTopUpDelta, handleStudyBackClick, updateSessionHeader, stripRedundantGenderNumberHint, resolveGrammaticalTags, buildUnifiedPostAnswerSub, handleAlreadyKnowClick, formatRecallTag, scrollToNextUnsolvedRecallTile, scrollRecallTileIntoView, LOW_WORKLOAD_THRESHOLD, isColloquialDeferred, getFastAnswerThresholdMs, handleStudyBackClick, ICON_SINGULAR_SVG, ICON_PLURAL_SVG, ICON_MASC_SVG, ICON_FEM_SVG, getConfusableGroup, startClusterDrill, submitClusterDrillAnswer, closeClusterDrill, CONFUSABLE_PAIRS, renderRichGrammarNote, isMultiFormEntry, getExampleFormKey, isExampleFormKnown,
  openWordDetail, openWordDetailsModal, getActiveFinaleModes, executeBulkAction, renderHighlightedEnglish, speakPT, stopTTS, speakVocabWord, pickPitch, DAY_ROLLOVER_HOUR, getLogicalDay, getLogicalDayStartMs, ensureDailyRollover, getStudiedBaseLemmaIds, getEffectiveDailyNewCap, computeAvailableSessionCounts, startStudySession, renderHome, renderSettings, showDoneSummary, renderVocabList,
  scrollFeedbackBannerIntoView, cancelRecallReturnDwellAndFocusNext, openSessionHistoryModal, closeSessionHistoryModal, resolveAllSessionItems, getSeenMainExIdSet,
  SESSION_PRESETS, normalizeSessionSize, computeSessionDurationEstimate, getGlossSenseClusters, resolveExampleSenseCluster,
  playCorrectChime, playSummaryChord, unlockSoundEffects, saveSentenceReport, isSentenceReported, buildReportsExportJson, clearSentenceReports,
  openReportModal, closeReportModal, submitSentenceReport, setReportReason, syncSfxButtonUI,
  isDiacriticOnlyDiff, makeTypoLogKey, recordTypoEvent, getActiveTypoEntries, recordTypoDrillAttempt,
  makeMixupPairKey, recordConfusableMixup, dismissConfusableRecommendation, maybeRecordConfusableMixup,
  getAllConfusableGroupsByUnit, getConfusableRecommendations, renderDrillRecommendationCard, renderHomeDrillRec,
  renderDrillsHub, startTypoDrill, saveTypoLog, saveMixups,
  migrateSettingsForTest: sObj => {
    if ((sObj.settingsVersion || 0) < 4) {
      if (sObj.sessionSize === 'all' || sObj.sessionSize === 'ALL' || !SESSION_PRESETS.includes(Number(sObj.sessionSize))) {
        sObj.sessionSize = 20;
      } else {
        sObj.sessionSize = Number(sObj.sessionSize);
      }
      if (typeof sObj.enableFixRound !== 'boolean') sObj.enableFixRound = true;
      if (typeof sObj.soundEffects !== 'boolean') sObj.soundEffects = true;
      if ((sObj.settingsVersion || 0) < 3 && (sObj.dailyNewLemmaCap === 15 || sObj.dailyNewLimit === 15)) {
        sObj.dailyNewLimit = 10;
      }
      sObj.settingsVersion = 4;
    }
    if (!Array.isArray(sObj.finaleModes)) {
      const legacy = sObj.finaleMode;
      sObj.finaleModes = legacy === 'blind' ? ['blind'] : (legacy === 'recall' ? ['recall'] : (legacy === 'off' ? [] : ['blind', 'recall']));
    }
    return sObj;
  },
  FSRS6, sanitizeRetention, contentStore, userStore, State, session, navState, ingestJsonFile, getExamplesForEntry,
  renderCorrectionProgress, renderFeedbackBanner, resolveLexiconLemmaIdForToken, SPOKEN_VERB_PARENTS, getSpokenParentEntry, resolveVerbDrillTarget, VOCAB_FILTER_DESCRIPTIONS, makeSessionLogKey,
  renderClozeSentence, updateLiveBlankMirror, renderCorrectedWordWithHighlight, normalizeColloquialContext, isColloquialContextDeferred, syncClusterLegendUI, focusClusterDrillInput, handleFinaleBackClick, ICON_EYE_SVG, ICON_EYE_OFF_SVG,
  ICON_BOOK_CLOSED_SVG, buildPosPill, buildGenderPill, buildNumberPill, buildSlotPill, getSlotPillClass, formatLexiconDisplayLemma, applyBlindAudioMissSrs, advanceStudy, resolveEntryBaseGender, easeCubicBezier, animateCoverageReturn, cancelCoverageReturnAnim,
  TENSE_GROUPS, SLOT_TO_TENSE_GROUP, getLastSpokenLog: () => getLastSpokenLog(), clearSpokenLog
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
