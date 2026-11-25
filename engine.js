/**
 * Moteur de décision physiologique et d'assemblage de séances WebRecovery.
 * Module ES pur sans dépendance DOM.
 */

import {
  EQUIPMENT_BY_ID,
  EXERCISES,
  EXERCISES_BY_ID,
  PROTOCOLS_BY_ID,
} from "./catalog.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const MIN_SPO2_HARD_STOP_PCT =
  EQUIPMENT_BY_ID.oximeter?.safetyLimits?.hardStopThresholdPct ?? 80;

const ARMS_ZONES = new Set([
  "arms",
  "biceps",
  "triceps",
  "forearms",
  "vascular_upper",
]);

/**
 * Borne une valeur numérique dans [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convertit un Set, tableau ou itérable en Set (hors chaîne).
 * @param {Set<string>|Iterable<string>|undefined|null} value
 * @returns {Set<string>}
 */
function toStringSet(value) {
  if (value instanceof Set) {
    return value;
  }
  if (value && typeof value !== "string" && typeof value[Symbol.iterator] === "function") {
    return new Set(value);
  }
  return new Set();
}

/**
 * Convertit une date (Date, timestamp ms ou chaîne ISO) en timestamp ms.
 * @param {Date|number|string|undefined|null} value
 * @returns {number}
 */
function toTimestampMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return Date.parse(value);
  }
  return Number.NaN;
}

/**
 * Résout l'heure courante sous forme d'objet Date valide.
 * @param {Date|number|string|undefined|null} now
 * @returns {Date}
 */
function resolveNowDate(now) {
  if (now === undefined || now === null) {
    return new Date();
  }
  const ms = toTimestampMs(now);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Calcule la moyenne et l'écart-type échantillonnal sur un tableau numérique.
 * @param {number[]} values
 * @returns {{ mean: number, std: number }}
 */
function meanAndSampleStd(values) {
  const n = values.length;
  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Détermine si un exercice appartient à la modalité froide (conflit < 4 h post-muscu).
 * @param {Record<string, any>} exercise
 * @returns {boolean}
 */
function isColdExercise(exercise) {
  const conflicts = Array.isArray(exercise.conflicts) ? exercise.conflicts : [];
  const equipment = Array.isArray(exercise.equipment) ? exercise.equipment : [];
  return conflicts.includes("strength_lt_4h") || equipment.includes("cold_plunge");
}

/**
 * Détermine si un exercice relève du protocole KAATSU/BFR.
 * @param {Record<string, any>} exercise
 * @returns {boolean}
 */
function isKaatsuExercise(exercise) {
  const conflicts = Array.isArray(exercise.conflicts) ? exercise.conflicts : [];
  const equipment = Array.isArray(exercise.equipment) ? exercise.equipment : [];
  return (
    exercise.family === "kaatsu" ||
    conflicts.includes("first_kaatsu_unsupervised") ||
    equipment.includes("kaatsu_bands")
  );
}

/**
 * Détermine si un exercice correspond à une exposition hypoxique IHHT nécessitant un oxymètre.
 * @param {Record<string, any>} exercise
 * @returns {boolean}
 */
function isIhhtExercise(exercise) {
  const conflicts = Array.isArray(exercise.conflicts) ? exercise.conflicts : [];
  const equipment = Array.isArray(exercise.equipment) ? exercise.equipment : [];
  return (
    (typeof exercise.id === "string" && exercise.id.startsWith("ihht_")) ||
    conflicts.includes("missing_oximeter") ||
    equipment.includes("hypoxia_gen")
  );
}

/**
 * Détermine le membre ciblé par un exercice KAATSU ("arms" ou "legs") et son plafond (en min).
 * @param {Record<string, any>} exercise
 * @returns {{ limb: "arms"|"legs", maxContinuousMin: number }}
 */
function getKaatsuLimbLimit(exercise) {
  const zones = Array.isArray(exercise.zones) ? exercise.zones : [];
  const id = typeof exercise.id === "string" ? exercise.id : "";
  const isArms = id.includes("arms") || zones.some((z) => ARMS_ZONES.has(z));
  const limb = isArms ? "arms" : "legs";
  const safety = EQUIPMENT_BY_ID.kaatsu_bands?.safetyLimits?.[limb];
  const maxContinuousMin = safety?.maxContinuousMin ?? (limb === "arms" ? 15 : 20);
  return { limb, maxContinuousMin };
}

/**
 * Calcule le score de récupération global (0-100) à partir de la HRV (z-score ln rMSSD sur 7 j),
 * du sommeil (durée et/ou score) et du TSB. Tolère les données manquantes.
 * @param {{
 *   hrvToday?: number|null,
 *   hrvHistory7d?: number[]|null,
 *   sleepHours?: number|null,
 *   sleepScore?: number|null,
 *   tsb?: number|null
 * }} [input]
 * @returns {{
 *   score: number,
 *   level: "low"|"moderate"|"good",
 *   parts: {
 *     hrv: { score: number|null, zScore: number|null, lnToday: number|null, lnMean: number|null, lnStd: number|null, samples: number },
 *     sleep: { score: number|null, hours: number|null, sleepScore: number|null },
 *     tsb: { score: number|null, value: number|null }
 *   }
 * }}
 */
export function computeRecoveryScore(input = {}) {
  const { hrvToday, hrvHistory7d, sleepHours, sleepScore, tsb } = input ?? {};

  // 1. HRV : z-score sur ln(rMSSD) des 7 derniers jours valides
  const validHistory = Array.isArray(hrvHistory7d)
    ? hrvHistory7d
        .filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
        .slice(-7)
    : [];

  let hrvPartScore = null;
  let zScore = null;
  let lnToday = null;
  let lnMean = null;
  let lnStd = null;

  if (
    typeof hrvToday === "number" &&
    Number.isFinite(hrvToday) &&
    hrvToday > 0 &&
    validHistory.length >= 2
  ) {
    lnToday = Math.log(hrvToday);
    const lnHist = validHistory.map((v) => Math.log(v));
    const stats = meanAndSampleStd(lnHist);
    lnMean = stats.mean;
    lnStd = stats.std;

    if (lnStd < 1e-6) {
      if (Math.abs(lnToday - lnMean) < 1e-6) {
        zScore = 0;
      } else {
        zScore = lnToday > lnMean ? 1.5 : -1.5;
      }
    } else {
      zScore = (lnToday - lnMean) / lnStd;
    }

    // z = 0 -> 65 ; z = +2 -> 100 ; z = -2 -> 30
    hrvPartScore = clamp(65 + zScore * 17.5, 0, 100);
  }

  // 2. Sommeil : combinaison sleepScore (0-100) et/ou sleepHours (3h=0 .. 8h+=100)
  const hasSleepScore =
    typeof sleepScore === "number" && Number.isFinite(sleepScore);
  const hasSleepHours =
    typeof sleepHours === "number" &&
    Number.isFinite(sleepHours) &&
    sleepHours >= 0;

  let sleepPartScore = null;
  if (hasSleepScore && hasSleepHours) {
    const sNorm = clamp(sleepScore, 0, 100);
    const hNorm = clamp((sleepHours - 3) * 20, 0, 100);
    sleepPartScore = 0.6 * sNorm + 0.4 * hNorm;
  } else if (hasSleepScore) {
    sleepPartScore = clamp(sleepScore, 0, 100);
  } else if (hasSleepHours) {
    sleepPartScore = clamp((sleepHours - 3) * 20, 0, 100);
  }

  // 3. TSB : neutralité 0 -> 65, +20 -> 95, -20 -> 35
  const hasTsb = typeof tsb === "number" && Number.isFinite(tsb);
  const tsbPartScore = hasTsb ? clamp(65 + tsb * 1.5, 0, 100) : null;

  // Agrégation pondérée tolérante aux métriques absentes
  const components = [
    { weight: 0.45, value: hrvPartScore },
    { weight: 0.35, value: sleepPartScore },
    { weight: 0.2, value: tsbPartScore },
  ];

  let weightedSum = 0;
  let totalWeight = 0;
  for (const comp of components) {
    if (comp.value !== null) {
      weightedSum += comp.value * comp.weight;
      totalWeight += comp.weight;
    }
  }

  const score =
    totalWeight > 0 ? Math.round(clamp(weightedSum / totalWeight, 0, 100)) : 50;

  let level = "moderate";
  if (score < 45) {
    level = "low";
  } else if (score >= 70) {
    level = "good";
  }

  return {
    score,
    level,
    parts: {
      hrv: {
        score: hrvPartScore !== null ? Math.round(hrvPartScore) : null,
        zScore: zScore !== null ? Number(zScore.toFixed(3)) : null,
        lnToday: lnToday !== null ? Number(lnToday.toFixed(4)) : null,
        lnMean: lnMean !== null ? Number(lnMean.toFixed(4)) : null,
        lnStd: lnStd !== null ? Number(lnStd.toFixed(4)) : null,
        samples: validHistory.length,
      },
      sleep: {
        score: sleepPartScore !== null ? Math.round(sleepPartScore) : null,
        hours: hasSleepHours ? sleepHours : null,
        sleepScore: hasSleepScore ? sleepScore : null,
      },
      tsb: {
        score: tsbPartScore !== null ? Math.round(tsbPartScore) : null,
        value: hasTsb ? tsb : null,
      },
    },
  };
}

/**
 * Vérifie si un exercice est autorisé selon les interdits médicaux, matériels et temporels.
 * @param {Record<string, any>} exercise
 * @param {{
 *   userContraindications?: Set<string>|string[],
 *   equipmentAvailable?: Set<string>|string[],
 *   todayActivities?: Array<{ type?: string, endTime?: Date|number|string }>,
 *   now?: Date|number|string,
 *   kaatsuSupervisedOnce?: boolean,
 *   spo2ThresholdPct?: number
 * }} [ctx]
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function isAllowed(exercise, ctx = {}) {
  if (!exercise || typeof exercise !== "object") {
    return { ok: false, reasons: ["invalid_exercise"] };
  }

  const safeCtx = ctx ?? {};
  const reasons = [];

  const userContras = toStringSet(safeCtx.userContraindications);
  const equipmentSet = toStringSet(safeCtx.equipmentAvailable);
  const activities = Array.isArray(safeCtx.todayActivities)
    ? safeCtx.todayActivities
    : [];
  const nowMs = resolveNowDate(safeCtx.now).getTime();

  // 1. Contre-indications utilisateur
  const exContras = Array.isArray(exercise.contraindications)
    ? exercise.contraindications
    : [];
  for (const ci of exContras) {
    if (userContras.has(ci)) {
      reasons.push(`contraindication:${ci}`);
    }
  }

  // 2. Matériel requis (et cas spécifique oxymètre sur IHHT)
  const exEquipment = Array.isArray(exercise.equipment)
    ? exercise.equipment
    : [];
  const ihht = isIhhtExercise(exercise);
  let oximeterMissingPushed = false;

  for (const eq of exEquipment) {
    if (!equipmentSet.has(eq)) {
      if (eq === "oximeter" && ihht) {
        reasons.push("missing_oximeter");
        oximeterMissingPushed = true;
      } else {
        reasons.push(`missing_equipment:${eq}`);
      }
    }
  }

  if (ihht && !oximeterMissingPushed && !equipmentSet.has("oximeter")) {
    reasons.push("missing_oximeter");
  }

  if (
    ihht &&
    typeof safeCtx.spo2ThresholdPct === "number" &&
    Number.isFinite(safeCtx.spo2ThresholdPct) &&
    safeCtx.spo2ThresholdPct < MIN_SPO2_HARD_STOP_PCT
  ) {
    reasons.push("unsafe_spo2_threshold");
  }

  // 3. KAATSU interdit si première séance non supervisée
  if (isKaatsuExercise(exercise) && !safeCtx.kaatsuSupervisedOnce) {
    reasons.push("first_kaatsu_unsupervised");
  }

  // 4. Froid interdit si musculation terminée il y a strictement moins de 4 h
  if (isColdExercise(exercise)) {
    const hasRecentStrength = activities.some((act) => {
      if (!act || String(act.type ?? "").toLowerCase() !== "strength") {
        return false;
      }
      const endMs = toTimestampMs(act.endTime);
      if (!Number.isFinite(endMs)) {
        return true;
      }
      const elapsedMs = nowMs - endMs;
      return elapsedMs >= 0 && elapsedMs < FOUR_HOURS_MS;
    });

    if (hasRecentStrength) {
      reasons.push("strength_lt_4h");
    }
  }

  // 5. Thermique / sauna bloqué si tolérance cardiovasculaire non confirmée
  if (exercise.family === "thermal" && safeCtx.saunaCleared === false) {
    reasons.push("sauna_not_cleared");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

/**
 * Détermine si une activité cycliste du jour est considérée intense.
 * @param {Record<string, any>} act
 * @returns {boolean}
 */
function isIntenseRide(act) {
  if (!act || typeof act !== "object") {
    return false;
  }
  const type = String(act.type ?? "").toLowerCase();
  if (type === "ride_intense" || type === "hiit_ride" || type === "hiit_cycling") {
    return true;
  }
  if (type !== "ride" && type !== "cycling") {
    return false;
  }

  const intensity = String(act.intensity ?? "").toLowerCase();
  const subtype = String(act.subtype ?? act.tag ?? "").toLowerCase();

  return (
    act.intense === true ||
    act.isIntense === true ||
    intensity === "high" ||
    intensity === "intense" ||
    intensity === "hiit" ||
    subtype === "hiit" ||
    (typeof act.rpe === "number" && act.rpe >= 7) ||
    (typeof act.if === "number" && act.if >= 0.85) ||
    (typeof act.tss === "number" && act.tss >= 80)
  );
}

/**
 * Sélectionne l'identifiant du protocole recommandé selon la priorité physiologique.
 * @param {{
 *   todayActivities?: Array<Record<string, any>>,
 *   now?: Date|number|string
 * }} [ctx]
 * @param {{ score?: number, level?: string }|number|string} [score]
 * @returns {string}
 */
export function selectProtocol(ctx = {}, score) {
  const safeCtx = ctx ?? {};
  const activities = Array.isArray(safeCtx.todayActivities)
    ? safeCtx.todayActivities
    : [];

  // 1. Musculation le jour même -> protocole sans froid
  const hasStrengthToday = activities.some(
    (act) => act && String(act.type ?? "").toLowerCase() === "strength",
  );
  if (hasStrengthToday) {
    return "post_muscu_sans_froid";
  }

  // 2. Sortie vélo intense -> protocole post-HIIT vélo
  if (activities.some(isIntenseRide)) {
    return "post_hiit_velo";
  }

  // 3. Score de récupération bas -> protocole HRV basse
  let isLowScore = false;
  if (score && typeof score === "object") {
    isLowScore =
      score.level === "low" ||
      (typeof score.score === "number" && score.score < 45);
  } else if (typeof score === "number") {
    isLowScore = Number.isFinite(score) && score < 45;
  } else if (typeof score === "string") {
    isLowScore = score === "low";
  }
  if (isLowScore) {
    return "hrv_basse";
  }

  // 4. Soir après 20h -> protocole soir & sommeil
  const nowDate = resolveNowDate(safeCtx.now);
  if (nowDate.getHours() >= 20) {
    return "soir_sommeil";
  }

  // 5. Défaut -> journée de repos actif
  return "repos_actif";
}

/**
 * Initialise l'état de suivi des budgets temps et KAATSU d'une séance.
 * @param {{ maxMinutes?: number }} [options]
 * @returns {{
 *   maxSec: number,
 *   cycleMaxSec: number,
 *   kaatsuSec: { arms: number, legs: number, total: number },
 *   totalSec: number
 * }}
 */
export function createSessionBudgetState(options = {}) {
  const maxMinutes = options?.maxMinutes;
  const maxSec =
    typeof maxMinutes === "number" &&
    Number.isFinite(maxMinutes) &&
    maxMinutes >= 0
      ? Math.floor(maxMinutes * 60)
      : Number.POSITIVE_INFINITY;
  const cycleMaxSec =
    (EQUIPMENT_BY_ID.kaatsu_cycle_20?.safetyLimits?.maxSessionMin ?? 20) * 60;

  return {
    maxSec,
    cycleMaxSec,
    kaatsuSec: { arms: 0, legs: 0, total: 0 },
    totalSec: 0,
  };
}

/**
 * Vérifie si l'ajout d'un exercice respecte les plafonds cumulatifs KAATSU et maxMinutes.
 * @param {ReturnType<typeof createSessionBudgetState>} budget
 * @param {Record<string, any>} exercise
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkSessionBudget(budget, exercise) {
  const durationSec = Number(exercise?.durationSec) || 0;
  if (isKaatsuExercise(exercise)) {
    const { limb, maxContinuousMin } = getKaatsuLimbLimit(exercise);
    const limbMaxSec = maxContinuousMin * 60;
    if (
      budget.kaatsuSec[limb] + durationSec > limbMaxSec ||
      budget.kaatsuSec.total + durationSec > budget.cycleMaxSec
    ) {
      return { ok: false, reason: "kaatsu_max_continuous_exceeded" };
    }
  }
  if (budget.totalSec + durationSec > budget.maxSec) {
    return { ok: false, reason: "max_minutes_exceeded" };
  }
  return { ok: true, reason: null };
}

/**
 * Met à jour les compteurs cumulatifs de durée totale et KAATSU après validation d'un item.
 * @param {ReturnType<typeof createSessionBudgetState>} budget
 * @param {Record<string, any>} exercise
 */
export function consumeSessionBudget(budget, exercise) {
  const durationSec = Number(exercise?.durationSec) || 0;
  budget.totalSec += durationSec;
  if (isKaatsuExercise(exercise)) {
    const { limb } = getKaatsuLimbLimit(exercise);
    budget.kaatsuSec[limb] += durationSec;
    budget.kaatsuSec.total += durationSec;
  }
}

/**
 * Recherche un exercice autorisé de remplacement dans la même famille.
 * @param {Record<string, any>} targetEx
 * @param {Record<string, any>} ctx
 * @param {Set<string>} usedIds
 * @param {ReturnType<typeof createSessionBudgetState>} budget
 * @returns {Record<string, any>|null}
 */
function findFamilyReplacement(targetEx, ctx, usedIds, budget) {
  const targetZones = new Set(targetEx.zones ?? []);

  const candidates = EXERCISES.filter((cand) => {
    if (cand.family !== targetEx.family || cand.id === targetEx.id) {
      return false;
    }
    if (usedIds.has(cand.id)) {
      return false;
    }
    if (!isAllowed(cand, ctx).ok) {
      return false;
    }
    return checkSessionBudget(budget, cand).ok;
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const aShared = (a.zones ?? []).filter((z) => targetZones.has(z)).length;
    const bShared = (b.zones ?? []).filter((z) => targetZones.has(z)).length;
    if (aShared !== bShared) {
      return bShared - aShared;
    }
    return (
      Math.abs(a.durationSec - targetEx.durationSec) -
      Math.abs(b.durationSec - targetEx.durationSec)
    );
  });

  return candidates[0];
}

/**
 * Construit une séance exécutable à partir d'un protocole, filtrée, substituée et bornée.
 * @param {string} protocolId
 * @param {Record<string, any>} [ctx]
 * @param {{ maxMinutes?: number }} [options]
 * @returns {{
 *   items: Array<Record<string, any>>,
 *   removed: Array<{ id: string, reasons: string[] }>,
 *   totalSec: number
 * }}
 */
export function buildSession(protocolId, ctx = {}, options = {}) {
  const protocol =
    typeof protocolId === "string"
      ? PROTOCOLS_BY_ID[protocolId]
      : protocolId && Array.isArray(protocolId.exerciseIds)
        ? protocolId
        : null;
  if (!protocol) {
    throw new Error(`Protocole inconnu : ${protocolId}`);
  }

  const safeCtx = ctx ?? {};
  const budget = createSessionBudgetState(options);

  const items = [];
  const removed = [];
  const usedIds = new Set();

  for (const exId of protocol.exerciseIds) {
    const ex = EXERCISES_BY_ID[exId];
    if (!ex) {
      removed.push({ id: exId, reasons: ["unknown_exercise"] });
      continue;
    }

    let chosen = ex;
    const check = isAllowed(ex, safeCtx);

    if (!check.ok) {
      removed.push({ id: ex.id, reasons: check.reasons });
      const replacement = findFamilyReplacement(ex, safeCtx, usedIds, budget);
      if (!replacement) {
        continue;
      }
      chosen = { ...replacement, replacedFrom: ex.id };
    }

    const budgetCheck = checkSessionBudget(budget, chosen);
    if (!budgetCheck.ok) {
      removed.push({
        id: chosen.id,
        reasons: [/** @type {string} */ (budgetCheck.reason)],
      });
      continue;
    }

    items.push(chosen);
    usedIds.add(chosen.id);
    consumeSessionBudget(budget, chosen);
  }

  return { items, removed, totalSec: budget.totalSec };
}
