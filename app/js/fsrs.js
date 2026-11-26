import { deepClone, parseCardKey } from './state.js';

/* ==========================================================================
   4. FULL 21-WEIGHT FSRS-6 ENGINE
   ========================================================================== */
export const FSRS6_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542
];

export function fnvHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export function createBlankCardRecord(key) {
  const { lemmaId } = parseCardKey(key);
  return {
    key, lemmaId, status: 'new',
    stability: 0, difficulty: 0, due: 0, interval: 0,
    reps: 0, lapses: 0, step: 0, leech: false, suspended: false, assumed: false,
    last_review: 0, updatedAt: 0, firstIntroducedAt: 0, lastExampleId: null
  };
}

export function sanitizeRetention(val, fallback = 0.85) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.92, Math.max(0.80, Math.round(n * 100) / 100));
}

export const FSRS6 = {
  learningStepsMin: [1, 10],
  relearningStepsMin: [10],
  leechThreshold: 5,

  retrievability(elapsedDays, stability) {
    if (stability <= 0) return 0;
    const decay = -FSRS6_W[20];
    const factor = Math.pow(0.9, -1 / FSRS6_W[20]) - 1;
    return Math.pow(1 + (factor * elapsedDays) / stability, decay);
  },
  nextInterval(stability, desiredRetention, seedKey) {
    const decay = -FSRS6_W[20];
    const factor = Math.pow(0.9, -1 / FSRS6_W[20]) - 1;
    let ivl = (stability / factor) * (Math.pow(desiredRetention, 1 / decay) - 1);
    ivl = Math.max(1, Math.min(36500, Math.round(ivl)));
    if (ivl >= 3) {
      const fuzz = Math.max(1, Math.round(ivl * 0.05));
      const offset = Math.floor(fnvHash(seedKey) * (2 * fuzz + 1)) - fuzz;
      ivl = Math.max(2, ivl + offset);
    }
    return ivl;
  },
  initStability(grade) { return Math.max(0.1, FSRS6_W[grade - 1]); },
  initDifficulty(grade) { return Math.min(10, Math.max(1, FSRS6_W[4] - Math.exp(FSRS6_W[5] * (grade - 1)) + 1)); },
  nextDifficulty(d, grade) {
    const d0 = this.initDifficulty(4);
    const nextD = d + (-FSRS6_W[6] * (grade - 3)) * ((10 - d) / 9);
    return Math.min(10, Math.max(1, FSRS6_W[7] * d0 + (1 - FSRS6_W[7]) * nextD));
  },
  sameDayStability(s, grade) {
    const safeS = Math.max(0.1, s);
    const nextS = safeS * Math.exp(FSRS6_W[17] * (grade - 3 + FSRS6_W[18])) * Math.pow(safeS, -FSRS6_W[19]);
    return grade >= 3 ? Math.max(safeS, nextS) : Math.max(0.1, nextS);
  },
  nextRecallStability(d, s, r, grade) {
    const hardPenalty = grade === 2 ? FSRS6_W[15] : 1;
    const easyBonus = grade === 4 ? FSRS6_W[16] : 1;
    const inc = Math.exp(FSRS6_W[8]) * (11 - d) * Math.pow(Math.max(0.1, s), -FSRS6_W[9]) *
      (Math.exp(FSRS6_W[10] * (1 - r)) - 1) * hardPenalty * easyBonus;
    return Math.max(0.1, s * (1 + inc));
  },
  nextForgetStability(d, s, r) {
    const newS = FSRS6_W[11] * Math.pow(d, -FSRS6_W[12]) *
      (Math.pow(s + 1, FSRS6_W[13]) - 1) * Math.exp(FSRS6_W[14] * (1 - r));
    return Math.max(0.1, Math.min(s, newS));
  },

  schedule(cardKey, prevRec, grade, desiredRetention = 0.85, nowMs = Date.now()) {
    const cs = prevRec ? deepClone(prevRec) : createBlankCardRecord(cardKey);
    const prevMs = cs.last_review || nowMs;
    const elapsedDays = Math.max(0, (nowMs - prevMs) / 86400000);
    const isSameDay = elapsedDays < 1 && cs.reps > 0;

    cs.assumed = false;
    cs.reps = (cs.reps || 0) + 1;
    cs.last_review = nowMs;
    cs.updatedAt = nowMs;
    if (!cs.firstIntroducedAt) cs.firstIntroducedAt = nowMs;

    const seedKey = `${cardKey}:${cs.reps}`;

    if (!cs.status || cs.status === 'new' || cs.status === 'to_learn' || cs.status === 'assumed') {
      cs.stability = this.initStability(grade);
      cs.difficulty = this.initDifficulty(grade);
      cs.relearning = false;
      if (grade === 1) {
        cs.status = 'learning'; cs.step = 0; cs.lapses = (cs.lapses || 0) + 1;
        cs.due = nowMs + this.learningStepsMin[0] * 60000;
      } else if (grade === 2) {
        cs.status = 'learning'; cs.step = 0;
        cs.due = nowMs + 5 * 60000;
      } else {
        cs.status = 'learning'; cs.step = 1;
        cs.due = nowMs + this.learningStepsMin[1] * 60000;
      }
    } else if (cs.status === 'learning' || cs.status === 'relearning') {
      cs.stability = this.sameDayStability(cs.stability || 0.5, grade);
      cs.difficulty = this.nextDifficulty(cs.difficulty || 5, grade);
      const isRelearn = cs.status === 'relearning' || Boolean(cs.relearning);
      const steps = isRelearn ? this.relearningStepsMin : this.learningStepsMin;
      if (grade === 1) {
        cs.status = 'learning'; cs.relearning = isRelearn; cs.step = 0;
        cs.due = nowMs + steps[0] * 60000;
      } else if (grade === 2) {
        cs.status = 'learning'; cs.relearning = isRelearn;
        cs.due = nowMs + steps[Math.min(cs.step || 0, steps.length - 1)] * 60000;
      } else {
        cs.step = (cs.step || 0) + 1;
        if (cs.step >= steps.length) {
          const ivl = this.nextInterval(cs.stability, desiredRetention, seedKey);
          cs.interval = ivl;
          cs.status = ivl >= 21 ? 'known' : 'review';
          cs.relearning = false;
          cs.due = nowMs + ivl * 86400000;
        } else {
          cs.status = 'learning'; cs.relearning = isRelearn;
          cs.due = nowMs + steps[cs.step] * 60000;
        }
      }
    } else if (cs.status === 'review' || cs.status === 'known') {
      const r = this.retrievability(elapsedDays, cs.stability || 1);
      cs.difficulty = this.nextDifficulty(cs.difficulty || 5, grade);
      if (grade === 1) {
        cs.lapses = (cs.lapses || 0) + 1;
        cs.stability = this.nextForgetStability(cs.difficulty, cs.stability || 1, r);
        cs.status = 'learning'; cs.relearning = true; cs.step = 0;
        cs.due = nowMs + this.relearningStepsMin[0] * 60000;
      } else {
        cs.stability = isSameDay ? this.sameDayStability(cs.stability || 1, grade) : this.nextRecallStability(cs.difficulty, cs.stability || 1, r, grade);
        const ivl = this.nextInterval(cs.stability, desiredRetention, seedKey);
        cs.interval = ivl;
        cs.status = ivl >= 21 ? 'known' : 'review';
        cs.relearning = false;
        cs.due = nowMs + ivl * 86400000;
      }
    }

    if ((cs.lapses || 0) >= this.leechThreshold) cs.leech = true;
    return cs;
  },
  review(cardKey, prevRec, grade, desiredRetention = 0.85, nowMs = Date.now()) {
    return this.schedule(cardKey, prevRec, grade, desiredRetention, nowMs);
  }
};
