/**
 * Générateur déterministe local et garde-fou symbolique pour WebRecovery.
 * Module ES2024+ zéro-build compatible Navigateur et Node.js ESM.
 *
 * Principes :
 * - Hors-ligne ou en cas de repli, le plan est strictement `engine.buildSession` brut.
 * - Toute sortie Gemini ne peut que réordonner ou personnaliser les `cues`
 *   d'une session déjà filtrée par `engine.buildSession`.
 * - Chaque exercice conservé est re-validé par `engine.isAllowed(ex, ctx)` :
 *   Gemini ne peut jamais ajouter un exercice interdit ou absent de la session filtrée.
 */

import { PROTOCOLS_BY_ID } from "./catalog.js";
import {
  buildSession,
  checkSessionBudget,
  consumeSessionBudget,
  createSessionBudgetState,
  isAllowed,
} from "./engine.js";

/**
 * Assainit un texte généré (supprime balises HTML, caractères de contrôle et borne la longueur).
 * @param {unknown} value
 * @param {number} [maxLen=240]
 * @returns {string}
 */
export function sanitizeCueText(value, maxLen = 240) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLen > 0 && cleaned.length > maxLen) {
    return cleaned.slice(0, maxLen).trimEnd();
  }
  return cleaned;
}

/**
 * Génère la séance déterministe de repli = sortie brute de `engine.buildSession`.
 * Accepte `(protocolId, ctx, options)` ou `({ protocolId, ctx, options })`.
 *
 * @param {string | Record<string, any>} protocolIdOrParams
 * @param {Record<string, any>} [ctxArg={}]
 * @param {{ maxMinutes?: number }} [optionsArg={}]
 * @returns {{
 *   protocolId: string,
 *   protocolName: string,
 *   rationale: string,
 *   items: Array<Record<string, any>>,
 *   removed: Array<{ id: string, reasons: string[] }>,
 *   totalSec: number,
 *   source: "FALLBACK_LOCAL"
 * }}
 */
export function generateFallbackSession(
  protocolIdOrParams,
  ctxArg = {},
  optionsArg = {}
) {
  let protocolId;
  let ctx;
  let options;

  if (
    protocolIdOrParams &&
    typeof protocolIdOrParams === "object" &&
    !Array.isArray(protocolIdOrParams) &&
    !Array.isArray(protocolIdOrParams.exerciseIds)
  ) {
    protocolId = protocolIdOrParams.protocolId;
    ctx = protocolIdOrParams.ctx ?? {};
    options = protocolIdOrParams.options ?? {};
  } else {
    protocolId = protocolIdOrParams;
    ctx = ctxArg ?? {};
    options = optionsArg ?? {};
  }

  const built = buildSession(protocolId, ctx, options);
  const protoMeta =
    typeof protocolId === "string"
      ? PROTOCOLS_BY_ID[protocolId]
      : protocolId && typeof protocolId === "object"
        ? protocolId
        : null;

  const resolvedId =
    typeof protocolId === "string"
      ? protocolId
      : String(protoMeta?.id ?? "custom");

  return {
    protocolId: resolvedId,
    protocolName: String(protoMeta?.name ?? resolvedId),
    rationale: String(
      protoMeta?.objective ??
        protoMeta?.notes ??
        "Séance déterministe assemblée localement selon vos contraintes physiologiques."
    ),
    items: built.items,
    removed: built.removed,
    totalSec: built.totalSec,
    source: "FALLBACK_LOCAL",
  };
}

/**
 * Conserve toujours les cues immuables du catalogue et n'ajoute les cues Gemini
 * qu'en complément (max 2, sans aucun chiffre pour prévenir toute dérive posologique).
 * @param {unknown} rawCues
 * @param {readonly string[]} baseCues
 * @returns {readonly string[]}
 */
function sanitizeExerciseCues(rawCues, baseCues) {
  const immutableBase = Array.isArray(baseCues) ? [...baseCues] : [];
  if (!Array.isArray(rawCues) || rawCues.length === 0) {
    return immutableBase;
  }
  const geminiExtras = rawCues
    .map((c) => sanitizeCueText(c, 220))
    .filter((c) => c.length > 0 && !/\d/.test(c))
    .slice(0, 2);

  return geminiExtras.length > 0
    ? [...immutableBase, ...geminiExtras]
    : immutableBase;
}

/**
 * Valide et applique les garde-fous symboliques sur une réponse Gemini brute.
 * - Gemini ne peut ni ajouter un exercice absent de `baseSession.items`, ni contourner `engine.isAllowed`.
 * - Les phases, durées, équipements, contre-indications et cues de base proviennent du catalogue local.
 * - Les plafonds cumulatifs KAATSU et maxMinutes sont re-validés via `engine.js`.
 * - En cas de rejet (`rejectedIds.length > 0`), bascule sur la rationale de base et `source: "FALLBACK_LOCAL"`.
 *
 * @param {Record<string, any>} rawGeminiOutput
 * @param {object} [params={}]
 * @param {ReturnType<typeof generateFallbackSession>} [params.baseSession]
 * @param {string | Record<string, any>} [params.protocolId]
 * @param {Record<string, any>} [params.ctx={}]
 * @param {{ maxMinutes?: number }} [params.options={}]
 */
export function enforceSymbolicConstraints(
  rawGeminiOutput,
  { baseSession, protocolId, ctx = {}, options = {} } = {}
) {
  const resolvedBase =
    baseSession ?? generateFallbackSession(protocolId, ctx, options);

  const safeCtx = ctx ?? {};
  const budget = createSessionBudgetState(options);
  const baseMap = new Map(resolvedBase.items.map((ex) => [ex.id, ex]));
  const finalRemoved = [...(resolvedBase.removed ?? [])];
  const rejectedIds = [];
  const seenIds = new Set();
  const finalItems = [];

  const candidateList = Array.isArray(rawGeminiOutput?.items)
    ? rawGeminiOutput.items
    : Array.isArray(rawGeminiOutput?.orderedIds)
      ? rawGeminiOutput.orderedIds.map((id) => ({ id }))
      : [];

  for (const entry of candidateList) {
    const id =
      typeof entry === "string"
        ? entry.trim()
        : typeof entry?.id === "string"
          ? entry.id.trim()
          : "";
    if (!id) continue;

    if (seenIds.has(id)) {
      continue;
    }

    const baseEx = baseMap.get(id);
    if (!baseEx) {
      // Tentative d'ajout d'un exercice non présent dans la session filtrée par buildSession
      rejectedIds.push(id);
      continue;
    }

    // Re-validation symbolique systématique via engine.isAllowed
    const check = isAllowed(baseEx, safeCtx);
    if (!check.ok) {
      rejectedIds.push(id);
      finalRemoved.push({ id: baseEx.id, reasons: check.reasons });
      seenIds.add(id);
      continue;
    }

    // Re-validation des plafonds cumulatifs KAATSU et du budget maxMinutes
    const budgetCheck = checkSessionBudget(budget, baseEx);
    if (!budgetCheck.ok) {
      rejectedIds.push(id);
      finalRemoved.push({
        id: baseEx.id,
        reasons: [/** @type {string} */ (budgetCheck.reason)],
      });
      seenIds.add(id);
      continue;
    }

    seenIds.add(id);
    consumeSessionBudget(budget, baseEx);
    finalItems.push({
      ...baseEx,
      cues: sanitizeExerciseCues(entry?.cues, baseEx.cues),
    });
  }

  // Complète avec les exercices autorisés de la session de base éventuellement omis par Gemini
  for (const baseEx of resolvedBase.items) {
    if (seenIds.has(baseEx.id)) continue;
    const check = isAllowed(baseEx, safeCtx);
    if (!check.ok) {
      finalRemoved.push({ id: baseEx.id, reasons: check.reasons });
      seenIds.add(baseEx.id);
      continue;
    }
    const budgetCheck = checkSessionBudget(budget, baseEx);
    if (!budgetCheck.ok) {
      finalRemoved.push({
        id: baseEx.id,
        reasons: [/** @type {string} */ (budgetCheck.reason)],
      });
      seenIds.add(baseEx.id);
      continue;
    }
    seenIds.add(baseEx.id);
    consumeSessionBudget(budget, baseEx);
    finalItems.push(baseEx);
  }

  const hasRejected = rejectedIds.length > 0;
  const safeRationale = hasRejected
    ? resolvedBase.rationale
    : sanitizeCueText(rawGeminiOutput?.rationale, 320) || resolvedBase.rationale;

  return {
    protocolId: resolvedBase.protocolId,
    protocolName: resolvedBase.protocolName,
    rationale: safeRationale,
    items: finalItems,
    removed: finalRemoved,
    totalSec: budget.totalSec,
    rejectedIds,
    guardrailApplied: hasRejected,
    source: hasRejected ? "FALLBACK_LOCAL" : "GEMINI",
  };
}
