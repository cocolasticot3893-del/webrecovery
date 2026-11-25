// GENERATED from shared/ - do not edit
/**
 * File d'attente persistante partagée (Outbox Pattern) sur IndexedDB.
 * Garantit qu'aucune séance/activité terminée n'est perdue hors-ligne.
 * Bascule proprement sur `localStorage` puis sur une `Map` mémoire sous Node.js
 * ou en contexte navigateur restreint.
 */

export const DB_NAME = "app_db_v1";
export const DB_VERSION = 1;
export const STORE_NAME = "outbox";
export const FALLBACK_STORAGE_KEY = "APP_OUTBOX_FALLBACK_V1";

/**
 * Vérifie si `globalThis.indexedDB` est utilisable.
 * @returns {IDBFactory | null}
 */
function getIndexedDb() {
  try {
    const idb = globalThis?.indexedDB;
    if (idb && typeof idb.open === "function") {
      return idb;
    }
  } catch {
    // Contexte restreint
  }
  return null;
}

/**
 * Retourne `globalThis.localStorage` s'il est disponible, sinon `null`.
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
    // Indisponible
  }
  return null;
}

/**
 * Trie les enregistrements par `createdAt` croissant (déterministe sur `external_id`).
 * @param {Array<any>} entries
 */
function sortEntriesAsc(entries) {
  return [...entries].sort((a, b) => {
    const ta = Date.parse(a?.createdAt ?? "") || 0;
    const tb = Date.parse(b?.createdAt ?? "") || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.external_id ?? "").localeCompare(
      String(b?.external_id ?? "")
    );
  });
}

/**
 * Crée une instance d'outbox paramétrable par application (IndexedDB + repli localStorage/Map).
 * @param {object} [config]
 * @param {string} [config.dbName="app_db_v1"] Nom de la base IndexedDB.
 * @param {number} [config.dbVersion=1] Version du schéma IndexedDB.
 * @param {string} [config.storeName="outbox"] Nom de l'ObjectStore.
 * @param {string} [config.fallbackStorageKey="APP_OUTBOX_FALLBACK_V1"] Clé `localStorage` de repli.
 */
export function createOutbox({
  dbName = DB_NAME,
  dbVersion = DB_VERSION,
  storeName = STORE_NAME,
  fallbackStorageKey = FALLBACK_STORAGE_KEY,
} = {}) {
  const effectiveDbName =
    typeof dbName === "string" && dbName.trim() ? dbName.trim() : DB_NAME;
  const effectiveDbVersion =
    Number.isInteger(dbVersion) && dbVersion > 0 ? dbVersion : DB_VERSION;
  const effectiveStoreName =
    typeof storeName === "string" && storeName.trim()
      ? storeName.trim()
      : STORE_NAME;
  const effectiveFallbackKey =
    typeof fallbackStorageKey === "string" && fallbackStorageKey.trim()
      ? fallbackStorageKey.trim()
      : FALLBACK_STORAGE_KEY;

  /** Repli mémoire ultime si ni IndexedDB ni localStorage ne sont disponibles. */
  const memoryStore = new Map();

  /**
   * Ouvre la base IndexedDB et crée l'ObjectStore si nécessaire.
   * @returns {Promise<IDBDatabase>}
   */
  function openOutboxDb() {
    return new Promise((resolve, reject) => {
      const idb = getIndexedDb();
      if (!idb) {
        reject(new Error("IndexedDB indisponible"));
        return;
      }

      let request;
      try {
        request = idb.open(effectiveDbName, effectiveDbVersion);
      } catch (err) {
        reject(err);
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(effectiveStoreName)) {
          db.createObjectStore(effectiveStoreName, { keyPath: "external_id" });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
        };
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error || new Error("Échec d'ouverture IndexedDB"));
      };

      request.onblocked = () => {
        reject(new Error("Ouverture IndexedDB bloquée"));
      };
    });
  }

  /**
   * Lit l'ensemble des enregistrements depuis le repli `localStorage` ou `Map` mémoire.
   * @returns {Array<{ external_id: string, payload: object, createdAt: string, attempts: number, lastError: string | null }>}
   */
  function readFallbackEntries() {
    const ls = getSafeLocalStorage();
    if (ls) {
      try {
        const raw = ls.getItem(effectiveFallbackKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.from(memoryStore.values());
  }

  /**
   * Écrit l'ensemble des enregistrements dans le repli `localStorage` ou `Map` mémoire.
   * @param {Array<{ external_id: string, payload: object, createdAt: string, attempts: number, lastError: string | null }>} entries
   */
  function writeFallbackEntries(entries) {
    const ls = getSafeLocalStorage();
    if (ls) {
      try {
        ls.setItem(effectiveFallbackKey, JSON.stringify(entries));
        return;
      } catch {
        // Bascule sur mémoire si localStorage échoue
      }
    }
    memoryStore.clear();
    for (const entry of entries) {
      memoryStore.set(entry.external_id, entry);
    }
  }

  /**
   * Exécute une opération sur IndexedDB avec bascule automatique sur le repli si indisponible.
   * @template T
   * @param {(db: IDBDatabase) => Promise<T>} idbOp
   * @param {() => T} fallbackOp
   * @returns {Promise<T>}
   */
  async function withStore(idbOp, fallbackOp) {
    if (!getIndexedDb()) {
      return fallbackOp();
    }
    let db;
    try {
      db = await openOutboxDb();
      return await idbOp(db);
    } catch {
      return fallbackOp();
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignoré
        }
      }
    }
  }

  /**
   * Enregistre ou met à jour un enregistrement complet dans l'outbox.
   * @param {{ external_id: string, payload: object, createdAt: string, attempts: number, lastError: string | null }} entry
   * @returns {Promise<object>}
   */
  async function putEntry(entry) {
    return withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readwrite");
          const store = tx.objectStore(effectiveStoreName);
          store.put(entry);
          tx.oncomplete = () => resolve(entry);
          tx.onerror = () => reject(tx.error || new Error("Erreur écriture outbox"));
        }),
      () => {
        const entries = readFallbackEntries().filter(
          (item) => item.external_id !== entry.external_id
        );
        entries.push(entry);
        writeFallbackEntries(entries);
        return entry;
      }
    );
  }

  /**
   * Récupère un enregistrement par `external_id`.
   * @param {string} externalId
   * @returns {Promise<object | null>}
   */
  async function getEntry(externalId) {
    return withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readonly");
          const store = tx.objectStore(effectiveStoreName);
          const req = store.get(externalId);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error || new Error("Erreur lecture outbox"));
        }),
      () => {
        const found = readFallbackEntries().find(
          (item) => item.external_id === externalId
        );
        return found ?? null;
      }
    );
  }

  /**
   * Ajoute un payload dans l'outbox de manière idempotente sur `payload.external_id`.
   * Si `external_id` est déjà en attente, retourne l'enregistrement existant sans duplication.
   * @param {object} payload
   * @returns {Promise<{ external_id: string, payload: object, createdAt: string, attempts: number, lastError: string | null }>}
   */
  async function enqueueOutbox(payload) {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.external_id !== "string" ||
      payload.external_id.trim().length === 0
    ) {
      throw new Error(
        "Le payload outbox doit contenir une chaîne `external_id` non vide."
      );
    }

    const externalId = payload.external_id.trim();
    const existing = await getEntry(externalId);
    if (existing) {
      return existing;
    }

    const entry = {
      external_id: externalId,
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    };

    return putEntry(entry);
  }

  /**
   * Liste tous les éléments en attente, triés par `createdAt` croissant.
   * @returns {Promise<Array<{ external_id: string, payload: object, createdAt: string, attempts: number, lastError: string | null }>>}
   */
  async function listOutbox() {
    const entries = await withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readonly");
          const store = tx.objectStore(effectiveStoreName);
          const req = store.getAll();
          req.onsuccess = () =>
            resolve(Array.isArray(req.result) ? req.result : []);
          req.onerror = () => reject(req.error || new Error("Erreur listage outbox"));
        }),
      () => readFallbackEntries()
    );

    return sortEntriesAsc(entries);
  }

  /**
   * Supprime un élément de l'outbox par son `external_id`.
   * @param {string} externalId
   * @returns {Promise<boolean>}
   */
  async function removeOutboxItem(externalId) {
    if (typeof externalId !== "string" || externalId.trim().length === 0) {
      return false;
    }
    const id = externalId.trim();

    return withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readwrite");
          const store = tx.objectStore(effectiveStoreName);
          store.delete(id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () =>
            reject(tx.error || new Error("Erreur suppression outbox"));
        }),
      () => {
        const current = readFallbackEntries();
        const next = current.filter((item) => item.external_id !== id);
        writeFallbackEntries(next);
        return next.length !== current.length;
      }
    );
  }

  /**
   * Retourne le nombre d'éléments actuellement en attente dans l'outbox.
   * @returns {Promise<number>}
   */
  async function countOutbox() {
    return withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readonly");
          const store = tx.objectStore(effectiveStoreName);
          const req = store.count();
          req.onsuccess = () => resolve(Number(req.result) || 0);
          req.onerror = () =>
            reject(req.error || new Error("Erreur comptage outbox"));
        }),
      () => readFallbackEntries().length
    );
  }

  /**
   * Vide intégralement la file d'attente locale.
   * @returns {Promise<void>}
   */
  async function clearOutbox() {
    await withStore(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(effectiveStoreName, "readwrite");
          const store = tx.objectStore(effectiveStoreName);
          store.clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error("Erreur vidage outbox"));
        }),
      () => {
        const ls = getSafeLocalStorage();
        if (ls) {
          try {
            ls.removeItem(effectiveFallbackKey);
          } catch {
            // Ignoré
          }
        }
        memoryStore.clear();
      }
    );
  }

  /**
   * Vide séquentiellement la file d'attente en appelant `sendFn(entry.payload)`.
   * Supprime les éléments envoyés avec succès ; incrémente `attempts` et enregistre
   * `lastError` en cas d'échec sans bloquer les éléments suivants.
   * @param {(payload: object) => Promise<unknown>} sendFn
   * @returns {Promise<{ sentCount: number, failedCount: number, remainingCount: number, errors: Array<{ external_id: string, error: string }> }>}
   */
  async function flushOutbox(sendFn) {
    if (typeof sendFn !== "function") {
      throw new Error("flushOutbox requiert une fonction d'envoi `sendFn`.");
    }

    const pending = await listOutbox();
    let sentCount = 0;
    let failedCount = 0;
    /** @type {Array<{ external_id: string, error: string }>} */
    const errors = [];

    for (const entry of pending) {
      try {
        await sendFn(entry.payload);
        await removeOutboxItem(entry.external_id);
        sentCount += 1;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err ?? "Erreur inconnue");
        failedCount += 1;
        errors.push({ external_id: entry.external_id, error: errorMsg });
        await putEntry({
          ...entry,
          attempts: Number(entry.attempts || 0) + 1,
          lastError: errorMsg,
        });
      }
    }

    const remainingCount = await countOutbox();
    return {
      sentCount,
      failedCount,
      remainingCount,
      errors,
    };
  }

  return {
    DB_NAME: effectiveDbName,
    DB_VERSION: effectiveDbVersion,
    STORE_NAME: effectiveStoreName,
    FALLBACK_STORAGE_KEY: effectiveFallbackKey,
    enqueueOutbox,
    listOutbox,
    removeOutboxItem,
    countOutbox,
    clearOutbox,
    flushOutbox,
    // Alias rétrocompatibles
    enqueueActivity: enqueueOutbox,
    listPendingActivities: listOutbox,
    removePendingActivity: removeOutboxItem,
    getOutboxCount: countOutbox,
  };
}

const defaultOutbox = createOutbox();

export const enqueueOutbox = defaultOutbox.enqueueOutbox;
export const listOutbox = defaultOutbox.listOutbox;
export const removeOutboxItem = defaultOutbox.removeOutboxItem;
export const countOutbox = defaultOutbox.countOutbox;
export const clearOutbox = defaultOutbox.clearOutbox;
export const flushOutbox = defaultOutbox.flushOutbox;

export const enqueueActivity = defaultOutbox.enqueueActivity;
export const listPendingActivities = defaultOutbox.listPendingActivities;
export const removePendingActivity = defaultOutbox.removePendingActivity;
export const getOutboxCount = defaultOutbox.getOutboxCount;
