/**
 * Contrôleur principal WebRecovery (ES2024+ zéro-build, CSP stricte).
 * Gère la navigation par onglets accessible, le rendu depuis `catalog.js`,
 * le minuteur multi-phases (`timer.js`) avec garde-fou SpO₂ par seconde,
 * le questionnaire de sécurité KAATSU/IHHT/Sauna, le matériel, l'historique,
 * le coffre-fort (`vault.js`), la file Outbox (`outbox.js`) et Drive (`driveSync.js`).
 */

import {
  EQUIPMENT,
  EXERCISES,
  EXERCISES_BY_ID,
  PROTOCOLS,
  PROTOCOLS_BY_ID,
} from "./catalog.js";
import { createBleOximeter, isWebBluetoothSupported } from "./bleOximeter.js";
import { createDriveSync } from "./driveSync.js";
import {
  buildSession,
  computeRecoveryScore,
  isAllowed,
  selectProtocol,
} from "./engine.js";
import { personalizeSessionWithGemini } from "./geminiClient.js";
import {
  fetchRecoveryContext,
  flushPendingRecoveryWorkouts,
  publishRecoveryWorkout,
} from "./intervalsClient.js";
import { countOutbox } from "./outbox.js";
import {
  MultiPhaseTimer,
  expandPhases,
  formatDurationSec,
} from "./timer.js";
import { exportVaultJson, loadVault, saveVault } from "./vault.js";

const driveSync = createDriveSync({
  app: "webrecovery",
  requireAppsScript: true,
});

const SETTINGS_STORAGE_KEY = "WEBRECOVERY_SETTINGS_V1";
const HISTORY_STORAGE_KEY = "WEBRECOVERY_HISTORY_V1";
const RING_RADIUS = 86;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const DEFAULT_SETTINGS = Object.freeze({
  safety: {
    kaatsuTvp: false,
    kaatsuHta: false,
    kaatsuVarices: false,
    kaatsuPregnancy: false,
    kaatsuFirstAlone: false,
    lymphedemaAvFistula: false,
    severeRespiratoryAnemia: false,
    acuteFeverInfection: false,
    coldUrticariaRaynaud: false,
    acuteTraumaOpenWound: false,
    spinalInstabilityRadiculopathy: false,
    orthostaticHypotension: false,
    ihhtSafetyOk: false,
    saunaCleared: false,
    blockColdAfterStrength: true,
  },
  kaatsuPressures: {
    armLeftMmhg: 110,
    armRightMmhg: 110,
    legLeftMmhg: 170,
    legRightMmhg: 170,
    maxOcclusionMin: 10,
  },
  spo2ThresholdPct: 85,
  equipmentIds: null, // null => initialisé depuis EQUIPMENT
});

/** @type {Record<string, HTMLElement | null>} */
const dom = {};

const state = {
  activeTab: "today",
  vault: safeLoadVault(),
  settings: loadLocalSettings(),
  history: loadLocalHistory(),
  catalog: {
    equipment: [],
    exercises: [],
    protocols: [],
  },
  activeSession: null, // { id, name, family, protocolId, isIhht, isKaatsu, phases, durationSec, items }
  intervalsContext: null,
  recoveryScore: null,
  recommendedSession: null,
  liveSpo2StreamPct: null,
  lastSpo2TimestampMs: null,
  lastSummary: null,
  timerMuted: false,
  timerVibrate: true,
};

/** @type {MultiPhaseTimer | null} */
let timer = null;
/** @type {ReturnType<typeof createBleOximeter> | null} */
let bleOximeter = null;
let toastTimerId = 0;
/** @type {any} */
let deferredInstallPrompt = null;

/**
 * Charge le coffre-fort sans planter si la structure est partielle.
 * @returns {Record<string, unknown>}
 */
function safeLoadVault() {
  try {
    return loadVault() ?? {};
  } catch {
    return {};
  }
}

/**
 * Charge les réglages WebRecovery depuis `localStorage`.
 */
function loadLocalSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    const parsed = JSON.parse(raw);
    return {
      safety: { ...DEFAULT_SETTINGS.safety, ...(parsed?.safety ?? {}) },
      kaatsuPressures: {
        ...DEFAULT_SETTINGS.kaatsuPressures,
        ...(parsed?.kaatsuPressures ?? {}),
      },
      spo2ThresholdPct: clampNumber(parsed?.spo2ThresholdPct, 80, 95, 85),
      equipmentIds: Array.isArray(parsed?.equipmentIds)
        ? parsed.equipmentIds.map(String)
        : null,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveLocalSettings() {
  try {
    globalThis.localStorage?.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(state.settings)
    );
  } catch {
    // Stockage indisponible
  }
}

function loadLocalHistory() {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalHistory() {
  try {
    globalThis.localStorage?.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(state.history.slice(0, 100))
    );
  } catch {
    // Stockage indisponible
  }
}

function clampNumber(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalise `EQUIPMENT`, `EXERCISES` et `PROTOCOLS` depuis `./catalog.js`.
 */
function normalizeCatalogData() {
  const equipRaw = Array.isArray(EQUIPMENT)
    ? EQUIPMENT
    : EQUIPMENT && typeof EQUIPMENT === "object"
      ? Object.entries(EQUIPMENT).map(([id, val]) =>
          typeof val === "string" ? { id, name: val } : { id, ...val }
        )
      : [];

  const equipment = equipRaw
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? item.key ?? item.name ?? ""),
      name: String(item.name ?? item.label ?? item.id ?? "Équipement"),
      category: String(item.category ?? item.family ?? ""),
      description: String(item.description ?? ""),
    }))
    .filter((item) => item.id.length > 0);

  const rawExercises = Array.isArray(EXERCISES)
    ? EXERCISES
    : EXERCISES && typeof EXERCISES === "object"
      ? Object.values(EXERCISES)
      : [];

  const exercises = rawExercises
    .filter((ex) => ex && typeof ex === "object")
    .map((ex) => {
      const family = String(ex.family ?? ex.famille ?? "Récupération");
      const id = String(ex.id ?? ex.name ?? "");
      const name = String(ex.name ?? ex.id ?? "Exercice");
      const equipList = Array.isArray(ex.equipment)
        ? ex.equipment.map(String)
        : [];
      const zones = Array.isArray(ex.zones) ? ex.zones.map(String) : [];
      const contraindications = Array.isArray(ex.contraindications)
        ? ex.contraindications.map(String)
        : [];
      const conflicts = Array.isArray(ex.conflicts)
        ? ex.conflicts.map(String)
        : [];
      const lowerTag = `${id} ${name} ${family}`.toLowerCase();
      const isIhht =
        family === "hyperoxia_ihht" ||
        lowerTag.includes("ihht") ||
        lowerTag.includes("hypox") ||
        lowerTag.includes("hyperox");
      const phases = normalizePhasesArray(ex.phases, ex.durationSec).map((ph) => ({
        ...ph,
        meta: {
          ...(ph.meta ?? {}),
          exerciseId: id,
          family,
          isIhht,
          isHypoxia: computePhaseIsHypoxia(ph, isIhht),
        },
      }));
      const durationSec =
        Number(ex.durationSec) > 0
          ? Number(ex.durationSec)
          : expandPhases(phases).reduce((acc, s) => acc + s.sec, 0);

      return {
        ...ex,
        id,
        name,
        family,
        equipment: equipList,
        zones,
        phases,
        durationSec,
        contraindications,
        conflicts,
        description: String(
          ex.description ??
            ex.instructions ??
            (Array.isArray(ex.cues) ? ex.cues.join(" ") : "")
        ),
        isKaatsu:
          family === "kaatsu" ||
          lowerTag.includes("kaatsu") ||
          lowerTag.includes("bfr"),
        isIhht,
        isSauna: lowerTag.includes("sauna"),
        isCold:
          lowerTag.includes("froid") ||
          lowerTag.includes("cold") ||
          lowerTag.includes("glace"),
      };
    });

  const exerciseById = new Map(exercises.map((ex) => [ex.id, ex]));

  const rawProtocols = Array.isArray(PROTOCOLS)
    ? PROTOCOLS
    : PROTOCOLS && typeof PROTOCOLS === "object"
      ? Object.values(PROTOCOLS)
      : [];

  const protocols = rawProtocols
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const id = String(p.id ?? p.name ?? "");
      const name = String(p.name ?? p.id ?? "Protocole");
      const linkedIds = Array.isArray(p.exerciseIds)
        ? p.exerciseIds
        : Array.isArray(p.exercises)
          ? p.exercises
          : Array.isArray(p.steps)
            ? p.steps
            : [];

      let phases = [];
      const resolvedExercises = [];
      if (Array.isArray(p.phases) && p.phases.length > 0) {
        phases = normalizePhasesArray(p.phases, p.durationSec ?? p.estimatedDurationSec);
      } else {
        for (const entry of linkedIds) {
          const exId =
            typeof entry === "string"
              ? entry
              : String(entry?.id ?? entry?.exerciseId ?? "");
          const ex = exerciseById.get(exId);
          if (ex) {
            resolvedExercises.push(ex);
            for (const ph of ex.phases) {
              phases.push({
                ...ph,
                label: `${ex.name} — ${ph.label}`,
              });
            }
          }
        }
      }

      const rawDuration = Number(p.durationSec ?? p.estimatedDurationSec);
      const durationSec =
        rawDuration > 0
          ? rawDuration
          : expandPhases(phases).reduce((acc, s) => acc + s.sec, 0);

      const equipSet = new Set(Array.isArray(p.equipment) ? p.equipment.map(String) : []);
      for (const ex of resolvedExercises) {
        for (const eq of ex.equipment) {
          equipSet.add(eq);
        }
      }

      const lowerTag = `${id} ${name} ${p.family ?? ""}`.toLowerCase();
      const protoIsIhht =
        lowerTag.includes("ihht") ||
        lowerTag.includes("hypox") ||
        resolvedExercises.some((ex) => ex.isIhht);
      if (Array.isArray(p.phases) && p.phases.length > 0 && protoIsIhht) {
        phases = phases.map((ph) => ({
          ...ph,
          meta: {
            ...(ph.meta ?? {}),
            isIhht: true,
            isHypoxia: computePhaseIsHypoxia(ph, true),
          },
        }));
      }

      return {
        ...p,
        id,
        name,
        family: String(p.family ?? "Protocole"),
        description: String(p.description ?? p.objective ?? p.context ?? ""),
        equipment: [...equipSet],
        phases,
        resolvedExercises,
        durationSec,
        isKaatsu:
          lowerTag.includes("kaatsu") ||
          resolvedExercises.some((ex) => ex.isKaatsu),
        isIhht: protoIsIhht,
        isSauna:
          lowerTag.includes("sauna") ||
          resolvedExercises.some((ex) => ex.isSauna),
      };
    });

  state.catalog = { equipment, exercises, protocols };

  if (state.settings.equipmentIds === null) {
    state.settings.equipmentIds = equipment.map((e) => e.id);
    saveLocalSettings();
  }
}

/**
 * Détermine si une phase IHHT correspond effectivement à une exposition hypoxique
 * (exclut les phases de bascule de masque et d'hyperoxie).
 * @param {Record<string, any>} phase
 * @param {boolean} isIhht
 * @returns {boolean}
 */
function computePhaseIsHypoxia(phase, isIhht) {
  if (typeof phase?.meta?.isHypoxia === "boolean") {
    return phase.meta.isHypoxia;
  }
  if (!isIhht) {
    return false;
  }
  const label = String(phase?.label ?? "");
  return /hypox/i.test(label) && !/bascule/i.test(label);
}

function normalizePhasesArray(phases, fallbackDurationSec) {
  if (Array.isArray(phases) && phases.length > 0) {
    return phases
      .filter((ph) => ph && typeof ph === "object")
      .map((ph) => ({
        label: String(ph.label ?? "Phase"),
        sec: Math.max(1, Math.round(Number(ph.sec) || 30)),
        ...(ph.repeat ? { repeat: Math.max(1, Math.round(Number(ph.repeat))) } : {}),
        ...(Array.isArray(ph.phases) ? { phases: ph.phases } : {}),
        ...(ph.meta && typeof ph.meta === "object" ? { meta: { ...ph.meta } } : {}),
      }));
  }
  const sec = Math.max(10, Math.round(Number(fallbackDurationSec) || 60));
  return [{ label: "Exécution", sec }];
}

/**
 * Évalue les blocages sécurité issus du questionnaire Réglages.
 */
function evaluateSafetyStatus() {
  const s = state.settings.safety;
  const kaatsuReasons = [];
  if (s.kaatsuTvp) kaatsuReasons.push("Antécédent TVP/embolie");
  if (s.kaatsuHta) kaatsuReasons.push("HTA non contrôlée");
  if (s.kaatsuVarices) kaatsuReasons.push("Varices sévères");
  if (s.kaatsuPregnancy) kaatsuReasons.push("Grossesse");
  if (s.kaatsuFirstAlone) kaatsuReasons.push("1re utilisation sans supervision");
  if (s.lymphedemaAvFistula) kaatsuReasons.push("Lymphœdème / fistule AV");
  if (s.acuteFeverInfection) kaatsuReasons.push("Fièvre / infection aiguë");
  if (s.acuteTraumaOpenWound) kaatsuReasons.push("Lésion aiguë / plaie ouverte");

  const ihhtReasons = [];
  if (!s.ihhtSafetyOk) {
    ihhtReasons.push("Zone O₂ sans flamme/corps gras ou oxymètre non confirmé");
  }
  if (s.kaatsuPregnancy) {
    ihhtReasons.push("Grossesse");
  }
  if (s.severeRespiratoryAnemia) {
    ihhtReasons.push("BPCO / HTAP / anémie sévère");
  }
  if (s.acuteFeverInfection) {
    ihhtReasons.push("Fièvre / infection aiguë");
  }

  const saunaReasons = [];
  if (!s.saunaCleared) {
    saunaReasons.push("Tolérance cardiovasculaire sauna non confirmée");
  }
  if (s.kaatsuPregnancy) {
    saunaReasons.push("Grossesse");
  }
  if (s.acuteFeverInfection) {
    saunaReasons.push("Fièvre / infection aiguë");
  }
  if (s.coldUrticariaRaynaud) {
    saunaReasons.push("Urticaire au froid / Raynaud");
  }
  if (s.orthostaticHypotension) {
    saunaReasons.push("Hypotension orthostatique");
  }

  const otherReasons = [];
  if (s.spinalInstabilityRadiculopathy) {
    otherReasons.push("Hernie discale aiguë / radiculopathie");
  }
  if (s.acuteTraumaOpenWound) {
    otherReasons.push("Lésion aiguë / plaie ouverte");
  }
  if (s.orthostaticHypotension) {
    otherReasons.push("Hypotension orthostatique");
  }

  return {
    kaatsuBlocked: kaatsuReasons.length > 0,
    kaatsuReasons,
    ihhtBlocked: ihhtReasons.length > 0,
    ihhtReasons,
    saunaBlocked: saunaReasons.length > 0,
    saunaReasons,
    hasAnyBlock:
      kaatsuReasons.length > 0 ||
      ihhtReasons.length > 0 ||
      saunaReasons.length > 0 ||
      otherReasons.length > 0,
  };
}

function getItemBlockReason(
  item,
  safety = evaluateSafetyStatus(),
  ctx = buildEngineContextFromSettings()
) {
  const exercisesToCheck =
    Array.isArray(item?.resolvedExercises) && item.resolvedExercises.length > 0
      ? item.resolvedExercises
      : Array.isArray(item?.items) && item.items.length > 0
        ? item.items
        : [item];

  for (const ex of exercisesToCheck) {
    const check = isAllowed(ex, ctx);
    if (!check.ok) {
      const label = ex?.name ?? ex?.id ?? "Exercice";
      return `${label} bloqué : ${check.reasons.map(formatRemovalReason).join(", ")}`;
    }
  }

  if (item?.isKaatsu && safety.kaatsuBlocked) {
    return `KAATSU bloqué : ${safety.kaatsuReasons.join(", ")}`;
  }
  if (item?.isIhht && safety.ihhtBlocked) {
    return `IHHT bloqué : ${safety.ihhtReasons.join(", ")}`;
  }
  if (item?.isSauna && safety.saunaBlocked) {
    return `Sauna bloqué : ${safety.saunaReasons.join(", ")}`;
  }
  return "";
}

/**
 * Affiche un toast temporaire non intrusif.
 * @param {string} message
 * @param {"info" | "success" | "error"} [variant]
 */
function showToast(message, variant = "info") {
  const banner = dom.toastBanner;
  if (!banner) return;
  banner.textContent = message;
  banner.className = "toast-banner";
  if (variant === "error") banner.classList.add("is-error");
  if (variant === "success") banner.classList.add("is-success");
  banner.hidden = false;

  if (toastTimerId) {
    clearTimeout(toastTimerId);
  }
  toastTimerId = window.setTimeout(() => {
    banner.hidden = true;
  }, 3800);
}

/* =========================================================================
   NAVIGATION ONGLETS ACCESSIBLE
   ========================================================================= */
function setupTabsNavigation() {
  const tablist = dom.tablist;
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const panels = new Map(
    tabs.map((tab) => {
      const key = tab.dataset.tab;
      return [key, document.getElementById(`panel-${key}`)];
    })
  );

  function selectTab(targetTab, { focus = false } = {}) {
    if (!targetTab) return;
    const key = targetTab.dataset.tab;
    state.activeTab = key;

    for (const tab of tabs) {
      const selected = tab === targetTab;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      tab.toggleAttribute("focusgroupstart", selected);
    }

    for (const [panelKey, panel] of panels.entries()) {
      if (!panel) continue;
      if (panelKey === key) {
        panel.removeAttribute("hidden");
        panel.tabIndex = 0;
      } else {
        panel.setAttribute("hidden", "until-found");
        panel.removeAttribute("tabindex");
      }
    }

    if (typeof targetTab.scrollIntoView === "function") {
      targetTab.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        container: "nearest",
      });
    }

    if (focus) {
      targetTab.focus();
    }
  }

  tablist.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
      selectTab(tab);
    }
  });

  tablist.addEventListener("keydown", (event) => {
    const current = event.target.closest('[role="tab"]');
    if (!current) return;
    const idx = tabs.indexOf(current);
    if (idx === -1) return;

    let nextIdx = -1;
    if (event.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIdx = 0;
    else if (event.key === "End") nextIdx = tabs.length - 1;

    if (nextIdx !== -1) {
      event.preventDefault();
      selectTab(tabs[nextIdx], { focus: true });
    }
  });

  for (const [key, panel] of panels.entries()) {
    if (!panel) continue;
    panel.addEventListener("beforematch", () => {
      const tab = tabs.find((t) => t.dataset.tab === key);
      if (tab) selectTab(tab);
    });
  }

  // Fallback IntersectionObserver pour les fondus de scroll d'onglets
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("animation-timeline", "scroll()") &&
    typeof IntersectionObserver === "function" &&
    tabs.length > 1
  ) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === tabs[0]) {
            tablist.classList.toggle("more-start", entry.intersectionRatio < 1);
          } else if (entry.target === tabs[tabs.length - 1]) {
            tablist.classList.toggle("more-end", entry.intersectionRatio < 1);
          }
        }
      },
      { root: tablist, threshold: 1, rootMargin: "1px" }
    );
    observer.observe(tabs[0]);
    observer.observe(tabs[tabs.length - 1]);
  }

  dom.selectTabByKey = (key) => {
    const tab = tabs.find((t) => t.dataset.tab === key);
    if (tab) selectTab(tab, { focus: true });
  };
}

/* =========================================================================
   MINUTEUR MULTI-PHASES
   ========================================================================= */
/**
 * Affiche ou masque la bannière d'alerte de fraîcheur SpO₂ (> 60 s en hypoxie).
 * @param {boolean} visible
 * @param {string} [message=""]
 */
function setSpo2StaleBanner(visible, message = "") {
  if (dom.spo2StaleAlert) {
    dom.spo2StaleAlert.textContent = visible ? message : "";
    dom.spo2StaleAlert.hidden = !visible;
  }
  dom.spo2GuardBox?.classList.toggle("is-stale", visible);
  if (visible) {
    dom.spo2GuardBox?.classList.add("is-alert");
  }
}

/**
 * Enregistre une mesure SpO₂ en direct (saisie manuelle, événement ou BLE),
 * met à jour l'horodatage et réarme le watchdog du minuteur.
 * @param {unknown} rawValue
 * @param {number} [timestampMs=Date.now()]
 * @param {"input" | "event" | "ble"} [source="event"]
 */
function recordLiveSpo2(rawValue, timestampMs = Date.now(), source = "event") {
  const val = Number(rawValue);
  if (!Number.isFinite(val)) {
    state.liveSpo2StreamPct = null;
    return;
  }
  const ts = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : Date.now();
  state.liveSpo2StreamPct = val;
  state.lastSpo2TimestampMs = ts;

  if (dom.liveSpo2Input && source !== "input") {
    dom.liveSpo2Input.value = String(val);
  }

  timer?.recordSpo2Reading(val, ts);

  if (timer?.status === "paused" && timer?.pauseReason === "spo2_stale") {
    const threshold = Math.max(80, Number(state.settings.spo2ThresholdPct) || 85);
    if (val >= threshold) {
      setSpo2StaleBanner(
        true,
        `Nouvelle SpO₂ (${val} % ≥ ${threshold} %) enregistrée — cliquez sur « Reprendre » pour continuer.`
      );
      dom.spo2GuardBox?.classList.remove("is-alert");
    } else {
      setSpo2StaleBanner(
        true,
        `SpO₂ insuffisante (${val} % < seuil ${threshold} %) — reprise bloquée.`
      );
    }
  }
}

function initBleOximeter() {
  bleOximeter = createBleOximeter({
    onReading: ({ spo2, hr, timestampMs }) => {
      if (typeof spo2 === "number" && Number.isFinite(spo2)) {
        window.dispatchEvent(
          new CustomEvent("webrecovery:spo2", {
            detail: { spo2, hr, source: "ble", timestampMs },
          })
        );
      }
      if (dom.bleOximeterStatus) {
        const parts = [];
        if (typeof spo2 === "number" && Number.isFinite(spo2)) parts.push(`SpO₂ ${spo2}%`);
        if (typeof hr === "number" && Number.isFinite(hr)) parts.push(`FC ${hr} bpm`);
        if (parts.length > 0) {
          dom.bleOximeterStatus.textContent = `BLE : ${parts.join(" · ")}`;
        }
      }
    },
    onStatusChange: ({ state: bleState, message }) => {
      if (dom.bleOximeterStatus) {
        dom.bleOximeterStatus.textContent =
          bleState === "connected" ? message : bleState === "unsupported" ? "BLE indisponible (saisie manuelle)" : "";
        dom.bleOximeterStatus.classList.toggle("is-connected", bleState === "connected");
        dom.bleOximeterStatus.classList.toggle("is-unsupported", bleState === "unsupported");
      }
      if (dom.bleOximeterBtn) {
        dom.bleOximeterBtn.textContent =
          bleState === "connected"
            ? "Déconnecter oxymètre BLE"
            : bleState === "connecting"
              ? "Connexion BLE..."
              : "Connecter oxymètre BLE";
        dom.bleOximeterBtn.disabled = bleState === "connecting";
      }
    },
    onError: ({ message }) => {
      if (message) {
        showToast(message, "info");
      }
    },
  });

  if (!isWebBluetoothSupported() && dom.bleOximeterStatus) {
    dom.bleOximeterStatus.textContent = "BLE indisponible (saisie manuelle active)";
    dom.bleOximeterStatus.classList.add("is-unsupported");
  }
}

function initTimer() {
  if (dom.timerRingProgress) {
    dom.timerRingProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE.toFixed(2)}`;
    dom.timerRingProgress.style.strokeDashoffset = `${RING_CIRCUMFERENCE.toFixed(2)}`;
  }

  timer = new MultiPhaseTimer({
    tickIntervalMs: 250,
    spo2MaxAgeMs: 60_000,
    spo2ThresholdPct: Math.max(80, Number(state.settings.spo2ThresholdPct) || 85),
    muted: state.timerMuted,
    vibrateEnabled: state.timerVibrate,
    onSafetyCheck: (snapshot) => {
      const phaseIsIhht =
        snapshot?.phase?.meta?.isIhht ?? Boolean(state.activeSession?.isIhht);
      if (!phaseIsIhht) {
        return true;
      }
      const rawStream = state.liveSpo2StreamPct;
      const rawInputStr = dom.liveSpo2Input?.value?.trim() ?? "";
      const rawInput = rawInputStr === "" ? Number.NaN : Number(rawInputStr);
      const spo2 =
        typeof rawStream === "number" && Number.isFinite(rawStream)
          ? rawStream
          : rawInput;
      if (!Number.isFinite(spo2)) {
        return {
          ok: false,
          reason:
            "SpO₂ absente ou invalide pendant la phase IHHT — Arrêt immédiat par sécurité.",
        };
      }
      const threshold = Math.max(
        80,
        Number(state.settings.spo2ThresholdPct) || 85
      );
      if (spo2 < threshold) {
        return {
          ok: false,
          reason: `SpO₂ critique (${spo2}% < seuil ${threshold}%) — Arrêt immédiat IHHT.`,
        };
      }
      return true;
    },
    onSafetyAlert: (alert) => {
      const threshold = Math.max(80, Number(state.settings.spo2ThresholdPct) || 85);
      const msg =
        alert?.reason ||
        `PAUSE SÉCURITÉ : aucune mesure SpO₂ reçue depuis > 60 s. Saisissez une SpO₂ ≥ ${threshold} % pour reprendre.`;
      setSpo2StaleBanner(true, `${msg} Saisissez une SpO₂ ≥ ${threshold} % pour reprendre.`);
      showToast(msg, "error");
      updateTimerControls();
    },
    onPhase: (info) => {
      const isIhhtPhase = Boolean(info?.meta?.isIhht ?? info?.step?.meta?.isIhht);
      dom.spo2GuardBox?.classList.toggle("is-active", isIhhtPhase);
      renderPhaseQueue();
    },
    onTick: (snapshot) => {
      renderTimerSnapshot(snapshot);
    },
    onStateChange: (stateInfo) => {
      if (stateInfo?.status === "running" || stateInfo?.status === "idle") {
        setSpo2StaleBanner(false);
        if (stateInfo?.status === "idle") {
          dom.spo2GuardBox?.classList.remove("is-alert");
        }
      }
      updateTimerControls();
    },
    onDone: (summary) => {
      state.lastSummary = summary;
      updateTimerControls();
      renderPhaseQueue();

      if (summary.interrupted) {
        dom.spo2GuardBox?.classList.add("is-alert");
        showToast(summary.reason || "Séance interrompue par sécurité.", "error");
      } else {
        dom.spo2GuardBox?.classList.remove("is-alert");
        showToast("Séance terminée ! Pensez à enregistrer votre RPE.", "success");
      }

      if (state.activeSession) {
        recordHistoryEntry({
          id: `${state.activeSession.id}_${Date.now()}`,
          sessionId: state.activeSession.id,
          name: state.activeSession.name,
          family: state.activeSession.family,
          elapsedSec: summary.elapsedSec,
          completed: summary.completed,
          interrupted: summary.interrupted,
          reason: summary.reason || "",
          rpe: null,
          notes: summary.interrupted ? summary.reason : "",
          timestamp: new Date().toISOString(),
        });
      }
    },
  });
}

function loadIntoTimer(sessionObj, autoSwitchToday = true) {
  const ctx = buildEngineContextFromSettings();
  const blockReason = getItemBlockReason(sessionObj, evaluateSafetyStatus(), ctx);
  if (blockReason) {
    showToast(blockReason, "error");
    return;
  }

  state.activeSession = {
    id: sessionObj.id,
    name: sessionObj.name,
    family: sessionObj.family,
    protocolId: sessionObj.protocolId ?? sessionObj.id,
    isIhht: Boolean(sessionObj.isIhht),
    isKaatsu: Boolean(sessionObj.isKaatsu),
    phases: sessionObj.phases,
    durationSec: sessionObj.durationSec,
    items: Array.isArray(sessionObj.items) ? sessionObj.items : [],
  };

  timer?.load(sessionObj.phases);
  setSpo2StaleBanner(false);
  dom.spo2GuardBox?.classList.remove("is-alert");
  if (dom.timerTitle) dom.timerTitle.textContent = sessionObj.name;
  if (dom.timerSubtitle) {
    dom.timerSubtitle.textContent = `${sessionObj.family} · Durée prévue ${formatDurationSec(sessionObj.durationSec)}`;
  }

  renderTodayKpis();
  renderPhaseQueue();
  updateTimerControls();

  if (autoSwitchToday && dom.selectTabByKey) {
    dom.selectTabByKey("today");
  }
}

function renderTimerSnapshot(snapshot) {
  if (!snapshot) return;
  if (dom.timerClock) {
    dom.timerClock.textContent = formatDurationSec(snapshot.phaseRemainingSec);
  }
  if (dom.timerPhaseLabel) {
    dom.timerPhaseLabel.textContent =
      snapshot.status === "interrupted"
        ? "ARRÊT SÉCURITÉ"
        : snapshot.status === "paused" && snapshot.pauseReason === "spo2_stale"
          ? "PAUSE SÉCURITÉ (SpO₂ > 60 s)"
          : snapshot.status === "done"
            ? "Séance terminée"
            : snapshot.phaseLabel || "En attente";
  }
  if (dom.timerStepMeta) {
    const stepNum = snapshot.totalSteps > 0 ? snapshot.stepIndex + 1 : 0;
    dom.timerStepMeta.textContent = `Étape ${stepNum}/${snapshot.totalSteps} · Restant ${formatDurationSec(snapshot.totalRemainingSec)}`;
  }
  if (dom.timerRingProgress) {
    const offset = RING_CIRCUMFERENCE * (1 - (snapshot.phaseProgress || 0));
    dom.timerRingProgress.style.strokeDashoffset = `${offset.toFixed(2)}`;
    dom.timerRingProgress.classList.toggle(
      "is-interrupted",
      snapshot.status === "interrupted"
    );
    dom.timerRingProgress.classList.toggle("is-done", snapshot.status === "done");
  }
  if (dom.timerStatusBadge) {
    const isSpo2Stale =
      snapshot.status === "paused" && snapshot.pauseReason === "spo2_stale";
    const labels = {
      idle: ["Prêt", "badge-cyan"],
      running: ["En cours", "badge-emerald"],
      paused: isSpo2Stale
        ? ["Pause SpO₂", "badge-coral"]
        : ["En pause", "badge-amber"],
      done: ["Terminé", "badge-emerald"],
      interrupted: ["Interrompu", "badge-coral"],
    };
    const [text, cls] = labels[snapshot.status] ?? labels.idle;
    dom.timerStatusBadge.textContent = text;
    dom.timerStatusBadge.className = `badge ${cls}`;
  }
}

function updateTimerControls() {
  if (!timer) return;
  const hasSteps = timer.steps.length > 0;
  const st = timer.status;

  if (dom.timerStartBtn) {
    dom.timerStartBtn.disabled = !hasSteps || st === "running" || st === "paused";
  }
  if (dom.timerPauseBtn) {
    dom.timerPauseBtn.disabled = st !== "running" && st !== "paused";
    dom.timerPauseBtn.textContent = st === "paused" ? "Reprendre" : "Pause";
  }
  if (dom.timerSkipBtn) {
    dom.timerSkipBtn.disabled = st !== "running" && st !== "paused";
  }
  if (dom.timerStopBtn) {
    dom.timerStopBtn.disabled = st === "idle";
  }
}

function renderPhaseQueue() {
  const container = dom.timerPhaseQueue;
  if (!container || !timer) return;
  container.replaceChildren();

  timer.steps.forEach((step, idx) => {
    const chip = document.createElement("span");
    chip.className = "phase-chip";
    if (timer.status !== "idle" && idx < timer.currentStepIndex) {
      chip.classList.add("is-done");
    } else if (idx === timer.currentStepIndex && timer.status !== "done") {
      chip.classList.add("is-current");
    }
    chip.textContent = `${step.label} (${formatDurationSec(step.sec)})`;
    container.appendChild(chip);
  });
}

/* =========================================================================
   RENDU DES ONGLETS (AUJOURD'HUI, CATALOGUE, PROTOCOLES, MATÉRIEL, HISTORIQUE)
   ========================================================================= */
function renderTodayKpis() {
  const safety = evaluateSafetyStatus();
  const activeCount = state.settings.equipmentIds?.length ?? 0;

  if (dom.kpiSessionName) {
    dom.kpiSessionName.textContent = state.activeSession?.name ?? "Aucune";
  }
  if (dom.kpiSessionSub) {
    dom.kpiSessionSub.textContent = state.activeSession
      ? `${state.activeSession.family} · ${formatDurationSec(state.activeSession.durationSec)}`
      : "Choisir dans Catalogue ou Protocoles";
  }
  if (dom.kpiEquipReady) {
    dom.kpiEquipReady.textContent = String(activeCount);
  }
  if (dom.kpiSpo2Threshold) {
    dom.kpiSpo2Threshold.textContent = `${state.settings.spo2ThresholdPct} %`;
  }
  if (dom.kpiKaatsuCaps) {
    const k = state.settings.kaatsuPressures;
    dom.kpiKaatsuCaps.textContent = `${Math.max(k.armLeftMmhg, k.armRightMmhg)} / ${Math.max(k.legLeftMmhg, k.legRightMmhg)}`;
  }

  const allReasons = [
    ...safety.kaatsuReasons.map((r) => `KAATSU bloqué (${r})`),
    ...safety.ihhtReasons.map((r) => `IHHT bloqué (${r})`),
    ...safety.saunaReasons.map((r) => `Sauna bloqué (${r})`),
  ];

  if (dom.todaySafetyBadge) {
    dom.todaySafetyBadge.textContent = safety.hasAnyBlock
      ? `${allReasons.length} restriction(s)`
      : "Garde-fous conformes";
    dom.todaySafetyBadge.className = safety.hasAnyBlock
      ? "badge badge-amber"
      : "badge badge-emerald";
  }

  if (dom.safetyStatusPill) {
    dom.safetyStatusPill.textContent = safety.hasAnyBlock
      ? "Sécurité : Alerte"
      : "Sécurité : OK";
    dom.safetyStatusPill.classList.toggle("is-warning", safety.hasAnyBlock);
    dom.safetyStatusPill.classList.toggle("is-online", !safety.hasAnyBlock);
  }

  if (dom.todaySafetyWarnings) {
    if (allReasons.length > 0) {
      dom.todaySafetyWarnings.textContent = `Restrictions actives : ${allReasons.join(" · ")}`;
      dom.todaySafetyWarnings.hidden = false;
    } else {
      dom.todaySafetyWarnings.hidden = true;
    }
  }
}

function buildEngineContextFromSettings() {
  const s = state.settings.safety;
  const userContraindications = new Set();
  if (s.kaatsuTvp) userContraindications.add("tvp_history");
  if (s.kaatsuHta) userContraindications.add("uncontrolled_hypertension");
  if (s.kaatsuVarices) userContraindications.add("severe_varicose_veins");
  if (s.kaatsuPregnancy) userContraindications.add("pregnancy");
  if (!s.saunaCleared) userContraindications.add("cardiac_instability");
  if (s.lymphedemaAvFistula) userContraindications.add("lymphedema_av_fistula");
  if (s.severeRespiratoryAnemia) {
    userContraindications.add("severe_respiratory_anemia");
  }
  if (s.acuteFeverInfection) userContraindications.add("acute_fever_infection");
  if (s.coldUrticariaRaynaud) userContraindications.add("cold_urticaria_raynaud");
  if (s.acuteTraumaOpenWound) userContraindications.add("acute_trauma_open_wound");
  if (s.spinalInstabilityRadiculopathy) {
    userContraindications.add("spinal_instability_radiculopathy");
  }
  if (s.orthostaticHypotension) {
    userContraindications.add("orthostatic_hypotension");
  }

  const equipmentAvailable = new Set(state.settings.equipmentIds ?? []);
  if (!s.ihhtSafetyOk) {
    equipmentAvailable.delete("oximeter");
  }

  const rawActivities = Array.isArray(state.intervalsContext?.todayActivities)
    ? state.intervalsContext.todayActivities
    : [];
  const todayActivities = s.blockColdAfterStrength
    ? rawActivities
    : rawActivities.filter(
        (act) => String(act?.type ?? "").toLowerCase() !== "strength"
      );

  return {
    userContraindications,
    equipmentAvailable,
    todayActivities,
    kaatsuSupervisedOnce: !s.kaatsuFirstAlone,
    spo2ThresholdPct: state.settings.spo2ThresholdPct,
    now: new Date(),
  };
}

function formatRemovalReason(reason) {
  if (reason === "strength_lt_4h") return "Musculation < 4 h (bain froid bloqué)";
  if (reason === "first_kaatsu_unsupervised")
    return "1re séance KAATSU sans supervision";
  if (reason === "missing_oximeter") return "Oxymètre absent ou sécurité IHHT non confirmée";
  if (reason === "unsafe_spo2_threshold") return "Seuil SpO₂ < 80 % interdit";
  if (reason === "kaatsu_max_continuous_exceeded")
    return "Plafond de durée continue KAATSU dépassé";
  if (reason === "max_minutes_exceeded") return "Budget temps dépassé";
  if (reason.startsWith("contraindication:")) {
    return `Contre-indication (${reason.slice("contraindication:".length)})`;
  }
  if (reason.startsWith("missing_equipment:")) {
    return `Matériel absent (${reason.slice("missing_equipment:".length)})`;
  }
  return reason;
}

function buildSessionTimerPayload(session) {
  const items = Array.isArray(session?.items) ? session.items : [];
  const phases = [];
  for (const ex of items) {
    const isIhhtItem =
      ex.family === "hyperoxia_ihht" || String(ex.id).startsWith("ihht_");
    const exPhases = normalizePhasesArray(ex.phases, ex.durationSec);
    for (const ph of exPhases) {
      phases.push({
        ...ph,
        label: `${ex.name} — ${ph.label}`,
        meta: {
          ...(ph.meta ?? {}),
          exerciseId: ex.id,
          family: ex.family,
          isIhht: isIhhtItem,
          isHypoxia: computePhaseIsHypoxia(ph, isIhhtItem),
        },
      });
    }
  }

  return {
    id: session.protocolId,
    protocolId: session.protocolId,
    name: session.protocolName || session.protocolId,
    family: session.protocolId,
    isIhht: items.some(
      (ex) => ex.family === "hyperoxia_ihht" || String(ex.id).startsWith("ihht_")
    ),
    isKaatsu: items.some(
      (ex) => ex.family === "kaatsu" || String(ex.id).startsWith("kaatsu_")
    ),
    phases,
    durationSec: session.totalSec,
    items,
  };
}

function renderTodayRecommendation() {
  const scoreObj = state.recoveryScore;
  const session = state.recommendedSession;

  if (dom.todayRecoveryScore) {
    dom.todayRecoveryScore.textContent = scoreObj
      ? `${scoreObj.score} / 100`
      : "— / 100";
  }

  if (dom.todayRecoveryLevel) {
    const levelMap = {
      good: ["Optimal", "badge-emerald"],
      moderate: ["Modéré", "badge-cyan"],
      low: ["Bas", "badge-amber"],
    };
    const [label, cls] = levelMap[scoreObj?.level] ?? ["—", ""];
    dom.todayRecoveryLevel.textContent = label;
    dom.todayRecoveryLevel.className = `badge ${cls}`.trim();
  }

  if (dom.todayRecoverySub) {
    const ctx = state.intervalsContext;
    if (ctx) {
      const parts = [];
      if (ctx.hrvToday !== null) parts.push(`HRV ${ctx.hrvToday} ms`);
      if (ctx.sleepHours !== null) parts.push(`Sommeil ${ctx.sleepHours} h`);
      if (ctx.tsb !== null) parts.push(`TSB ${ctx.tsb}`);
      dom.todayRecoverySub.textContent = parts.join(" · ") || "Intervals synchronisé";
    } else {
      dom.todayRecoverySub.textContent = "Estimation locale (sans Intervals)";
    }
  }

  if (dom.todaySourceBadge) {
    const isGemini = session?.source === "GEMINI";
    dom.todaySourceBadge.textContent = isGemini
      ? `Gemini (${session.model || "flash"})`
      : state.intervalsContext
        ? "Intervals + Local"
        : "Local déterministe";
    dom.todaySourceBadge.className = isGemini
      ? "badge badge-emerald"
      : "badge badge-cyan";
  }

  if (dom.todayProtocolName) {
    dom.todayProtocolName.textContent = session?.protocolName ?? "Protocole recommandé";
  }
  if (dom.todayProtocolRationale) {
    dom.todayProtocolRationale.textContent = session?.rationale ?? "";
  }
  if (dom.todayProtocolDuration) {
    dom.todayProtocolDuration.textContent = formatDurationSec(
      session?.totalSec ?? 0
    );
  }
  if (dom.todayLaunchSessionBtn) {
    dom.todayLaunchSessionBtn.disabled =
      !session || !Array.isArray(session.items) || session.items.length === 0;
  }

  if (dom.todaySessionItems) {
    dom.todaySessionItems.replaceChildren();
    const items = session?.items ?? [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "Aucun exercice autorisé avec les contre-indications et le matériel actuels.";
      dom.todaySessionItems.appendChild(empty);
    } else {
      for (const ex of items) {
        const card = document.createElement("article");
        card.className = "item-card";

        const title = document.createElement("h3");
        title.className = "item-title";
        title.textContent = ex.name;

        const meta = document.createElement("div");
        meta.className = "item-meta";

        const famBadge = document.createElement("span");
        famBadge.className = "badge badge-cyan";
        famBadge.textContent = ex.family;
        meta.appendChild(famBadge);

        const durBadge = document.createElement("span");
        durBadge.className = "badge";
        durBadge.textContent = formatDurationSec(ex.durationSec);
        meta.appendChild(durBadge);

        if (ex.replacedFrom) {
          const repBadge = document.createElement("span");
          repBadge.className = "badge badge-emerald";
          repBadge.textContent = `Substitue ${ex.replacedFrom}`;
          meta.appendChild(repBadge);
        }

        card.append(title, meta);

        if (Array.isArray(ex.cues) && ex.cues.length > 0) {
          const ul = document.createElement("ul");
          ul.className = "cues-list";
          for (const cue of ex.cues) {
            const li = document.createElement("li");
            li.textContent = cue;
            ul.appendChild(li);
          }
          card.appendChild(ul);
        }

        dom.todaySessionItems.appendChild(card);
      }
    }
  }

  if (dom.todayRemovedWrap && dom.todayRemovedList) {
    const removed = session?.removed ?? [];
    dom.todayRemovedList.replaceChildren();
    if (removed.length > 0) {
      for (const entry of removed) {
        const li = document.createElement("li");
        const exName = EXERCISES_BY_ID[entry.id]?.name ?? entry.id;
        const reasonsText = (entry.reasons ?? []).map(formatRemovalReason).join(", ");
        li.textContent = `${exName} (${entry.id}) : ${reasonsText}`;
        dom.todayRemovedList.appendChild(li);
      }
      dom.todayRemovedWrap.hidden = false;
    } else {
      dom.todayRemovedWrap.hidden = true;
    }
  }
}

async function refreshTodayRecommendation({
  fetchIntervals = false,
  useGemini = true,
  loadTimer = false,
} = {}) {
  const hasIntervalsKey = Boolean(
    String(state.vault?.INTERVALS_API_KEY ?? "").trim()
  );

  if (fetchIntervals && hasIntervalsKey && navigator.onLine !== false) {
    try {
      state.intervalsContext = await fetchRecoveryContext();
      if (dom.intervalsStatusPill) {
        dom.intervalsStatusPill.textContent = "Intervals : Synchronisé";
        dom.intervalsStatusPill.classList.add("is-online");
        dom.intervalsStatusPill.classList.remove("is-muted");
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? `Intervals : ${err.message}`
          : "Impossible de joindre Intervals.icu — repli local.",
        "error"
      );
    }
  }

  state.recoveryScore = computeRecoveryScore(state.intervalsContext ?? {});
  const ctx = buildEngineContextFromSettings();
  const protocolId = selectProtocol(ctx, state.recoveryScore);
  const built = buildSession(protocolId, ctx);
  const protoMeta = PROTOCOLS_BY_ID[protocolId];

  const baseSession = {
    protocolId,
    protocolName: protoMeta?.name ?? protocolId,
    rationale:
      protoMeta?.objective ??
      protoMeta?.notes ??
      "Séance déterministe assemblée localement.",
    items: built.items,
    removed: built.removed,
    totalSec: built.totalSec,
    source: "FALLBACK_LOCAL",
  };

  let finalSession = baseSession;
  const hasGeminiKey = Boolean(
    String(state.vault?.GEMINI_API_KEY ?? "").trim()
  );
  if (useGemini && hasGeminiKey && navigator.onLine !== false && built.items.length > 0) {
    finalSession = await personalizeSessionWithGemini({
      protocolId,
      ctx,
      baseSession,
      recoveryScore: state.recoveryScore,
    });
  }

  state.recommendedSession = finalSession;
  renderTodayRecommendation();

  if (loadTimer || (!state.activeSession && timer?.status === "idle")) {
    const timerPayload = buildSessionTimerPayload(finalSession);
    if (timerPayload.phases.length > 0) {
      loadIntoTimer(timerPayload, false);
    }
  }
}

function populateCatalogFamilyFilter() {
  const select = dom.catalogFamilyFilter;
  if (!select) return;
  const families = Array.from(
    new Set(state.catalog.exercises.map((ex) => ex.family))
  ).sort();

  const currentVal = select.value || "ALL";
  select.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "ALL";
  allOpt.textContent = "Toutes les familles";
  select.appendChild(allOpt);

  for (const fam of families) {
    const opt = document.createElement("option");
    opt.value = fam;
    opt.textContent = fam;
    select.appendChild(opt);
  }
  select.value = families.includes(currentVal) ? currentVal : "ALL";
}

function renderCatalog() {
  const grid = dom.catalogGrid;
  if (!grid) return;

  const query = (dom.catalogSearch?.value ?? "").trim().toLowerCase();
  const familyFilter = dom.catalogFamilyFilter?.value ?? "ALL";
  const onlyAvail = Boolean(dom.catalogAvailableOnly?.checked);
  const ownedSet = new Set(state.settings.equipmentIds ?? []);
  const safety = evaluateSafetyStatus();
  const ctx = buildEngineContextFromSettings();

  const filtered = state.catalog.exercises.filter((ex) => {
    if (familyFilter !== "ALL" && ex.family !== familyFilter) return false;
    if (onlyAvail && ex.equipment.some((eq) => !ownedSet.has(eq))) return false;
    if (query) {
      const hay =
        `${ex.name} ${ex.family} ${ex.zones.join(" ")} ${ex.description}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  if (dom.catalogCount) {
    dom.catalogCount.textContent = `${filtered.length} exercice${filtered.length > 1 ? "s" : ""}`;
  }

  grid.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      state.catalog.exercises.length === 0
        ? "Catalogue vide (vérifiez catalog.js)."
        : "Aucun exercice ne correspond aux filtres sélectionnés.";
    grid.appendChild(empty);
    return;
  }

  for (const ex of filtered) {
    const blockReason = getItemBlockReason(ex, safety, ctx);
    const card = document.createElement("article");
    card.className = `item-card${blockReason ? " is-blocked" : ""}`;

    const top = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "item-title";
    title.textContent = ex.name;
    top.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "item-meta";

    const famBadge = document.createElement("span");
    famBadge.className = "badge badge-cyan";
    famBadge.textContent = ex.family;
    meta.appendChild(famBadge);

    const durBadge = document.createElement("span");
    durBadge.className = "badge";
    durBadge.textContent = formatDurationSec(ex.durationSec);
    meta.appendChild(durBadge);

    if (ex.zones.length > 0) {
      const zoneBadge = document.createElement("span");
      zoneBadge.className = "badge";
      zoneBadge.textContent = ex.zones.slice(0, 2).join(", ");
      meta.appendChild(zoneBadge);
    }

    if (blockReason) {
      const warnBadge = document.createElement("span");
      warnBadge.className = "badge badge-coral";
      warnBadge.textContent = "Bloqué sécurité";
      meta.appendChild(warnBadge);
    }

    top.appendChild(meta);

    if (ex.description) {
      const desc = document.createElement("p");
      desc.className = "item-desc";
      desc.textContent = ex.description;
      top.appendChild(desc);
    }

    const footer = document.createElement("div");
    footer.className = "item-footer";

    const eqText = document.createElement("span");
    eqText.className = "form-hint";
    eqText.textContent =
      ex.equipment.length > 0 ? ex.equipment.join(", ") : "Sans matériel";
    footer.appendChild(eqText);

    const launchBtn = document.createElement("button");
    launchBtn.type = "button";
    launchBtn.className = "btn btn-primary btn-sm";
    launchBtn.textContent = "Lancer";
    launchBtn.disabled = Boolean(blockReason);
    if (blockReason) launchBtn.title = blockReason;
    launchBtn.addEventListener("click", () => loadIntoTimer(ex, true));
    footer.appendChild(launchBtn);

    card.append(top, footer);
    grid.appendChild(card);
  }
}

function renderProtocols() {
  const grid = dom.protocolsGrid;
  if (!grid) return;

  const protocols = state.catalog.protocols;
  const safety = evaluateSafetyStatus();
  const ctx = buildEngineContextFromSettings();

  if (dom.protocolsCount) {
    dom.protocolsCount.textContent = `${protocols.length} protocole${protocols.length > 1 ? "s" : ""}`;
  }

  grid.replaceChildren();
  if (protocols.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aucun protocole défini dans catalog.js.";
    grid.appendChild(empty);
    return;
  }

  for (const proto of protocols) {
    const blockReason = getItemBlockReason(proto, safety, ctx);
    const card = document.createElement("article");
    card.className = `item-card${blockReason ? " is-blocked" : ""}`;

    const top = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "item-title";
    title.textContent = proto.name;
    top.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "item-meta";

    const durBadge = document.createElement("span");
    durBadge.className = "badge badge-emerald";
    durBadge.textContent = formatDurationSec(proto.durationSec);
    meta.appendChild(durBadge);

    const stepsCount = expandPhases(proto.phases).length;
    const stepsBadge = document.createElement("span");
    stepsBadge.className = "badge";
    stepsBadge.textContent = `${stepsCount} phase${stepsCount > 1 ? "s" : ""}`;
    meta.appendChild(stepsBadge);

    if (blockReason) {
      const warn = document.createElement("span");
      warn.className = "badge badge-coral";
      warn.textContent = "Bloqué sécurité";
      meta.appendChild(warn);
    }
    top.appendChild(meta);

    if (proto.description) {
      const desc = document.createElement("p");
      desc.className = "item-desc";
      desc.textContent = proto.description;
      top.appendChild(desc);
    }

    const footer = document.createElement("div");
    footer.className = "item-footer";

    const eqHint = document.createElement("span");
    eqHint.className = "form-hint";
    eqHint.textContent =
      proto.equipment.length > 0
        ? proto.equipment.join(", ")
        : "Aucun équipement requis";
    footer.appendChild(eqHint);

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "btn btn-emerald btn-sm";
    startBtn.textContent = "Démarrer";
    startBtn.disabled = Boolean(blockReason) || proto.phases.length === 0;
    if (blockReason) startBtn.title = blockReason;
    startBtn.addEventListener("click", () => loadIntoTimer(proto, true));
    footer.appendChild(startBtn);

    card.append(top, footer);
    grid.appendChild(card);
  }
}

function renderEquipment() {
  const grid = dom.equipmentGrid;
  if (!grid) return;

  const owned = new Set(state.settings.equipmentIds ?? []);
  grid.replaceChildren();

  if (state.catalog.equipment.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aucun équipement déclaré dans catalog.js.";
    grid.appendChild(empty);
    return;
  }

  for (const eq of state.catalog.equipment) {
    const isOwned = owned.has(eq.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "equipment-toggle";
    btn.setAttribute("aria-pressed", isOwned ? "true" : "false");

    const nameSpan = document.createElement("span");
    nameSpan.textContent = eq.name;

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${isOwned ? "badge-emerald" : ""}`;
    statusBadge.textContent = isOwned ? "Dispo" : "Absent";

    btn.append(nameSpan, statusBadge);
    btn.addEventListener("click", () => {
      const next = new Set(state.settings.equipmentIds ?? []);
      if (next.has(eq.id)) next.delete(eq.id);
      else next.add(eq.id);
      state.settings.equipmentIds = [...next];
      saveLocalSettings();
      renderEquipment();
      renderCatalog();
      renderTodayKpis();
      refreshTodayRecommendation({ fetchIntervals: false, useGemini: false });
    });
    grid.appendChild(btn);
  }
}

function recordHistoryEntry(entry) {
  state.history.unshift(entry);
  saveLocalHistory();
  renderHistory();
}

function renderHistory() {
  const list = dom.historyList;
  if (!list) return;
  list.replaceChildren();

  if (state.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aucune séance enregistrée pour le moment.";
    list.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const row = document.createElement("div");
    row.className = "history-item";

    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.name || "Séance";
    const sub = document.createElement("div");
    sub.className = "form-hint";
    const dateStr = item.timestamp
      ? new Date(item.timestamp).toLocaleString("fr-FR")
      : "";
    sub.textContent = `${dateStr} · ${formatDurationSec(item.elapsedSec)}${item.rpe ? ` · RPE ${item.rpe}/10` : ""}${item.notes ? ` · ${item.notes}` : ""}`;
    left.append(title, sub);

    const badge = document.createElement("span");
    badge.className = `badge ${item.interrupted ? "badge-coral" : "badge-emerald"}`;
    badge.textContent = item.interrupted ? "Arrêt sécurité" : "Terminée";

    row.append(left, badge);
    list.appendChild(row);
  }
}

/* =========================================================================
   RÉGLAGES, QUESTIONNAIRE & COFFRE-FORT
   ========================================================================= */
function populateSettingsForm() {
  const s = state.settings.safety;
  const k = state.settings.kaatsuPressures;
  const v = state.vault;

  if (dom.qKaatsuTvp) dom.qKaatsuTvp.checked = Boolean(s.kaatsuTvp);
  if (dom.qKaatsuHta) dom.qKaatsuHta.checked = Boolean(s.kaatsuHta);
  if (dom.qKaatsuVarices) dom.qKaatsuVarices.checked = Boolean(s.kaatsuVarices);
  if (dom.qKaatsuPregnancy) dom.qKaatsuPregnancy.checked = Boolean(s.kaatsuPregnancy);
  if (dom.qKaatsuFirstAlone) dom.qKaatsuFirstAlone.checked = Boolean(s.kaatsuFirstAlone);
  if (dom.qLymphedemaAvFistula) {
    dom.qLymphedemaAvFistula.checked = Boolean(s.lymphedemaAvFistula);
  }
  if (dom.qSevereRespiratoryAnemia) {
    dom.qSevereRespiratoryAnemia.checked = Boolean(s.severeRespiratoryAnemia);
  }
  if (dom.qAcuteFeverInfection) {
    dom.qAcuteFeverInfection.checked = Boolean(s.acuteFeverInfection);
  }
  if (dom.qColdUrticariaRaynaud) {
    dom.qColdUrticariaRaynaud.checked = Boolean(s.coldUrticariaRaynaud);
  }
  if (dom.qAcuteTraumaOpenWound) {
    dom.qAcuteTraumaOpenWound.checked = Boolean(s.acuteTraumaOpenWound);
  }
  if (dom.qSpinalInstabilityRadiculopathy) {
    dom.qSpinalInstabilityRadiculopathy.checked = Boolean(
      s.spinalInstabilityRadiculopathy
    );
  }
  if (dom.qOrthostaticHypotension) {
    dom.qOrthostaticHypotension.checked = Boolean(s.orthostaticHypotension);
  }
  if (dom.qIhhtSafetyOk) dom.qIhhtSafetyOk.checked = Boolean(s.ihhtSafetyOk);
  if (dom.qSaunaCleared) dom.qSaunaCleared.checked = Boolean(s.saunaCleared);
  if (dom.qBlockColdStrength) dom.qBlockColdStrength.checked = Boolean(s.blockColdAfterStrength);

  if (dom.kaatsuArmLeft) dom.kaatsuArmLeft.value = String(k.armLeftMmhg);
  if (dom.kaatsuArmRight) dom.kaatsuArmRight.value = String(k.armRightMmhg);
  if (dom.kaatsuLegLeft) dom.kaatsuLegLeft.value = String(k.legLeftMmhg);
  if (dom.kaatsuLegRight) dom.kaatsuLegRight.value = String(k.legRightMmhg);
  if (dom.kaatsuMaxMin) dom.kaatsuMaxMin.value = String(k.maxOcclusionMin);
  if (dom.spo2Threshold) dom.spo2Threshold.value = String(state.settings.spo2ThresholdPct);

  if (dom.vaultAthleteId) dom.vaultAthleteId.value = String(v.INTERVALS_ATHLETE_ID ?? "");
  if (dom.vaultIntervalsKey) dom.vaultIntervalsKey.value = String(v.INTERVALS_API_KEY ?? "");
  if (dom.vaultGeminiKey) dom.vaultGeminiKey.value = String(v.GEMINI_API_KEY ?? "");
  if (dom.vaultDriveUrl) dom.vaultDriveUrl.value = String(v.DRIVE_WEBHOOK_URL ?? "");

  updateSettingsSummaryBadge();
}

function updateSettingsSummaryBadge() {
  const safety = evaluateSafetyStatus();
  if (dom.settingsSafetySummary) {
    dom.settingsSafetySummary.textContent = safety.hasAnyBlock
      ? "Restrictions actives"
      : "Apte";
    dom.settingsSafetySummary.className = safety.hasAnyBlock
      ? "badge badge-amber"
      : "badge badge-emerald";
  }
  if (dom.intervalsStatusPill) {
    const hasKey = Boolean(String(state.vault?.INTERVALS_API_KEY ?? "").trim());
    dom.intervalsStatusPill.textContent = hasKey
      ? "Intervals : Configuré"
      : "Intervals : —";
    dom.intervalsStatusPill.classList.toggle("is-online", hasKey);
    dom.intervalsStatusPill.classList.toggle("is-muted", !hasKey);
  }
}

function saveSettingsFromForm() {
  state.settings.safety = {
    kaatsuTvp: Boolean(dom.qKaatsuTvp?.checked),
    kaatsuHta: Boolean(dom.qKaatsuHta?.checked),
    kaatsuVarices: Boolean(dom.qKaatsuVarices?.checked),
    kaatsuPregnancy: Boolean(dom.qKaatsuPregnancy?.checked),
    kaatsuFirstAlone: Boolean(dom.qKaatsuFirstAlone?.checked),
    lymphedemaAvFistula: Boolean(dom.qLymphedemaAvFistula?.checked),
    severeRespiratoryAnemia: Boolean(dom.qSevereRespiratoryAnemia?.checked),
    acuteFeverInfection: Boolean(dom.qAcuteFeverInfection?.checked),
    coldUrticariaRaynaud: Boolean(dom.qColdUrticariaRaynaud?.checked),
    acuteTraumaOpenWound: Boolean(dom.qAcuteTraumaOpenWound?.checked),
    spinalInstabilityRadiculopathy: Boolean(
      dom.qSpinalInstabilityRadiculopathy?.checked
    ),
    orthostaticHypotension: Boolean(dom.qOrthostaticHypotension?.checked),
    ihhtSafetyOk: Boolean(dom.qIhhtSafetyOk?.checked),
    saunaCleared: Boolean(dom.qSaunaCleared?.checked),
    blockColdAfterStrength: Boolean(dom.qBlockColdStrength?.checked),
  };

  state.settings.kaatsuPressures = {
    armLeftMmhg: clampNumber(dom.kaatsuArmLeft?.value, 40, 160, 110),
    armRightMmhg: clampNumber(dom.kaatsuArmRight?.value, 40, 160, 110),
    legLeftMmhg: clampNumber(dom.kaatsuLegLeft?.value, 60, 240, 170),
    legRightMmhg: clampNumber(dom.kaatsuLegRight?.value, 60, 240, 170),
    maxOcclusionMin: clampNumber(dom.kaatsuMaxMin?.value, 2, 15, 10),
  };

  state.settings.spo2ThresholdPct = clampNumber(
    dom.spo2Threshold?.value,
    80,
    95,
    85
  );
  timer?.setSpo2ThresholdPct(state.settings.spo2ThresholdPct);
  saveLocalSettings();

  const rawDriveUrl = dom.vaultDriveUrl?.value?.trim() || "";
  let validDriveUrl = String(state.vault?.DRIVE_WEBHOOK_URL ?? "");
  if (rawDriveUrl === "") {
    validDriveUrl = "";
  } else {
    const driveValidation = driveSync.validateDriveWebhookUrl(rawDriveUrl);
    if (driveValidation.valid) {
      validDriveUrl = driveValidation.url;
    } else {
      showToast(
        driveValidation.error ||
          "URL Webhook Drive invalide — URL précédente conservée.",
        "error"
      );
    }
  }

  try {
    state.vault = saveVault({
      INTERVALS_ATHLETE_ID: dom.vaultAthleteId?.value?.trim() || "0",
      INTERVALS_API_KEY: dom.vaultIntervalsKey?.value?.trim() || "",
      GEMINI_API_KEY: dom.vaultGeminiKey?.value?.trim() || "",
      DRIVE_WEBHOOK_URL: validDriveUrl,
    });
  } catch {
    // Tolérance si vault.js utilise un autre schéma de patch
  }

  updateSettingsSummaryBadge();
  renderTodayKpis();
  renderCatalog();
  renderProtocols();
  refreshTodayRecommendation({ fetchIntervals: false, useGemini: false });
}

/* =========================================================================
   OUTBOX, RÉSEAU & INITIALISATION
   ========================================================================= */
async function refreshOutboxCount() {
  try {
    const count = await countOutbox();
    if (dom.outboxCount) dom.outboxCount.textContent = String(count);
    dom.outboxFlushBtn?.classList.toggle("has-pending", count > 0);
  } catch {
    // Outbox non disponible
  }
}

function updateNetworkStatus() {
  const online = navigator.onLine !== false;
  if (dom.networkBadge) {
    dom.networkBadge.textContent = online ? "En ligne" : "Hors-ligne";
    dom.networkBadge.classList.toggle("is-online", online);
    dom.networkBadge.classList.toggle("is-offline", !online);
  }
}

function bindEvents() {
  dom.safetyStatusPill?.addEventListener("click", () => {
    dom.selectTabByKey?.("settings");
  });

  dom.timerStartBtn?.addEventListener("click", () => {
    if (!state.activeSession && state.catalog.exercises.length > 0) {
      loadIntoTimer(state.catalog.exercises[0], false);
    }
    timer?.start();
  });

  dom.timerPauseBtn?.addEventListener("click", () => {
    const ok = timer?.togglePause();
    if (!ok && timer?.status === "paused" && timer?.pauseReason === "spo2_stale") {
      const threshold = Math.max(80, Number(state.settings.spo2ThresholdPct) || 85);
      showToast(
        `Reprise bloquée : saisissez une nouvelle SpO₂ ≥ ${threshold} % pour relancer la phase hypoxique.`,
        "error"
      );
    }
  });

  dom.timerSkipBtn?.addEventListener("click", () => {
    timer?.skip();
  });

  dom.timerStopBtn?.addEventListener("click", () => {
    timer?.stop();
  });

  dom.timerMuteBtn?.addEventListener("click", () => {
    state.timerMuted = !state.timerMuted;
    timer?.setMuted(state.timerMuted);
    dom.timerMuteBtn.setAttribute("aria-pressed", state.timerMuted ? "true" : "false");
    dom.timerMuteBtn.textContent = state.timerMuted ? "Son : Muet" : "Son : Activé";
  });

  dom.timerVibrateBtn?.addEventListener("click", () => {
    state.timerVibrate = !state.timerVibrate;
    timer?.setVibrateEnabled(state.timerVibrate);
    dom.timerVibrateBtn.setAttribute(
      "aria-pressed",
      state.timerVibrate ? "true" : "false"
    );
    dom.timerVibrateBtn.textContent = state.timerVibrate
      ? "Vibration : Activée"
      : "Vibration : Désactivée";
  });

  dom.catalogSearch?.addEventListener("input", renderCatalog);
  dom.catalogFamilyFilter?.addEventListener("change", renderCatalog);
  dom.catalogAvailableOnly?.addEventListener("change", renderCatalog);

  dom.equipSelectAllBtn?.addEventListener("click", () => {
    state.settings.equipmentIds = state.catalog.equipment.map((e) => e.id);
    saveLocalSettings();
    renderEquipment();
    renderCatalog();
    renderTodayKpis();
    refreshTodayRecommendation({ fetchIntervals: false, useGemini: false });
  });

  dom.equipSelectNoneBtn?.addEventListener("click", () => {
    state.settings.equipmentIds = [];
    saveLocalSettings();
    renderEquipment();
    renderCatalog();
    renderTodayKpis();
    refreshTodayRecommendation({ fetchIntervals: false, useGemini: false });
  });

  dom.todaySyncBtn?.addEventListener("click", () => {
    refreshTodayRecommendation({
      fetchIntervals: true,
      useGemini: true,
      loadTimer: true,
    });
  });

  dom.todayLaunchSessionBtn?.addEventListener("click", () => {
    if (!state.recommendedSession) return;
    const payload = buildSessionTimerPayload(state.recommendedSession);
    if (payload.phases.length === 0) {
      showToast("Aucune phase exécutable dans la séance recommandée.", "error");
      return;
    }
    loadIntoTimer(payload, false);
    timer?.start();
  });

  dom.liveSpo2Input?.addEventListener("input", () => {
    const rawStr = dom.liveSpo2Input?.value?.trim() ?? "";
    if (rawStr === "") {
      state.liveSpo2StreamPct = null;
      return;
    }
    recordLiveSpo2(Number(rawStr), Date.now(), "input");
  });

  window.addEventListener("webrecovery:spo2", (event) => {
    const val = Number(event?.detail?.spo2 ?? event?.detail);
    const ts = Number(event?.detail?.timestampMs);
    if (Number.isFinite(val)) {
      recordLiveSpo2(val, Number.isFinite(ts) ? ts : Date.now(), "event");
    }
  });

  dom.bleOximeterBtn?.addEventListener("click", async () => {
    if (!bleOximeter) {
      initBleOximeter();
    }
    if (bleOximeter?.getStatus() === "connected") {
      bleOximeter.disconnect();
      return;
    }
    const res = await bleOximeter?.connect();
    if (res && !res.ok && res.reason === "unsupported") {
      showToast(res.message, "info");
    }
  });

  dom.sessionLogForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const rpe = clampNumber(dom.sessionRpeInput?.value, 1, 10, 4);
    const notes = dom.sessionNotesInput?.value?.trim() || "";
    const nowIso = new Date().toISOString();
    const entry = {
      external_id: `webrecovery_${Date.now()}`,
      id: `webrecovery_${Date.now()}`,
      sessionId: state.activeSession?.id ?? "custom",
      protocolId: state.activeSession?.protocolId ?? state.recommendedSession?.protocolId ?? "recovery",
      name: state.activeSession?.name ?? "Séance de récupération libre",
      family: state.activeSession?.family ?? "Récupération",
      recoveryType:
        state.activeSession?.protocolId ??
        state.activeSession?.family ??
        "recovery",
      elapsedSec:
        state.lastSummary?.elapsedSec ?? state.activeSession?.durationSec ?? 0,
      items: state.activeSession?.items ?? [],
      completed: true,
      interrupted: Boolean(state.lastSummary?.interrupted),
      reason: state.lastSummary?.reason ?? "",
      rpe,
      notes,
      timestamp: nowIso,
    };

    recordHistoryEntry(entry);
    try {
      const pubRes = await publishRecoveryWorkout({ session: entry });
      await refreshOutboxCount();
      if (pubRes.ok) {
        showToast(
          "Séance publiée sur Intervals.icu (RecoveryLoad / RecoveryType).",
          "success"
        );
      } else {
        showToast(
          pubRes.reason || "Séance enregistrée dans l'historique et l'Outbox.",
          "info"
        );
      }
    } catch {
      showToast("Séance enregistrée localement (Outbox indisponible).", "info");
    }
  });

  dom.outboxFlushBtn?.addEventListener("click", async () => {
    try {
      const result = await flushPendingRecoveryWorkouts();
      await refreshOutboxCount();
      showToast(
        `Outbox synchronisée (${result?.sentCount ?? 0} élément(s)).`,
        "success"
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Échec de synchronisation Outbox.",
        "error"
      );
    }
  });

  dom.historyExportBtn?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.history, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `webrecovery-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  dom.historyClearBtn?.addEventListener("click", () => {
    state.history = [];
    saveLocalHistory();
    renderHistory();
    showToast("Historique local vidé.", "info");
  });

  // Validation dynamique et soumission du formulaire Réglages
  const settingsForm = dom.settingsForm;
  if (settingsForm) {
    settingsForm.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement) {
        event.target.setCustomValidity("");
      }
    });

    settingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const firstInvalid = settingsForm.querySelector(":invalid");
      if (firstInvalid instanceof HTMLInputElement) {
        firstInvalid.focus();
        firstInvalid.reportValidity();
        showToast("Veuillez corriger les valeurs hors plage.", "error");
        return;
      }
      saveSettingsFromForm();
      showToast("Réglages de sécurité et pressions enregistrés.", "success");
    });

    for (const checkbox of settingsForm.querySelectorAll('input[type="checkbox"]')) {
      checkbox.addEventListener("change", saveSettingsFromForm);
    }
  }

  dom.pushDriveBtn?.addEventListener("click", async () => {
    const savedUrl = String(state.vault?.DRIVE_WEBHOOK_URL ?? "").trim();
    const inputUrl = dom.vaultDriveUrl?.value?.trim() || "";
    if (!savedUrl) {
      showToast(
        "Enregistrez d'abord une URL Webhook Drive valide dans les réglages.",
        "error"
      );
      dom.vaultDriveUrl?.focus();
      return;
    }
    if (inputUrl && inputUrl !== savedUrl) {
      showToast(
        "L'URL saisie diffère de l'URL enregistrée. Enregistrez les réglages avant de synchroniser.",
        "error"
      );
      dom.vaultDriveUrl?.focus();
      return;
    }
    const validation = driveSync.validateDriveWebhookUrl(savedUrl);
    if (!validation.valid) {
      showToast(
        validation.error || "URL Webhook Drive enregistrée invalide.",
        "error"
      );
      dom.vaultDriveUrl?.focus();
      return;
    }
    try {
      await driveSync.pushCustomExercisesToDrive({
        webhookUrl: validation.url,
        secret: String(state.vault?.DRIVE_WEBHOOK_SECRET ?? ""),
        exercisesJson: state.catalog.exercises,
      });
      showToast("Synchronisation Google Drive effectuée.", "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Erreur d'envoi Google Drive.",
        "error"
      );
    }
  });

  dom.exportVaultBtn?.addEventListener("click", () => {
    try {
      const json = exportVaultJson({ includeSecrets: false });
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "webrecovery-vault-export.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast("Impossible d'exporter le coffre-fort.", "error");
    }
  });

  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (dom.pwaInstallBtn) {
      dom.pwaInstallBtn.hidden = false;
    }
  });

  dom.pwaInstallBtn?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // Ignorer les erreurs si l'invite native est annulée
    } finally {
      if (dom.pwaInstallBtn) {
        dom.pwaInstallBtn.hidden = true;
      }
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    if (dom.pwaInstallBtn) {
      dom.pwaInstallBtn.hidden = true;
    }
  });
}

function cacheDomReferences() {
  dom.tablist = document.getElementById("main-tablist");
  dom.networkBadge = document.getElementById("network-badge");
  dom.outboxFlushBtn = document.getElementById("outbox-flush-btn");
  dom.outboxCount = document.getElementById("outbox-count");
  dom.safetyStatusPill = document.getElementById("safety-status-pill");
  dom.intervalsStatusPill = document.getElementById("intervals-status-pill");
  dom.pwaInstallBtn = document.getElementById("pwa-install-btn");
  dom.toastBanner = document.getElementById("toast-banner");

  dom.todaySafetyBadge = document.getElementById("today-safety-badge");
  dom.todaySafetyWarnings = document.getElementById("today-safety-warnings");
  dom.todaySyncBtn = document.getElementById("today-sync-btn");
  dom.todayLaunchSessionBtn = document.getElementById("today-launch-session-btn");
  dom.todaySourceBadge = document.getElementById("today-source-badge");
  dom.todayRecoveryScore = document.getElementById("today-recovery-score");
  dom.todayRecoveryLevel = document.getElementById("today-recovery-level");
  dom.todayRecoverySub = document.getElementById("today-recovery-sub");
  dom.todayProtocolName = document.getElementById("today-protocol-name");
  dom.todayProtocolRationale = document.getElementById("today-protocol-rationale");
  dom.todayProtocolDuration = document.getElementById("today-protocol-duration");
  dom.todaySessionItems = document.getElementById("today-session-items");
  dom.todayRemovedWrap = document.getElementById("today-removed-wrap");
  dom.todayRemovedList = document.getElementById("today-removed-list");
  dom.kpiSessionName = document.getElementById("kpi-session-name");
  dom.kpiSessionSub = document.getElementById("kpi-session-sub");
  dom.kpiEquipReady = document.getElementById("kpi-equip-ready");
  dom.kpiSpo2Threshold = document.getElementById("kpi-spo2-threshold");
  dom.kpiKaatsuCaps = document.getElementById("kpi-kaatsu-caps");

  dom.timerTitle = document.getElementById("timer-title");
  dom.timerSubtitle = document.getElementById("timer-subtitle");
  dom.timerStatusBadge = document.getElementById("timer-status-badge");
  dom.timerRingProgress = document.getElementById("timer-ring-progress");
  dom.timerClock = document.getElementById("timer-clock");
  dom.timerPhaseLabel = document.getElementById("timer-phase-label");
  dom.timerStepMeta = document.getElementById("timer-step-meta");
  dom.timerStartBtn = document.getElementById("timer-start-btn");
  dom.timerPauseBtn = document.getElementById("timer-pause-btn");
  dom.timerSkipBtn = document.getElementById("timer-skip-btn");
  dom.timerStopBtn = document.getElementById("timer-stop-btn");
  dom.timerMuteBtn = document.getElementById("timer-mute-btn");
  dom.timerVibrateBtn = document.getElementById("timer-vibrate-btn");
  dom.spo2GuardBox = document.getElementById("spo2-guard-box");
  dom.spo2StaleAlert = document.getElementById("spo2-stale-alert");
  dom.liveSpo2Input = document.getElementById("live-spo2-input");
  dom.bleOximeterBtn = document.getElementById("ble-oximeter-btn");
  dom.bleOximeterStatus = document.getElementById("ble-oximeter-status");
  dom.timerPhaseQueue = document.getElementById("timer-phase-queue");

  dom.sessionLogForm = document.getElementById("session-log-form");
  dom.sessionRpeInput = document.getElementById("session-rpe-input");
  dom.sessionNotesInput = document.getElementById("session-notes-input");

  dom.catalogCount = document.getElementById("catalog-count");
  dom.catalogSearch = document.getElementById("catalog-search");
  dom.catalogFamilyFilter = document.getElementById("catalog-family-filter");
  dom.catalogAvailableOnly = document.getElementById("catalog-available-only");
  dom.catalogGrid = document.getElementById("catalog-grid");

  dom.protocolsCount = document.getElementById("protocols-count");
  dom.protocolsGrid = document.getElementById("protocols-grid");

  dom.equipmentGrid = document.getElementById("equipment-grid");
  dom.equipSelectAllBtn = document.getElementById("equip-select-all-btn");
  dom.equipSelectNoneBtn = document.getElementById("equip-select-none-btn");

  dom.historyList = document.getElementById("history-list");
  dom.historyExportBtn = document.getElementById("history-export-btn");
  dom.historyClearBtn = document.getElementById("history-clear-btn");

  dom.settingsForm = document.getElementById("settings-form");
  dom.settingsSafetySummary = document.getElementById("settings-safety-summary");
  dom.qKaatsuTvp = document.getElementById("q-kaatsu-tvp");
  dom.qKaatsuHta = document.getElementById("q-kaatsu-hta");
  dom.qKaatsuVarices = document.getElementById("q-kaatsu-varices");
  dom.qKaatsuPregnancy = document.getElementById("q-kaatsu-pregnancy");
  dom.qKaatsuFirstAlone = document.getElementById("q-kaatsu-first-alone");
  dom.qLymphedemaAvFistula = document.getElementById("q-lymphedema-av-fistula");
  dom.qSevereRespiratoryAnemia = document.getElementById(
    "q-severe-respiratory-anemia"
  );
  dom.qAcuteFeverInfection = document.getElementById("q-acute-fever-infection");
  dom.qColdUrticariaRaynaud = document.getElementById("q-cold-urticaria-raynaud");
  dom.qAcuteTraumaOpenWound = document.getElementById("q-acute-trauma-open-wound");
  dom.qSpinalInstabilityRadiculopathy = document.getElementById(
    "q-spinal-instability-radiculopathy"
  );
  dom.qOrthostaticHypotension = document.getElementById(
    "q-orthostatic-hypotension"
  );
  dom.qIhhtSafetyOk = document.getElementById("q-ihht-safety-ok");
  dom.qSaunaCleared = document.getElementById("q-sauna-cleared");
  dom.qBlockColdStrength = document.getElementById("q-block-cold-strength");
  dom.kaatsuArmLeft = document.getElementById("kaatsu-arm-left");
  dom.kaatsuArmRight = document.getElementById("kaatsu-arm-right");
  dom.kaatsuLegLeft = document.getElementById("kaatsu-leg-left");
  dom.kaatsuLegRight = document.getElementById("kaatsu-leg-right");
  dom.kaatsuMaxMin = document.getElementById("kaatsu-max-min");
  dom.spo2Threshold = document.getElementById("spo2-threshold");
  dom.vaultAthleteId = document.getElementById("vault-athlete-id");
  dom.vaultIntervalsKey = document.getElementById("vault-intervals-key");
  dom.vaultGeminiKey = document.getElementById("vault-gemini-key");
  dom.vaultDriveUrl = document.getElementById("vault-drive-url");
  dom.pushDriveBtn = document.getElementById("push-drive-btn");
  dom.exportVaultBtn = document.getElementById("export-vault-btn");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bootstrap() {
  cacheDomReferences();
  setupTabsNavigation();
  normalizeCatalogData();
  initTimer();
  initBleOximeter();
  populateCatalogFamilyFilter();
  populateSettingsForm();
  renderTodayKpis();
  renderCatalog();
  renderProtocols();
  renderEquipment();
  renderHistory();
  updateNetworkStatus();
  refreshOutboxCount();
  bindEvents();
  registerServiceWorker();

  // Calcule immédiatement la séance recommandée locale puis tente la synchro Intervals/Gemini
  const hasIntervalsKey = Boolean(
    String(state.vault?.INTERVALS_API_KEY ?? "").trim()
  );
  refreshTodayRecommendation({
    fetchIntervals: hasIntervalsKey,
    useGemini: true,
    loadTimer: true,
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
