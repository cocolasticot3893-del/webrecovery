// GENERATED from shared/ - do not edit
/**
 * Module partagé de synchronisation des exercices/protocoles personnalisés
 * vers Google Drive via un webhook Google Apps Script (CORS simple request sans preflight).
 * Zéro dépendance externe — compatible navigateur et Node.js ESM.
 */

export const DRIVE_APP_VERSION = "1.0.0";

const STRICT_APPS_SCRIPT_URL_RE =
  /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

/**
 * Résultat de validation d'une URL de webhook Google Drive.
 * @typedef {Object} DriveWebhookValidationResult
 * @property {boolean} valid Indique si l'URL est utilisable en HTTPS sans identifiants intégrés.
 * @property {string} url URL nettoyée ou chaîne vide si absente.
 * @property {boolean} isAppsScript Indique si l'URL cible un déploiement Google Apps Script (`/macros/s/.../exec`).
 * @property {string | null} error Message d'erreur en français ou `null` si valide.
 */

/**
 * Options de validation d'une URL de webhook Google Drive.
 * @typedef {Object} ValidateDriveWebhookOptions
 * @property {boolean} [requireAppsScript=true] Exige strictement un domaine Google Apps Script.
 */

/**
 * Paramètres d'envoi des exercices personnalisés vers Google Drive.
 * @typedef {Object} PushCustomExercisesOptions
 * @property {string} webhookUrl URL HTTPS du webhook cible.
 * @property {string} [secret=""] Secret partagé optionnel transmis dans le corps JSON.
 * @property {string | Array<unknown> | Record<string, unknown>} exercisesJson Chaîne JSON ou structure d'exercices non vide.
 * @property {typeof globalThis.fetch} [fetchImpl=globalThis.fetch] Implémentation `fetch` injectable pour les tests.
 * @property {number} [timeoutMs=15000] Délai d'expiration réseau en millisecondes (plancher à 50 ms).
 * @property {Date} [now=new Date()] Horodatage utilisé pour nommer et tracer l'export.
 * @property {string} [app=""] Identifiant d'application optionnel inclus dans le payload et le nom de fichier.
 * @property {string} [appVersion=DRIVE_APP_VERSION] Version d'application transmise dans `app_version`.
 * @property {boolean} [requireAppsScript=true] Rejette les webhooks HTTPS hors Apps Script si `true`.
 * @property {string} [filenamePrefix] Préfixe personnalisé du fichier exporté (remplace `${app}-custom-exercises`).
 * @property {string} [filename] Nom de fichier explicite (court-circuite `buildDriveExportFilename`).
 */

/**
 * Réponse normalisée d'un envoi réussi vers Google Drive.
 * @typedef {Object} PushCustomExercisesResult
 * @property {true} ok Confirmation de succès de l'export.
 * @property {string} fileId Identifiant du fichier créé sur Google Drive.
 * @property {string} fileName Nom effectif du fichier créé.
 * @property {string} folderName Nom du dossier Google Drive cible.
 * @property {number} count Nombre d'exercices exportés.
 */

/**
 * Formate un entier sur 2 chiffres avec zéro initial.
 * @param {number} value
 * @returns {string}
 */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * Valide l'URL d'un webhook Google Drive (HTTPS strict, sans identifiants intégrés).
 * @param {unknown} url
 * @param {ValidateDriveWebhookOptions} [options]
 * @returns {DriveWebhookValidationResult}
 */
export function validateDriveWebhookUrl(
  url,
  { requireAppsScript = true } = {}
) {
  if (typeof url !== "string") {
    return {
      valid: false,
      url: "",
      isAppsScript: false,
      error: "L'URL du webhook Google Drive doit être une chaîne de caractères.",
    };
  }

  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      url: "",
      isAppsScript: false,
      error: "L'URL du webhook Google Drive est vide.",
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      url: trimmed,
      isAppsScript: false,
      error: "L'URL du webhook Google Drive est malformée.",
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      url: trimmed,
      isAppsScript: false,
      error: "L'URL du webhook Google Drive doit utiliser le protocole HTTPS.",
    };
  }

  if (!parsed.hostname) {
    return {
      valid: false,
      url: trimmed,
      isAppsScript: false,
      error: "L'URL du webhook Google Drive ne contient pas de nom d'hôte valide.",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      url: trimmed,
      isAppsScript: false,
      error:
        "L'URL du webhook Google Drive ne doit pas contenir d'identifiants intégrés.",
    };
  }

  const isAppsScript =
    STRICT_APPS_SCRIPT_URL_RE.test(trimmed) &&
    parsed.search === "" &&
    parsed.hash === "";

  if (requireAppsScript && !isAppsScript) {
    return {
      valid: false,
      url: trimmed,
      isAppsScript: false,
      error:
        "L'URL du webhook Google Drive doit correspondre exactement à https://script.google.com/macros/s/<ID>/exec (sans query ni hash).",
    };
  }

  return {
    valid: true,
    url: trimmed,
    isAppsScript,
    error: null,
  };
}

/**
 * Construit le nom de fichier horodaté en heure locale pour l'export Drive.
 * @param {Date} [date=new Date()]
 * @param {object} [options]
 * @param {string} [options.app="app"] Identifiant d'application utilisé en préfixe.
 * @param {string} [options.prefix] Préfixe complet avant l'horodatage.
 * @returns {string}
 */
export function buildDriveExportFilename(
  date = new Date(),
  { app = "app", prefix } = {}
) {
  const safeDate =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();

  const year = String(safeDate.getFullYear());
  const month = pad2(safeDate.getMonth() + 1);
  const day = pad2(safeDate.getDate());
  const hours = pad2(safeDate.getHours());
  const minutes = pad2(safeDate.getMinutes());
  const seconds = pad2(safeDate.getSeconds());

  const cleanApp =
    typeof app === "string" && app.trim().length > 0 ? app.trim() : "app";
  const cleanPrefix =
    typeof prefix === "string" && prefix.trim().length > 0
      ? prefix.trim()
      : `${cleanApp}-custom-exercises`;

  return `${cleanPrefix}-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}

/**
 * Analyse et valide la structure des exercices personnalisés à exporter.
 * @param {unknown} exercisesJson
 * @returns {{ parsed: Array<unknown> | Record<string, unknown>, count: number }}
 */
function parseAndCountExercises(exercisesJson) {
  let parsed = exercisesJson;
  if (typeof exercisesJson === "string") {
    try {
      parsed = JSON.parse(exercisesJson);
    } catch (err) {
      throw new Error(
        `Le JSON des exercices personnalisés est invalide : ${err.message}`
      );
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Aucun exercice personnalisé à envoyer sur Drive.");
  }

  const count = Array.isArray(parsed)
    ? parsed.length
    : Object.keys(parsed).length;

  if (count <= 0) {
    throw new Error("Aucun exercice personnalisé à envoyer sur Drive.");
  }

  return {
    parsed: /** @type {Array<unknown> | Record<string, unknown>} */ (parsed),
    count,
  };
}

/**
 * Envoie les exercices personnalisés vers le webhook Google Drive via une requête CORS simple.
 * @param {PushCustomExercisesOptions} [options]
 * @returns {Promise<PushCustomExercisesResult>}
 */
export async function pushCustomExercisesToDrive({
  webhookUrl,
  secret = "",
  exercisesJson,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  now = new Date(),
  app = "",
  appVersion = DRIVE_APP_VERSION,
  requireAppsScript = true,
  filenamePrefix,
  filename: explicitFilename,
} = {}) {
  const check = validateDriveWebhookUrl(webhookUrl, { requireAppsScript });
  if (!check.valid) {
    throw new Error(check.error || "URL de webhook Google Drive invalide.");
  }

  const { parsed, count } = parseAndCountExercises(exercisesJson);

  if (typeof fetchImpl !== "function") {
    throw new Error("Client fetch indisponible pour l'envoi vers Google Drive.");
  }

  const safeNow =
    now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const cleanApp = typeof app === "string" ? app.trim() : "";
  const filename =
    typeof explicitFilename === "string" && explicitFilename.trim().length > 0
      ? explicitFilename.trim()
      : buildDriveExportFilename(safeNow, {
          app: cleanApp || "app",
          prefix: filenamePrefix,
        });
  const effectiveTimeoutMs = Math.max(50, Number(timeoutMs) || 15000);

  const controller = new AbortController();
  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);

  const bodyPayload = {
    secret: String(secret ?? "").trim(),
    filename,
    exported_at: safeNow.toISOString(),
    app_version:
      typeof appVersion === "string" && appVersion.trim().length > 0
        ? appVersion.trim()
        : DRIVE_APP_VERSION,
    ...(cleanApp ? { app: cleanApp } : {}),
    exercises: parsed,
  };

  let response;
  try {
    // Requête CORS simple sans preflight OPTIONS : text/plain + aucun en-tête personnalisé.
    response = await fetchImpl(check.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      redirect: "follow",
      signal: controller.signal,
      body: JSON.stringify(bodyPayload),
    });
  } catch (err) {
    if (timedOut || (err && err.name === "AbortError")) {
      throw new Error(
        `Timeout webhook Google Drive dépassé (${effectiveTimeoutMs} ms).`
      );
    }
    const reason = err instanceof Error && err.message ? err.message : String(err);
    throw new Error(
      `Échec réseau lors de l'envoi vers le webhook Google Drive : ${reason}`
    );
  } finally {
    clearTimeout(timerId);
  }

  if (!response.ok) {
    throw new Error(
      `Erreur HTTP du webhook Google Drive (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`
    );
  }

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      "Réponse non-JSON reçue du webhook Google Drive (vérifiez le déploiement et les accès Apps Script)."
    );
  }

  if (!data || data.ok !== true) {
    throw new Error(data?.error || "Réponse négative du webhook Google Drive");
  }

  return {
    ok: true,
    fileId: String(data.fileId ?? ""),
    fileName: String(data.fileName ?? filename),
    folderName: String(data.folderName ?? ""),
    count: Number(data.count ?? count),
  };
}

/**
 * Crée un client Drive Sync pré-configuré pour une application donnée.
 * @param {object} [config]
 * @param {string} [config.app=""] Identifiant d'application (`"webstrength"`, `"webbreath"`, `"webrecovery"`, ...).
 * @param {string} [config.appVersion=DRIVE_APP_VERSION] Version par défaut de l'application.
 * @param {boolean} [config.requireAppsScript=true] Exige un domaine Google Apps Script par défaut.
 * @param {string} [config.filenamePrefix] Préfixe de fichier par défaut.
 * @param {number} [config.timeoutMs=15000] Timeout réseau par défaut en millisecondes.
 */
export function createDriveSync(config = {}) {
  const {
    app = "",
    appVersion = DRIVE_APP_VERSION,
    requireAppsScript = true,
    filenamePrefix,
    timeoutMs = 15000,
  } = config;

  return {
    DRIVE_APP_VERSION: appVersion,
    validateDriveWebhookUrl: (url, opts = {}) =>
      validateDriveWebhookUrl(url, {
        requireAppsScript,
        ...opts,
      }),
    buildDriveExportFilename: (date = new Date(), opts = {}) =>
      buildDriveExportFilename(date, {
        app: app || "app",
        prefix: filenamePrefix,
        ...opts,
      }),
    pushCustomExercisesToDrive: (opts = {}) =>
      pushCustomExercisesToDrive({
        app,
        appVersion,
        requireAppsScript,
        filenamePrefix,
        timeoutMs,
        ...opts,
      }),
  };
}
