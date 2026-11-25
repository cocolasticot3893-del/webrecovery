// GENERATED from shared/ - do not edit
/**
 * Coffre-fort local unifié partagé entre les applications 01_SPORT_BIO
 * (WebStrength, WebBreath, WebRecovery, WebNeuro, PhysioPulse).
 * Partage la clé `GLOBAL_ATHLETE_VAULT_V1` sans jamais écraser les clés tierces
 * tout en synchronisant les 4 clés plates `FLAT_KEYS`.
 * Zéro dépendance externe — compatible navigateur et Node.js ESM.
 */

export const VAULT_KEY = "GLOBAL_ATHLETE_VAULT_V1";

export const FLAT_KEYS = Object.freeze([
  "INTERVALS_ATHLETE_ID",
  "INTERVALS_API_KEY",
  "GEMINI_API_KEY",
  "LLM_MODEL",
]);

export const DEFAULT_SECRET_KEYS = Object.freeze([
  "INTERVALS_API_KEY",
  "GEMINI_API_KEY",
  "DRIVE_WEBHOOK_URL",
  "DRIVE_WEBHOOK_SECRET",
]);

export const DEFAULT_VAULT = Object.freeze({
  INTERVALS_ATHLETE_ID: "0",
  INTERVALS_API_KEY: "",
  GEMINI_API_KEY: "",
  LLM_MODEL: "gemini-3.5-flash",
  DRIVE_WEBHOOK_URL: "",
  DRIVE_WEBHOOK_SECRET: "",
  updatedAt: null,
});

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Retourne `globalThis.localStorage` s'il est accessible sans exception, sinon `null`.
 * @returns {Storage | null}
 */
function getSafeLocalStorage() {
  try {
    if (
      typeof window === "undefined" &&
      typeof process !== "undefined" &&
      Boolean(process.versions?.node)
    ) {
      const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      const hasStorageFileFlag =
        Array.isArray(process.execArgv) &&
        process.execArgv.some((arg) => arg.startsWith("--localstorage-file"));
      if (desc && typeof desc.get === "function" && !hasStorageFileFlag) {
        return null;
      }
    }
    const ls = globalThis?.localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function"
    ) {
      return ls;
    }
  } catch {
    // Contexte restreint ou Node.js sans WebStorage activé
  }
  return null;
}

/**
 * Copie les propriétés sûres d'un objet brut vers un objet neuf sans pollution de prototype.
 * @param {unknown} source
 * @returns {Record<string, unknown>}
 */
export function copySafeProperties(source) {
  const clean = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return clean;
  }
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    Object.defineProperty(clean, key, {
      value: source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clean;
}

/**
 * Parse un objet JSON de manière défensive (retourne `{}` si invalide ou non-objet,
 * et filtre les clés dangereuses `__proto__`, `constructor`, `prototype`).
 * @param {string | null} raw
 * @returns {Record<string, unknown>}
 */
function parseVaultObject(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return copySafeProperties(parsed);
    }
  } catch {
    // JSON corrompu ignoré
  }
  return {};
}

/**
 * Normalise une chaîne de configuration.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeString(value, fallback) {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Normalise un entier ou flottant borné positif (arrondi au dixième).
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function normalizePositiveNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
}

/**
 * Clone profondément une valeur JSON-compatible pour éviter les mutations partagées.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneValue(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return Array.isArray(value) ? /** @type {T} */ ([...value]) : /** @type {T} */ ({ ...value });
  }
}

/**
 * Crée une instance de coffre-fort paramétrée pour une application spécifique.
 * @param {object} [config]
 * @param {string} [config.vaultKey="GLOBAL_ATHLETE_VAULT_V1"] Clé de stockage principale.
 * @param {readonly string[]} [config.flatKeys=FLAT_KEYS] Clés plates synchronisées dans `localStorage`.
 * @param {Record<string, unknown>} [config.defaults={}] Clés et valeurs par défaut propres à l'application.
 * @param {Record<string, (value: unknown, merged: Record<string, unknown>, defaults: Record<string, unknown>) => unknown>} [config.normalizers={}] Normaliseurs par clé spécifique.
 * @param {Record<string, unknown>} [config.resetDefaults] Valeurs réinitialisées par `resetVault()` (par défaut : `config.defaults`).
 * @param {boolean} [config.defaultIncludeSecrets=false] Comportement par défaut de `exportVaultJson()`.
 * @param {readonly string[]} [config.secretKeys=DEFAULT_SECRET_KEYS] Clés masquées quand `includeSecrets === false`.
 */
export function createVault({
  vaultKey = VAULT_KEY,
  flatKeys = FLAT_KEYS,
  defaults = {},
  normalizers = {},
  resetDefaults,
  defaultIncludeSecrets = false,
  secretKeys = DEFAULT_SECRET_KEYS,
} = {}) {
  const effectiveVaultKey =
    typeof vaultKey === "string" && vaultKey.trim() ? vaultKey.trim() : VAULT_KEY;
  const effectiveFlatKeys = Object.freeze(
    Array.isArray(flatKeys) && flatKeys.length > 0 ? [...flatKeys] : [...FLAT_KEYS]
  );
  const safeAppDefaults = copySafeProperties(defaults);
  const effectiveDefaults = Object.freeze({
    ...DEFAULT_VAULT,
    ...safeAppDefaults,
  });
  const effectiveNormalizers = copySafeProperties(normalizers);
  const effectiveResetDefaults = copySafeProperties(
    resetDefaults !== undefined ? resetDefaults : safeAppDefaults
  );
  const effectiveSecretKeys = Object.freeze(
    Array.isArray(secretKeys) ? [...secretKeys] : [...DEFAULT_SECRET_KEYS]
  );

  /** Repli mémoire utilisé uniquement si `globalThis.localStorage` est indisponible (Node.js). */
  const memoryFallback = new Map();

  /**
   * Lit une clé brute depuis `localStorage` ou le repli mémoire.
   * @param {string} key
   * @returns {string | null}
   */
  function safeGetItem(key) {
    const ls = getSafeLocalStorage();
    if (ls) {
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    }
    return memoryFallback.has(key) ? memoryFallback.get(key) : null;
  }

  /**
   * Écrit une clé brute dans `localStorage` ou le repli mémoire.
   * @param {string} key
   * @param {string} value
   */
  function safeSetItem(key, value) {
    const ls = getSafeLocalStorage();
    if (ls) {
      try {
        ls.setItem(key, String(value));
        return;
      } catch {
        // Quota dépassé ou stockage en lecture seule : repli mémoire silencieux
      }
    }
    memoryFallback.set(key, String(value));
  }

  /**
   * Normalise les clés partagées et propres à l'app en préservant toutes les clés tierces.
   * @param {Record<string, unknown>} rawSource
   * @param {Record<string, unknown>} [flatFallback]
   * @returns {Record<string, unknown>}
   */
  function normalizeVaultRecord(rawSource, flatFallback = {}) {
    const merged = { ...rawSource };

    for (const key of effectiveFlatKeys) {
      const candidate = merged[key] ?? flatFallback[key];
      const fallbackVal =
        typeof effectiveDefaults[key] === "string"
          ? effectiveDefaults[key]
          : "";
      merged[key] = normalizeString(candidate, fallbackVal);
    }

    merged.DRIVE_WEBHOOK_URL = normalizeString(
      merged.DRIVE_WEBHOOK_URL,
      String(effectiveDefaults.DRIVE_WEBHOOK_URL ?? "")
    );
    merged.DRIVE_WEBHOOK_SECRET = normalizeString(
      merged.DRIVE_WEBHOOK_SECRET,
      String(effectiveDefaults.DRIVE_WEBHOOK_SECRET ?? "")
    );

    for (const [key, defaultVal] of Object.entries(safeAppDefaults)) {
      if (key in effectiveNormalizers && typeof effectiveNormalizers[key] === "function") {
        merged[key] = effectiveNormalizers[key](
          merged[key],
          merged,
          effectiveDefaults
        );
      } else if (merged[key] === undefined) {
        merged[key] = cloneValue(defaultVal);
      }
    }

    for (const [key, fn] of Object.entries(effectiveNormalizers)) {
      if (!(key in safeAppDefaults) && typeof fn === "function") {
        merged[key] = fn(merged[key], merged, effectiveDefaults);
      }
    }

    merged.updatedAt =
      typeof merged.updatedAt === "string" && merged.updatedAt.trim().length > 0
        ? merged.updatedAt
        : null;

    return merged;
  }

  /**
   * Charge le coffre-fort en préservant les clés tierces et en synchronisant les clés plates.
   * @returns {Record<string, unknown>}
   */
  function loadVault() {
    const existing = parseVaultObject(safeGetItem(effectiveVaultKey));
    /** @type {Record<string, unknown>} */
    const flatValues = {};

    for (const key of effectiveFlatKeys) {
      const val = safeGetItem(key);
      if (typeof val === "string" && val.trim().length > 0) {
        flatValues[key] = val.trim();
      }
    }

    return normalizeVaultRecord(existing, flatValues);
  }

  /**
   * Sauvegarde un patch dans le coffre-fort en préservant toutes les clés tierces
   * et en synchronisant `FLAT_KEYS`.
   * @param {Record<string, unknown>} [patch={}]
   * @returns {Record<string, unknown>}
   */
  function saveVault(patch = {}) {
    const current = parseVaultObject(safeGetItem(effectiveVaultKey));
    const incoming = copySafeProperties(patch);

    const combined = {
      ...current,
      ...incoming,
      updatedAt: new Date().toISOString(),
    };

    const normalized = normalizeVaultRecord(combined);
    safeSetItem(effectiveVaultKey, JSON.stringify(normalized));

    for (const key of effectiveFlatKeys) {
      safeSetItem(key, String(normalized[key] ?? ""));
    }

    return normalized;
  }

  /**
   * Réinitialise les réglages propres à l'application aux valeurs par défaut
   * sans jamais écraser les clés tierces ni les clés partagées.
   * @param {Record<string, unknown>} [overrideResetDefaults]
   * @returns {Record<string, unknown>}
   */
  function resetVault(overrideResetDefaults) {
    const current = parseVaultObject(safeGetItem(effectiveVaultKey));
    const sourceReset =
      overrideResetDefaults !== undefined
        ? copySafeProperties(overrideResetDefaults)
        : effectiveResetDefaults;

    /** @type {Record<string, unknown>} */
    const resetValues = {};
    for (const [k, v] of Object.entries(sourceReset)) {
      resetValues[k] = cloneValue(v);
    }

    const resetPatch = {
      ...current,
      ...resetValues,
      updatedAt: new Date().toISOString(),
    };

    const normalized = normalizeVaultRecord(resetPatch);
    safeSetItem(effectiveVaultKey, JSON.stringify(normalized));

    for (const key of effectiveFlatKeys) {
      safeSetItem(key, String(normalized[key] ?? ""));
    }

    return normalized;
  }

  /**
   * Exporte le contenu du coffre-fort au format JSON.
   * @param {object} [options]
   * @param {boolean} [options.includeSecrets]
   * @param {readonly string[]} [options.maskKeys]
   * @returns {string}
   */
  function exportVaultJson({
    includeSecrets = defaultIncludeSecrets,
    maskKeys = effectiveSecretKeys,
  } = {}) {
    const vault = loadVault();
    if (!includeSecrets) {
      for (const key of maskKeys) {
        if (!DANGEROUS_KEYS.has(key)) {
          vault[key] = "";
        }
      }
    }
    return JSON.stringify(vault, null, 2);
  }

  /**
   * Importe un JSON de coffre-fort, le fusionne avec les clés tierces existantes et persiste.
   * @param {string} jsonText
   * @returns {Record<string, unknown>}
   */
  function importVaultJson(jsonText) {
    if (typeof jsonText !== "string" || jsonText.trim().length === 0) {
      throw new Error("Le JSON du coffre-fort est vide.");
    }

    if (jsonText.length > 65536) {
      throw new Error(
        "Le JSON du coffre-fort dépasse la taille maximale autorisée (65536 caractères)."
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`JSON de coffre-fort invalide : ${err.message}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Le coffre-fort importé doit être un objet JSON valide.");
    }

    return saveVault(parsed);
  }

  return {
    VAULT_KEY: effectiveVaultKey,
    FLAT_KEYS: effectiveFlatKeys,
    DEFAULT_VAULT: effectiveDefaults,
    loadVault,
    saveVault,
    resetVault,
    exportVaultJson,
    importVaultJson,
  };
}

const defaultVault = createVault();

export const loadVault = defaultVault.loadVault;
export const saveVault = defaultVault.saveVault;
export const resetVault = defaultVault.resetVault;
export const exportVaultJson = defaultVault.exportVaultJson;
export const importVaultJson = defaultVault.importVaultJson;
