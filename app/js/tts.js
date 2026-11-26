import { appActions, makeSpeakerIcon, makeTurtleIcon, navState, userStore } from './state.js';
import { normalizeColloquialContext } from './grading.js';

export function getNormalSpeechRate() {
  const r = Number(userStore && userStore.settings && userStore.settings.speechRate);
  return (Number.isFinite(r) && r > 0) ? r : 1.0;
}
export function renderProgressiveAudioBtn(btn, label, tapCount, iconSize = 15) {
  if (!btn) return;
  const isSlow = tapCount >= 2;
  btn.textContent = '';
  btn.appendChild(makeSpeakerIcon(iconSize));
  if (isSlow) btn.appendChild(makeTurtleIcon(iconSize));
  if (label) {
    const sp = document.createElement('span');
    sp.textContent = label;
    btn.appendChild(sp);
  }
  btn.dataset.slow = isSlow ? 'true' : 'false';
  btn.dataset.tapCount = String(tapCount);
}
export function bindProgressiveExampleBtn(btn, text, iconSize = 14) {
  let taps = 0;
  renderProgressiveAudioBtn(btn, '', 0, iconSize);
  btn.addEventListener('click', () => {
    taps += 1;
    const isSlow = taps >= 2;
    const rate = isSlow ? 0.75 : getNormalSpeechRate();
    renderProgressiveAudioBtn(btn, '', taps, iconSize);
    speakPT(text, { rate, keepVoice: taps > 1 });
  });
}

/* ==========================================================================
   8. PT-BR AUDIO & TTS (Same-Card Voice Persistence, 0.75x, Anti-Spoiler)
   ========================================================================== */
export let ptVoices = [];
export let lastVoiceURI = '';
export let currentCardVoice = null;
export let currentCardPitch = 1.0;
export let lastCardPitch = 1.0;
export let speakDelayTimer = null;
export let speakSeq = 0;

export function pickPitch(keepVoice = false) {
  if (userStore.settings.varyPitch === false) {
    currentCardPitch = 1.0;
    return 1.0;
  }
  if (keepVoice && currentCardPitch) return currentCardPitch;
  const isWide = userStore.settings.pitchRange === 'wide';
  const steps = isWide ? [0.85, 0.92, 1.00, 1.08, 1.15] : [0.92, 0.96, 1.00, 1.04, 1.08];
  const far = steps.filter(v => Math.abs(v - lastCardPitch) >= 0.08);
  const pool = far.length > 0 ? far : steps.filter(v => v !== lastCardPitch);
  const p = pool[Math.floor(Math.random() * pool.length)];
  currentCardPitch = p;
  lastCardPitch = p;
  return p;
}
export let lastSpokenLog = []; // Track spoken text for verification

export let speakPauseTimer = null;
export function cancelSpeech() {
  speakSeq += 1;
  clearTimeout(speakDelayTimer);
  clearTimeout(speakPauseTimer);
  speakDelayTimer = null;
  speakPauseTimer = null;
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
}
export function stopTTS() { cancelSpeech(); }

export function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  try {
    const all = window.speechSynthesis.getVoices() || [];
    ptVoices = all.filter(v => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith('pt-br'));
    if (ptVoices.length === 0) ptVoices = all.filter(v => v.lang && v.lang.toLowerCase().startsWith('pt'));
    if (ptVoices.length > 0 && userStore.settings.enabledVoices.length === 0) {
      userStore.settings.enabledVoices = ptVoices.map(v => ({ voiceURI: v.voiceURI, name: v.name }));
    }
    if (navState.settingsOpen) appActions.renderVoicesSettings();
  } catch (_) {}
}

export function initTTS() {
  if ('speechSynthesis' in window) {
    refreshVoices();
    try { window.speechSynthesis.onvoiceschanged = refreshVoices; } catch (_) {}
    setTimeout(refreshVoices, 300);
    setTimeout(refreshVoices, 1000);
  }
}
export function getPtVoices() { return ptVoices; }
export function getCurrentCardPitch() { return currentCardPitch; }
export function getLastSpokenLog() { return lastSpokenLog; }
export function clearSpokenLog() { lastSpokenLog = []; }

export function getCheckedVoices() {
  if (ptVoices.length === 0) return [];
  const saved = userStore.settings.enabledVoices || [];
  const matched = ptVoices.filter(v => saved.some(s => s.voiceURI === v.voiceURI || s.name === v.name));
  return matched.length > 0 ? matched : ptVoices;
}

export function pickVoiceForNewCard() {
  pickPitch(false);
  const pool = getCheckedVoices();
  if (pool.length === 0) { currentCardVoice = null; return null; }
  if (!userStore.settings.rotateVoices || pool.length === 1) {
    currentCardVoice = pool[0]; return currentCardVoice;
  }
  const others = pool.filter(v => v.voiceURI !== lastVoiceURI);
  const list = others.length ? others : pool;
  currentCardVoice = list[Math.floor(Math.random() * list.length)];
  lastVoiceURI = currentCardVoice.voiceURI;
  return currentCardVoice;
}

export function stripOrphanedTtsPunct(s) {
  const out = String(s || '')
    .replace(/^[\s.,;:!?\u2026\u2014\u2013\-"]+/, '')
    .replace(/[\s.,;:\u2026\u2014\u2013\-"]+$/, '')
    .trim();
  if (!out || !/[\p{L}\p{N}]/u.test(out)) return '';
  return out;
}

export function speakPT(text, { rate = 0.96, keepVoice = true, explicitVoice = null, onDone = null } = {}) {
  if (!text) { if (onDone) onDone(); return; }
  speakSeq += 1;
  const mySeq = speakSeq;
  clearTimeout(speakDelayTimer);
  lastSpokenLog.push({ text, rate, keepVoice, seq: mySeq });
  if (lastSpokenLog.length > 30) lastSpokenLog.shift();
  if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
  const chosen = explicitVoice || (keepVoice && currentCardVoice ? currentCardVoice : pickVoiceForNewCard());
  const pitch = pickPitch(keepVoice);
  let finished = false;
  const finishOnce = () => { if (!finished) { finished = true; if (onDone) onDone(); } };

  const doSpeak = (useFallback = false) => {
    if (mySeq !== speakSeq) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR'; u.rate = rate;
      if (!useFallback && chosen) u.voice = chosen;
      u.pitch = pitch;
      u.onend = () => { if (mySeq === speakSeq) finishOnce(); };
      u.onerror = ev => {
        if (mySeq !== speakSeq) return;
        if (ev && (ev.error === 'canceled' || ev.error === 'interrupted')) return;
        if (!useFallback) doSpeak(true);
        else finishOnce();
      };
      window.speechSynthesis.speak(u);
    } catch (_) { finishOnce(); }
  };

  try {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
      speakDelayTimer = setTimeout(() => { if (mySeq === speakSeq) doSpeak(false); }, 40);
    } else {
      doSpeak(false);
    }
  } catch (_) {}
}

export function prepareSpeechSpec({ rate = 0.96, keepVoice = true, explicitVoice = null } = {}) {
  const voice = explicitVoice || (keepVoice && currentCardVoice ? currentCardVoice : pickVoiceForNewCard());
  const pitch = pickPitch(keepVoice);
  return { voice, pitch, rate };
}

export function speakSegmentWithSpec(text, voiceSpec, mySeq, onDone = null) {
  if (!text || mySeq !== speakSeq) return;
  lastSpokenLog.push({ text, rate: voiceSpec.rate, pitch: voiceSpec.pitch, keepVoice: true, seq: mySeq });
  if (lastSpokenLog.length > 30) lastSpokenLog.shift();
  if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    u.rate = voiceSpec.rate;
    if (voiceSpec.voice) u.voice = voiceSpec.voice;
    u.pitch = voiceSpec.pitch;
    u.onend = () => { if (mySeq === speakSeq && onDone) onDone(); };
    u.onerror = e => {
      const err = e && e.error;
      if (err === 'canceled' || err === 'interrupted') return;
      if (mySeq === speakSeq && onDone) onDone();
    };
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

export function speakClozeCard(ex, revealed = false, opts = {}) {
  if (!ex) return;
  const rate = opts.rate != null ? opts.rate : 0.96;
  const keepVoice = opts.keepVoice !== undefined ? opts.keepVoice : true;
  const sp = normalizeColloquialContext(ex);
  if (revealed) {
    speakPT(sp.pt, { rate, keepVoice, explicitVoice: opts.explicitVoice || null });
    return;
  }
  const terminalMatch = String(sp.pt || '').trim().replace(/["')\]]+$/, '').match(/[?!]+$/);
  const terminalMark = terminalMatch ? terminalMatch[0] : '';
  let beforeText = stripOrphanedTtsPunct(sp.before);
  let afterText = stripOrphanedTtsPunct(sp.after);
  if (terminalMark) {
    if (afterText && !/[?!]+$/.test(afterText)) afterText += terminalMark;
    else if (!afterText && beforeText && !/[?!]+$/.test(beforeText)) beforeText += terminalMark;
  }
  cancelSpeech();
  const mySeq = speakSeq;
  const voiceSpec = prepareSpeechSpec({ rate, keepVoice, explicitVoice: opts.explicitVoice || null });

  if (beforeText && afterText) {
    speakSegmentWithSpec(beforeText, voiceSpec, mySeq, () => {
      if (mySeq !== speakSeq) return;
      speakPauseTimer = setTimeout(() => {
        if (mySeq !== speakSeq) return;
        speakSegmentWithSpec(afterText, voiceSpec, mySeq, null);
      }, 600);
    });
  } else if (afterText) {
    speakPauseTimer = setTimeout(() => {
      if (mySeq !== speakSeq) return;
      speakSegmentWithSpec(afterText, voiceSpec, mySeq, null);
    }, 300);
  } else if (beforeText) {
    speakSegmentWithSpec(beforeText, voiceSpec, mySeq, null);
  }
}

export function speakClozeItem(ex, revealed, rate = 0.96) {
  speakClozeCard(ex, Boolean(revealed), { rate, keepVoice: true });
}

let sfxAudioCtx = null;
function getSoundEffectsContext() {
  if (typeof window === 'undefined') return null;
  if (userStore && userStore.settings && userStore.settings.soundEffects === false) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (typeof Ctx !== 'function') return null;
  if (!sfxAudioCtx) {
    try { sfxAudioCtx = new Ctx(); } catch (_) { return null; }
  }
  if (sfxAudioCtx && sfxAudioCtx.state === 'suspended' && typeof sfxAudioCtx.resume === 'function') {
    try { sfxAudioCtx.resume().catch(() => {}); } catch (_) {}
  }
  return sfxAudioCtx;
}

export function unlockSoundEffects() {
  try {
    const ctx = getSoundEffectsContext();
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
  } catch (_) {}
}

function playToneSequence(notes) {
  try {
    const ctx = getSoundEffectsContext();
    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return false;
    const t0 = Number(ctx.currentTime) || 0;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.setValueAtTime(n.freq, t0 + n.start);
      gain.gain.setValueAtTime(0.0001, t0 + n.start);
      gain.gain.exponentialRampToValueAtTime(n.peak, t0 + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.02);
    }
    return true;
  } catch (_) {
    return false;
  }
}

export function playCorrectChime() {
  return playToneSequence([
    { freq: 523.25, start: 0, dur: 0.11, peak: 0.055, type: 'sine' },
    { freq: 659.25, start: 0.08, dur: 0.14, peak: 0.06, type: 'sine' }
  ]);
}

export function playSummaryChord() {
  return playToneSequence([
    { freq: 523.25, start: 0, dur: 0.48, peak: 0.04, type: 'sine' },
    { freq: 659.25, start: 0.045, dur: 0.48, peak: 0.04, type: 'sine' },
    { freq: 783.99, start: 0.09, dur: 0.52, peak: 0.045, type: 'triangle' }
  ]);
}
