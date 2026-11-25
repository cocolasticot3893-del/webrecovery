/**
 * Client HTTP Intervals.icu pour WebRecovery (ES2024+ natif zéro-build).
 * Gère l'authentification Basic depuis `vault.js` (clé jamais loggée),
 * le backoff exponentiel avec jitter (429 / 5xx / réseau),
 * la lecture wellness 7 jours (hrv, sleepSecs, sleepScore, ctl/atl -> tsb),
 * la lecture des activités du jour (strength/ride, endTime, intensité),
 * et l'écriture d'une activité de récupération + champs custom RecoveryLoad/RecoveryType
 * avec bascule automatique sur `outbox.js` en cas d'échec.
 */

import { enqueueOutbox, flushOutbox } from "./outbox.js";
import { loadVault } from "./vault.js";

export const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

/**
 * Champs personnalisés WebRecovery sur Intervals.icu.
 */
export const CUSTOM_RECOVERY_FIELDS = Object.freeze([
  Object.freeze({
    code: "RecoveryLoad",
    name: "Recovery Load",
    type: "numeric",
    units: "AU",
    aggregate: "SUM",
  }),
  Object.freeze({
    code: "RecoveryType",
    name: "Recovery Type",
    type: "text",
    units: "",
    aggregate: "LAST",
  }),
]);

const STRENGTH_ACTIVITY_TYPES = new Set([
  "weighttraining",
  "strength",
  "crossfit",
  "functionalstrength",
]);

const ALLOWED_NORMALIZED_TYPES = new Set([
  "strength",
  "ride",
  "run",
  "swim",
  "walk",
  "other",
]);

const RIDE_ACTIVITY_TYPES = new Set([
  "ride",
  "virtualride",
  "mountainbikeride",
  "gravelride",
  "ebikeride",
  "cycling",
]);

/**
 * Encode une chaîne UTF-8 en Base64 (compatible Navigateur & Node.js).
 * @param {string} str
 * @returns {string}
 */
function encodeBase64(str) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Résout l'identifiant athlète et la clé API depuis les options explicites ou `vault.js`.
 * Ne journalise ni n'expose jamais la clé API.
 * @param {{ athleteId?: string|number, apiKey?: string }} [creds]
 * @returns {{ athleteId: string, apiKey: string }}
 */
function resolveCredentials(creds = {}) {
  let vault = {};
  if (creds.apiKey === undefined || creds.athleteId === undefined) {
    try {
      vault = loadVault() ?? {};
    } catch {
      vault = {};
    }
  }

  const rawId =
    creds.athleteId !== undefined && creds.athleteId !== null
      ? creds.athleteId
      : vault.INTERVALS_ATHLETE_ID;
  const rawKey =
    creds.apiKey !== undefined && creds.apiKey !== null
      ? creds.apiKey
      : vault.INTERVALS_API_KEY;

  const athleteId = String(rawId ?? "0").trim() || "0";
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  return { athleteId, apiKey };
}

/**
 * Construit l'en-tête `Authorization: Basic ...` sans jamais exposer la clé en cas d'erreur.
 * @param {string} apiKey
 * @returns {string}
 */
function buildBasicAuthHeader(apiKey) {
  const cleanKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!cleanKey) {
    throw new Error("Clé API Intervals.icu manquante dans le coffre-fort.");
  }
  return `Basic ${encodeBase64(`API_KEY:${cleanKey}`)}`;
}

/**
 * Valide et normalise l'identifiant athlète (`0` ou `i?<chiffres>`).
 * @param {string|number} athleteId
 * @returns {string}
 */
function normalizeAthleteId(athleteId) {
  const raw =
    athleteId === undefined || athleteId === null
      ? "0"
      : String(athleteId).trim();
  const clean = raw === "" ? "0" : raw;
  if (!/^(0|i?\d+)$/.test(clean)) {
    throw new Error(
      'Identifiant athlète Intervals.icu invalide (attendu "0" ou "i?<chiffres>").'
    );
  }
  return encodeURIComponent(clean);
}

/**
 * Défense anti-prompt injection : supprime balises HTML et caractères de contrôle,
 * puis tronque à `maxLen` caractères.
 * @param {unknown} value
 * @param {number} [maxLen=180]
 * @returns {string}
 */
export function sanitizeText(value, maxLen = 180) {
  if (value === null || value === undefined) return "";
  const cleaned = String(value)
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
 * Formate une date locale en `YYYY-MM-DD`.
 * @param {Date} dateObj
 * @returns {string}
 */
function formatLocalYmd(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Formate une date locale en `YYYY-MM-DDTHH:mm:ss` (sans fuseau, format Intervals.icu).
 * @param {Date} dateObj
 * @returns {string}
 */
function formatLocalIsoDateTime(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const ymd = formatLocalYmd(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${ymd}T${hh}:${mm}:${ss}`;
}

/**
 * Retourne une nouvelle Date décalée de `deltaDays` jours.
 * @param {Date} dateObj
 * @param {number} deltaDays
 * @returns {Date}
 */
function addDays(dateObj, deltaDays) {
  const copy = new Date(dateObj.getTime());
  copy.setDate(copy.getDate() + deltaDays);
  return copy;
}

/**
 * Borne un nombre fini ou retourne `fallback`.
 * @param {unknown} val
 * @param {number} min
 * @param {number} max
 * @param {number|null} [fallback=null]
 * @returns {number|null}
 */
function clampFinite(val, min, max, fallback = null) {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Calcule le délai `Retry-After` en ms si présent.
 * @param {string|null} retryAfterHeader
 * @returns {number|null}
 */
function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30000);
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isFinite(targetMs)) {
    return Math.max(0, Math.min(targetMs - Date.now(), 30000));
  }
  return null;
}

/**
 * Pause asynchrone annulable par `AbortSignal`.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Requête annulée"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new Error("Requête annulée"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Exécute un appel `fetch` JSON avec backoff exponentiel + jitter
 * sur HTTP 429, HTTP 5xx et erreurs réseau transitoires.
 * @param {string} url
 * @param {RequestInit & {
 *   fetchImpl?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   baseDelayMs?: number,
 *   jitterMaxMs?: number,
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   randomFn?: () => number
 * }} [options={}]
 * @param {number} [maxRetries=3]
 * @returns {Promise<any>}
 */
export async function fetchJsonWithBackoff(url, options = {}, maxRetries = 3) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
    baseDelayMs = 400,
    jitterMaxMs = 250,
    sleepFn = defaultSleep,
    randomFn = Math.random,
    ...fetchOptions
  } = options ?? {};

  if (typeof fetchImpl !== "function") {
    throw new Error("Client fetch indisponible.");
  }

  const effectiveTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : 10000;
  const effectiveBaseDelay =
    Number.isFinite(Number(baseDelayMs)) && Number(baseDelayMs) >= 0
      ? Number(baseDelayMs)
      : 400;
  const effectiveJitterMax =
    Number.isFinite(Number(jitterMaxMs)) && Number(jitterMaxMs) >= 0
      ? Number(jitterMaxMs)
      : 250;

  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const parentSignal = fetchOptions.signal;
    const onParentAbort = () => controller.abort(parentSignal?.reason);

    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      controller.abort(
        new Error(`Timeout Intervals.icu dépassé (${effectiveTimeoutMs} ms)`)
      );
    }, effectiveTimeoutMs);

    try {
      let response;
      let text = "";
      try {
        response = await fetchImpl(url, {
          ...fetchOptions,
          signal: controller.signal,
        });

        if (response.ok) {
          if (response.status === 204) return null;
          text = await response.text();
        } else {
          const isRateLimit = response.status === 429;
          const isServerErr = response.status >= 500 && response.status < 600;
          if (!(isRateLimit || isServerErr) || attempt >= maxRetries) {
            let errorSnippet = "";
            try {
              errorSnippet = sanitizeText(await response.text(), 160);
            } catch {
              errorSnippet = "";
            }
            throw new Error(
              `Erreur HTTP ${response.status} Intervals.icu${errorSnippet ? ` : ${errorSnippet}` : ""}`
            );
          }
        }
      } finally {
        clearTimeout(timer);
        if (parentSignal) {
          parentSignal.removeEventListener("abort", onParentAbort);
        }
      }

      if (response.ok) {
        if (!text || text.trim().length === 0) return null;
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new Error(
            `Réponse JSON invalide depuis Intervals.icu : ${err.message}`
          );
        }
      }

      const isRateLimit = response.status === 429;
      const retryAfter = isRateLimit
        ? parseRetryAfterMs(response.headers?.get?.("Retry-After") ?? null)
        : null;
      const expDelay = effectiveBaseDelay * Math.pow(2, attempt);
      const jitter = Math.floor(randomFn() * (effectiveJitterMax + 1));
      const delayMs =
        retryAfter !== null ? retryAfter + jitter : expDelay + jitter;
      attempt += 1;
      await sleepFn(delayMs, parentSignal);
      continue;
    } catch (err) {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }

      const isAbort =
        err?.name === "AbortError" ||
        Boolean(parentSignal?.aborted) ||
        controller.signal.aborted;
      const isFormattedHttpError =
        err instanceof Error && err.message.startsWith("Erreur HTTP ");
      const isInvalidJsonError =
        err instanceof Error &&
        err.message.startsWith("Réponse JSON invalide");

      if (
        isAbort ||
        isFormattedHttpError ||
        isInvalidJsonError ||
        attempt >= maxRetries
      ) {
        throw err;
      }

      const expDelay = effectiveBaseDelay * Math.pow(2, attempt);
      const jitter = Math.floor(randomFn() * (effectiveJitterMax + 1));
      attempt += 1;
      await sleepFn(expDelay + jitter, parentSignal);
    }
  }
}

/**
 * Normalise une activité Intervals.icu du jour pour `engine.js`
 * (type `strength` / `ride`, `endTime`, `intensity`, `if`, `tss`, `rpe`).
 * @param {Record<string, any>} act
 * @returns {Record<string, any> | null}
 */
export function normalizeTodayActivity(act) {
  if (!act || typeof act !== "object") return null;

  const rawType = String(act.type ?? "").trim();
  const lowerType = rawType.toLowerCase();

  let normalizedType = "other";
  if (STRENGTH_ACTIVITY_TYPES.has(lowerType)) {
    normalizedType = "strength";
  } else if (RIDE_ACTIVITY_TYPES.has(lowerType)) {
    normalizedType = "ride";
  } else if (lowerType === "virtualrun" || lowerType === "trailrun") {
    normalizedType = "run";
  } else if (ALLOWED_NORMALIZED_TYPES.has(lowerType)) {
    normalizedType = lowerType;
  }

  const startRaw = act.start_date_local ?? act.start_date ?? null;
  const rawDurationSec =
    clampFinite(act.elapsed_time, 1, 86400, null) ??
    clampFinite(act.moving_time, 1, 86400, null);
  const durationSec = rawDurationSec ?? 0;

  let endTime = act.endTime ?? act.end_date_local ?? null;
  if (!endTime && typeof startRaw === "string" && startRaw.trim()) {
    const startMs = Date.parse(startRaw);
    if (Number.isFinite(startMs)) {
      const effectiveDurationSec = rawDurationSec ?? 3600;
      endTime = new Date(startMs + effectiveDurationSec * 1000).toISOString();
    }
  }

  // Intervals.icu expose `icu_intensity` (en %, ex. 88 = IF 0.88) ou `if` (ratio)
  const rawIcuIntensity = clampFinite(act.icu_intensity, 0, 300, null);
  const rawIf = clampFinite(act.if, 0, 3, null);
  const intensityFactor =
    rawIf ?? (rawIcuIntensity !== null ? Math.round(rawIcuIntensity) / 100 : null);
  const tss = clampFinite(act.icu_training_load ?? act.tss, 0, 2000, null);
  const rpe = clampFinite(act.icu_rpe ?? act.rpe, 1, 10, null);

  const rawIntensity =
    typeof act.intensity === "string" ? act.intensity.trim().toLowerCase() : "";

  const name = sanitizeText(act.name ?? rawType, 120);
  const isHigh =
    rawIntensity === "high" ||
    rawIntensity === "intense" ||
    rawIntensity === "hiit" ||
    (intensityFactor !== null && intensityFactor >= 0.85) ||
    (rpe !== null && rpe >= 7) ||
    (tss !== null && tss >= 80) ||
    /\b(hiit|vo2|seuil|threshold|pma|sprint)\b/i.test(name);

  let intensity = "moderate";
  if (isHigh) {
    intensity = "high";
  } else if (
    rawIntensity === "low" ||
    (intensityFactor !== null && intensityFactor < 0.65) ||
    (rpe !== null && rpe <= 4) ||
    (tss !== null && tss > 0 && tss < 35)
  ) {
    intensity = "low";
  }

  return {
    id: sanitizeText(act.id ?? "", 80),
    type: normalizedType,
    rawType: sanitizeText(rawType, 40),
    name,
    startTime: typeof startRaw === "string" ? sanitizeText(startRaw, 40) : null,
    endTime,
    durationSec,
    intensity,
    if: intensityFactor,
    tss,
    rpe,
    intense: isHigh,
  };
}

/**
 * Lit le contexte physiologique 7 jours (wellness + activités du jour) depuis Intervals.icu.
 * Retourne un objet directement compatible avec `computeRecoveryScore`, `isAllowed` et `selectProtocol`.
 *
 * @param {object} [options={}]
 * @param {string|number} [options.athleteId]
 * @param {string} [options.apiKey]
 * @param {Date|number|string} [options.now]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelayMs=400]
 * @param {number} [options.jitterMaxMs=250]
 * @param {AbortSignal} [options.signal]
 */
export async function fetchRecoveryContext(options = {}) {
  const { athleteId, apiKey } = resolveCredentials(options);
  const aid = normalizeAthleteId(athleteId);
  const authHeader = buildBasicAuthHeader(apiKey);

  const nowDate =
    options.now instanceof Date
      ? options.now
      : options.now !== undefined
        ? new Date(options.now)
        : new Date();
  const j0 = formatLocalYmd(nowDate);
  const j7 = formatLocalYmd(addDays(nowDate, -7));

  const headers = {
    Authorization: authHeader,
    Accept: "application/json",
  };

  const requestOpts = {
    method: "GET",
    headers,
    fetchImpl: options.fetchImpl,
    baseDelayMs: options.baseDelayMs,
    jitterMaxMs: options.jitterMaxMs,
    signal: options.signal,
  };

  const maxRetries = options.maxRetries ?? 3;

  const [wellnessRaw, activitiesRaw] = await Promise.all([
    fetchJsonWithBackoff(
      `${INTERVALS_BASE_URL}/athlete/${aid}/wellness?oldest=${j7}&newest=${j0}`,
      requestOpts,
      maxRetries
    ),
    fetchJsonWithBackoff(
      `${INTERVALS_BASE_URL}/athlete/${aid}/activities?oldest=${j7}&newest=${j0}`,
      requestOpts,
      maxRetries
    ),
  ]);

  const wellnessList = (Array.isArray(wellnessRaw) ? wellnessRaw : [])
    .filter((w) => w && typeof w === "object")
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));

  const latestWellness =
    wellnessList.find((w) => w.id === j0) ??
    (wellnessList.length > 0 ? wellnessList[wellnessList.length - 1] : null);

  const hrvHistory7d = wellnessList
    .map((w) => clampFinite(w.hrv, 0, 500, null))
    .filter((v) => v !== null && v > 0)
    .slice(-7);

  const rawHrvToday = clampFinite(latestWellness?.hrv, 0, 500, null);
  const hrvToday =
    rawHrvToday !== null && rawHrvToday > 0
      ? rawHrvToday
      : hrvHistory7d.length > 0
        ? hrvHistory7d[hrvHistory7d.length - 1]
        : null;

  const sleepSecs = clampFinite(
    latestWellness?.sleepSecs ?? latestWellness?.sleep_secs,
    0,
    86400,
    null
  );
  const sleepHours =
    sleepSecs !== null ? Math.round((sleepSecs / 3600) * 100) / 100 : null;
  const sleepScore = clampFinite(
    latestWellness?.sleepScore ?? latestWellness?.sleep_score,
    0,
    100,
    null
  );

  const ctl = clampFinite(latestWellness?.ctl, 0, 500, null);
  const atl = clampFinite(latestWellness?.atl, 0, 500, null);
  const rawTsb = clampFinite(latestWellness?.tsb, -200, 200, null);
  const tsb =
    rawTsb ??
    (ctl !== null && atl !== null
      ? clampFinite(Math.round((ctl - atl) * 10) / 10, -200, 200, null)
      : null);

  const activities = Array.isArray(activitiesRaw) ? activitiesRaw : [];
  const todayActivities = activities
    .filter((act) => {
      if (!act || typeof act !== "object") return false;
      const dateStr = String(act.start_date_local ?? act.start_date ?? "").slice(
        0,
        10
      );
      return dateStr === j0;
    })
    .map(normalizeTodayActivity)
    .filter(Boolean);

  return {
    fetchedAt: nowDate.toISOString(),
    date: j0,
    hrvToday,
    hrvHistory7d,
    sleepSecs,
    sleepHours,
    sleepScore,
    ctl,
    atl,
    tsb,
    todayActivities,
  };
}

/**
 * Construit le payload Intervals.icu d'une séance de récupération WebRecovery
 * incluant les champs personnalisés `RecoveryLoad` et `RecoveryType`.
 * @param {object} sessionData
 * @returns {Record<string, any>}
 */
export function buildRecoveryActivityPayload(sessionData = {}) {
  const nowDate =
    sessionData.timestamp instanceof Date
      ? sessionData.timestamp
      : sessionData.timestamp
        ? new Date(sessionData.timestamp)
        : new Date();
  const safeDate = Number.isNaN(nowDate.getTime()) ? new Date() : nowDate;

  const durationSec = Math.max(
    60,
    Math.round(Number(sessionData.elapsedSec ?? sessionData.durationSec) || 600)
  );
  const rpe = clampFinite(sessionData.rpe, 1, 10, 4);
  const recoveryType =
    sanitizeText(
      sessionData.recoveryType ??
        sessionData.protocolId ??
        sessionData.family ??
        "recovery",
      60
    ) || "recovery";

  const recoveryLoad =
    clampFinite(sessionData.recoveryLoad, 0, 500, null) ??
    Math.round((durationSec / 60) * rpe * 0.5);

  const externalId =
    sanitizeText(sessionData.external_id, 80) ||
    `webrecovery_${safeDate.getTime()}`;

  const name =
    sanitizeText(
      sessionData.name ?? `WebRecovery — ${recoveryType}`,
      120
    ) || "WebRecovery — Récupération";

  const notes = sanitizeText(sessionData.notes ?? "", 240);
  const itemsList = Array.isArray(sessionData.items)
    ? sessionData.items
        .map((it) => sanitizeText(typeof it === "string" ? it : it?.name ?? it?.id, 60))
        .filter(Boolean)
    : [];

  const descLines = [
    `WebRecovery (${recoveryType})`,
    itemsList.length > 0 ? `Exercices : ${itemsList.join(", ")}` : "",
    `RPE : ${rpe}/10 · RecoveryLoad : ${recoveryLoad}`,
    sessionData.interrupted
      ? `Interrompue sécurité : ${sanitizeText(sessionData.reason ?? "SpO2", 120)}`
      : "",
    notes ? `Ressenti : ${notes}` : "",
  ].filter(Boolean);

  return {
    external_id: externalId,
    name,
    type: "Workout",
    start_date_local: formatLocalIsoDateTime(safeDate),
    elapsed_time: durationSec,
    moving_time: durationSec,
    icu_rpe: rpe,
    icu_training_load: recoveryLoad,
    description: descLines.join("\n"),
    RecoveryLoad: recoveryLoad,
    RecoveryType: recoveryType,
  };
}

/**
 * Envoie un payload déjà construit vers Intervals.icu (POST + PUT champs custom)
 * sans passer par l'outbox (utilisé par `publishRecoveryWorkout` et `flushPendingRecoveryWorkouts`).
 * @param {object} params
 * @returns {Promise<any>}
 */
export async function sendRecoveryPayloadToIntervals({
  athleteId,
  apiKey,
  payload,
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  baseDelayMs = 400,
  jitterMaxMs = 250,
}) {
  const creds = resolveCredentials({ athleteId, apiKey });
  const aid = normalizeAthleteId(creds.athleteId);
  const authHeader = buildBasicAuthHeader(creds.apiKey);

  const normalizedPayload =
    payload && typeof payload === "object" && payload.RecoveryType !== undefined
      ? payload
      : buildRecoveryActivityPayload(payload ?? {});

  const createEndpoint = `${INTERVALS_BASE_URL}/athlete/${aid}/activities/manual`;
  const reqBase = {
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    fetchImpl,
    baseDelayMs,
    jitterMaxMs,
  };

  const created = await fetchJsonWithBackoff(
    createEndpoint,
    {
      ...reqBase,
      method: "POST",
      body: JSON.stringify(normalizedPayload),
    },
    maxRetries
  );

  if (
    created?.id !== undefined &&
    created?.id !== null &&
    String(created.id).trim() !== ""
  ) {
    const activityEndpoint = `${INTERVALS_BASE_URL}/activity/${encodeURIComponent(
      String(created.id)
    )}`;
    try {
      await fetchJsonWithBackoff(
        activityEndpoint,
        {
          ...reqBase,
          method: "PUT",
          body: JSON.stringify({
            icu_training_load: normalizedPayload.icu_training_load,
            RecoveryLoad: normalizedPayload.RecoveryLoad,
            RecoveryType: normalizedPayload.RecoveryType,
          }),
        },
        maxRetries
      );
    } catch {
      // Ne jamais masquer la création déjà réussie si le PUT des champs custom échoue
    }
  }

  return created;
}

/**
 * Publie une séance de récupération sur Intervals.icu + champs custom `RecoveryLoad`/`RecoveryType`.
 * En cas d'échec (hors-ligne, clé absente, erreur réseau/HTTP), enfile dans `outbox.js`.
 *
 * @param {object} params
 * @param {string|number} [params.athleteId]
 * @param {string} [params.apiKey]
 * @param {object} [params.session]
 * @param {object} [params.payload]
 * @param {typeof globalThis.fetch} [params.fetchImpl]
 * @param {{ enqueueOutbox: Function }} [params.outboxImpl]
 * @param {number} [params.maxRetries=3]
 * @param {number} [params.baseDelayMs=400]
 * @param {number} [params.jitterMaxMs=250]
 */
export async function publishRecoveryWorkout({
  athleteId,
  apiKey,
  session,
  payload,
  fetchImpl = globalThis.fetch,
  outboxImpl = { enqueueOutbox },
  maxRetries = 3,
  baseDelayMs = 400,
  jitterMaxMs = 250,
} = {}) {
  const finalPayload =
    payload && typeof payload === "object"
      ? payload
      : buildRecoveryActivityPayload(session ?? {});

  const creds = resolveCredentials({ athleteId, apiKey });
  const isOffline =
    typeof globalThis?.navigator !== "undefined" &&
    globalThis.navigator?.onLine === false;

  if (!creds.apiKey || isOffline) {
    await outboxImpl.enqueueOutbox(finalPayload);
    return {
      ok: false,
      queued: true,
      external_id: finalPayload.external_id,
      payload: finalPayload,
      reason: isOffline
        ? "Mode hors-ligne : séance mise en file Outbox."
        : "Clé API Intervals.icu absente : séance mise en file Outbox.",
    };
  }

  try {
    const created = await sendRecoveryPayloadToIntervals({
      athleteId: creds.athleteId,
      apiKey: creds.apiKey,
      payload: finalPayload,
      fetchImpl,
      maxRetries,
      baseDelayMs,
      jitterMaxMs,
    });
    return {
      ok: true,
      queued: false,
      external_id: finalPayload.external_id,
      activity: created,
      payload: finalPayload,
    };
  } catch (err) {
    await outboxImpl.enqueueOutbox(finalPayload);
    return {
      ok: false,
      queued: true,
      external_id: finalPayload.external_id,
      payload: finalPayload,
      reason:
        err instanceof Error
          ? err.message
          : "Échec envoi Intervals.icu : séance mise en file Outbox.",
    };
  }
}

/**
 * Vide la file Outbox en renvoyant chaque activité de récupération vers Intervals.icu.
 * @param {object} [options={}]
 */
export async function flushPendingRecoveryWorkouts({
  athleteId,
  apiKey,
  fetchImpl = globalThis.fetch,
  outboxImpl = { flushOutbox },
  maxRetries = 3,
  baseDelayMs = 400,
  jitterMaxMs = 250,
} = {}) {
  const creds = resolveCredentials({ athleteId, apiKey });
  if (!creds.apiKey) {
    throw new Error("Clé API Intervals.icu manquante dans le coffre-fort.");
  }

  return outboxImpl.flushOutbox(async (payload) =>
    sendRecoveryPayloadToIntervals({
      athleteId: creds.athleteId,
      apiKey: creds.apiKey,
      payload,
      fetchImpl,
      maxRetries,
      baseDelayMs,
      jitterMaxMs,
    })
  );
}
