import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MultiPhaseTimer,
  expandPhases,
  formatDurationSec,
  isPhaseHypoxic,
} from "../timer.js";
import {
  createBleOximeter,
  decodeSfloat16,
  parseHeartRateMeasurement,
  parsePlxMeasurement,
} from "../bleOximeter.js";

/**
 * Horloge déterministe injectable simulant `now`, `setInterval` et `clearInterval`.
 */
function createFakeClock(initialMs = 1_000_000) {
  let currentMs = initialMs;
  let nextId = 1;
  /** @type {Map<number, { fn: Function, intervalMs: number, nextAtMs: number }>} */
  const timers = new Map();

  return {
    now: () => currentMs,
    setInterval: (fn, intervalMs) => {
      const id = nextId++;
      timers.set(id, {
        fn,
        intervalMs: Math.max(1, intervalMs),
        nextAtMs: currentMs + Math.max(1, intervalMs),
      });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    advanceBy: (ms) => {
      const targetMs = currentMs + ms;
      while (true) {
        let earliest = null;
        for (const [id, entry] of timers.entries()) {
          if (entry.nextAtMs <= targetMs) {
            if (!earliest || entry.nextAtMs < earliest.entry.nextAtMs) {
              earliest = { id, entry };
            }
          }
        }
        if (!earliest) {
          break;
        }
        currentMs = earliest.entry.nextAtMs;
        earliest.entry.nextAtMs += earliest.entry.intervalMs;
        if (timers.has(earliest.id)) {
          earliest.entry.fn();
        }
      }
      currentMs = targetMs;
    },
    activeTimerCount: () => timers.size,
  };
}

describe("expandPhases & formatDurationSec", () => {
  it("déplie les phases avec repeat unitaire et blocs imbriqués", () => {
    const steps = expandPhases([
      { label: "Échauffement", sec: 10 },
      {
        repeat: 2,
        phases: [
          { label: "Occlusion ON", sec: 30 },
          { label: "Relâchement OFF", sec: 30 },
        ],
      },
      { label: "Respiration", sec: 5, repeat: 2 },
      { label: "Invalide", sec: 0 },
    ]);

    assert.equal(steps.length, 7);
    assert.equal(steps[0].label, "Échauffement");
    assert.equal(steps[1].label, "Occlusion ON (1/2)");
    assert.equal(steps[2].label, "Relâchement OFF (1/2)");
    assert.equal(steps[3].label, "Occlusion ON (2/2)");
    assert.equal(steps[4].label, "Relâchement OFF (2/2)");
    assert.equal(steps[5].label, "Respiration");
    assert.equal(steps[5].rep, 1);
    assert.equal(steps[6].rep, 2);
    assert.equal(steps[6].totalReps, 2);
    assert.equal(steps[6].stepIndex, 6);
    assert.equal(steps[6].totalSteps, 7);
  });

  it("formate correctement les durées mm:ss", () => {
    assert.equal(formatDurationSec(0), "00:00");
    assert.equal(formatDurationSec(65), "01:05");
    assert.equal(formatDurationSec(600), "10:00");
  });
});

describe("MultiPhaseTimer", () => {
  it("enchaîne plusieurs phases avec repeat, bip audio, vibration et onDone", async () => {
    const clock = createFakeClock();
    const audioCalls = [];
    const vibrateCalls = [];
    const phaseEvents = [];
    let doneSummary = null;
    let releasedCount = 0;

    const wakeLock = {
      request: async () => ({
        release: async () => {
          releasedCount += 1;
        },
      }),
    };

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      audio: { play: (kind) => audioCalls.push(kind) },
      vibrate: (pattern) => {
        vibrateCalls.push(pattern);
        return true;
      },
      wakeLock,
      onPhase: (info) => phaseEvents.push(info.label),
      onDone: (summary) => {
        doneSummary = summary;
      },
    });

    const started = timer.start([
      { label: "Occlusion", sec: 3, repeat: 2 },
      { label: "Repos", sec: 2 },
    ]);

    assert.equal(started, true);
    // Laisser résoudre la promesse wakeLock.request
    await Promise.resolve();

    assert.deepEqual(phaseEvents, ["Occlusion"]);
    assert.deepEqual(audioCalls, ["start"]);

    clock.advanceBy(3000);
    assert.deepEqual(phaseEvents, ["Occlusion", "Occlusion"]);
    assert.equal(timer.getSnapshot().stepIndex, 1);

    clock.advanceBy(3000);
    assert.deepEqual(phaseEvents, ["Occlusion", "Occlusion", "Repos"]);
    assert.equal(timer.getSnapshot().stepIndex, 2);

    clock.advanceBy(2000);
    assert.equal(timer.status, "done");
    assert.equal(clock.activeTimerCount(), 0);
    assert.equal(releasedCount, 1);
    assert.ok(doneSummary);
    assert.equal(doneSummary.completed, true);
    assert.equal(doneSummary.interrupted, false);
    assert.equal(doneSummary.elapsedSec, 8);
    assert.equal(audioCalls.at(-1), "done");
    assert.ok(vibrateCalls.length >= 4);
  });

  it("gère pause, reprise et skip proprement", () => {
    const clock = createFakeClock();
    const phaseEvents = [];
    let doneSummary = null;

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      audio: { play: () => {} },
      vibrate: () => true,
      wakeLock: null,
      onPhase: (info) => phaseEvents.push(info.label),
      onDone: (summary) => {
        doneSummary = summary;
      },
    });

    timer.start([
      { label: "Phase A", sec: 10 },
      { label: "Phase B", sec: 10 },
    ]);

    clock.advanceBy(4000);
    assert.equal(timer.getSnapshot().phaseRemainingSec, 6);

    assert.equal(timer.pause(), true);
    assert.equal(timer.status, "paused");
    assert.equal(clock.activeTimerCount(), 0);

    // Le temps qui s'écoule pendant la pause ne doit pas faire avancer le minuteur
    clock.advanceBy(5000);
    assert.equal(timer.getSnapshot().phaseRemainingSec, 6);
    assert.equal(timer.getSnapshot().totalElapsedSec, 4);

    assert.equal(timer.resume(), true);
    assert.equal(timer.status, "running");

    // Skip Phase A -> Phase B
    assert.equal(timer.skip(), true);
    assert.deepEqual(phaseEvents, ["Phase A", "Phase B"]);
    assert.equal(timer.getSnapshot().phaseLabel, "Phase B");
    assert.equal(timer.getSnapshot().phaseRemainingSec, 10);

    // Skip dernière phase -> termine
    assert.equal(timer.skip(), true);
    assert.equal(timer.status, "done");
    assert.equal(doneSummary.completed, true);
    assert.equal(doneSummary.skippedLast, true);
  });

  it("appelle onSafetyCheck chaque seconde et interrompt si SpO2 < seuil", () => {
    const clock = createFakeClock();
    const safetySeconds = [];
    const audioCalls = [];
    let doneSummary = null;
    let simulatedSpo2 = 94;

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      audio: { play: (kind) => audioCalls.push(kind) },
      vibrate: () => true,
      wakeLock: null,
      onSafetyCheck: (snapshot) => {
        safetySeconds.push(snapshot.totalElapsedSec);
        if (simulatedSpo2 < 85) {
          return { ok: false, reason: `SpO2 critique (${simulatedSpo2}% < 85%)` };
        }
        return true;
      },
      onDone: (summary) => {
        doneSummary = summary;
      },
    });

    timer.start([{ label: "Hypoxie IHHT", sec: 300 }]);

    // 3 secondes normales (250 ms * 12 ticks -> exactement 3 appels safetyCheck)
    clock.advanceBy(3000);
    assert.deepEqual(safetySeconds, [1, 2, 3]);
    assert.equal(timer.status, "running");

    // Chute SpO2 sous le seuil à la 4e seconde
    simulatedSpo2 = 82;
    clock.advanceBy(1000);

    assert.deepEqual(safetySeconds, [1, 2, 3, 4]);
    assert.equal(timer.status, "interrupted");
    assert.equal(clock.activeTimerCount(), 0);
    assert.equal(audioCalls.at(-1), "alert");
    assert.ok(doneSummary);
    assert.equal(doneSummary.completed, false);
    assert.equal(doneSummary.interrupted, true);
    assert.match(doneSummary.reason, /SpO2 critique/);
  });

  it("respecte le mode muet et désactivation des vibrations", () => {
    const clock = createFakeClock();
    const audioCalls = [];
    const vibrateCalls = [];

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      muted: true,
      vibrateEnabled: false,
      audio: { play: (kind) => audioCalls.push(kind) },
      vibrate: (p) => {
        vibrateCalls.push(p);
        return true;
      },
      wakeLock: null,
    });

    timer.start([{ label: "Unique", sec: 2 }]);
    clock.advanceBy(2000);

    assert.equal(timer.status, "done");
    assert.equal(audioCalls.length, 0);
    assert.equal(vibrateCalls.length, 0);
  });

  it("interrompt avec safety_check_error si onSafetyCheck asynchrone rejette", async () => {
    const clock = createFakeClock();
    let doneSummary = null;

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      audio: { play: () => {} },
      vibrate: () => true,
      wakeLock: null,
      onSafetyCheck: () => Promise.reject(new Error("Sensor disconnected")),
      onDone: (summary) => {
        doneSummary = summary;
      },
    });

    timer.start([{ label: "IHHT", sec: 60 }]);
    clock.advanceBy(1000);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(timer.status, "interrupted");
    assert.ok(doneSummary);
    assert.equal(doneSummary.interrupted, true);
    assert.equal(doneSummary.reason, "safety_check_error");
  });

  it("déclenche le watchdog SpO2 après > 60 s en phase hypoxique, bloque resume() et reprend après mesure valide >= seuil", () => {
    const clock = createFakeClock(2_000_000);
    const audioCalls = [];
    const vibrateCalls = [];
    const alerts = [];

    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      spo2MaxAgeMs: 60_000,
      spo2ThresholdPct: 85,
      audio: { play: (kind) => audioCalls.push(kind) },
      vibrate: (pattern) => {
        vibrateCalls.push(pattern);
        return true;
      },
      wakeLock: null,
      onSafetyAlert: (alert) => alerts.push(alert),
    });

    // Enregistre une mesure initiale valide à t = 2_000_000
    assert.equal(timer.recordSpo2Reading(95), true);
    assert.equal(timer.lastSpo2Value, 95);
    assert.equal(timer.lastSpo2TimestampMs, 2_000_000);

    timer.start([
      { label: "Cycle 1/2 - Hypoxie", sec: 180, meta: { isHypoxia: true, isIhht: true } },
      { label: "Cycle 1/2 - Hyperoxie", sec: 120, meta: { isHypoxia: false, isIhht: true } },
    ]);

    // À exactement 60 000 ms, la mesure n'est pas encore > 60 000 ms
    clock.advanceBy(60_000);
    assert.equal(timer.status, "running");
    assert.equal(alerts.length, 0);

    // Dès > 60 000 ms (60 250 ms), le watchdog déclenche alerte + pause spo2_stale
    clock.advanceBy(1_000);
    assert.equal(timer.status, "paused");
    assert.equal(timer.pauseReason, "spo2_stale");
    assert.equal(clock.activeTimerCount(), 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].code, "spo2_stale");
    assert.equal(audioCalls.at(-1), "alert");
    assert.ok(vibrateCalls.length >= 2);

    // Sans nouvelle mesure, resume() est bloqué
    assert.equal(timer.resume(), false);
    assert.equal(timer.status, "paused");
    assert.equal(timer.pauseReason, "spo2_stale");

    // Avec une nouvelle mesure inférieure au seuil (< 85 %), resume() reste bloqué
    assert.equal(timer.recordSpo2Reading(82), true);
    assert.equal(timer.resume(), false);
    assert.equal(timer.status, "paused");
    assert.equal(timer.pauseReason, "spo2_stale");

    // Avec une nouvelle mesure valide >= seuil (92 >= 85), resume() reprend
    assert.equal(timer.recordSpo2Reading(92), true);
    assert.equal(timer.resume(), true);
    assert.equal(timer.status, "running");
    assert.equal(timer.pauseReason, "");
    assert.ok(clock.activeTimerCount() > 0);
  });

  it("détecte les phases hypoxiques via meta.isIhht + label et épargne les phases non hypoxiques", () => {
    assert.equal(
      isPhaseHypoxic({ label: "Cycle 1/3 - Hypoxie", meta: { isIhht: true } }),
      true
    );
    assert.equal(
      isPhaseHypoxic({
        label: "Cycle 1/3 - Bascule masque : retirer hypoxie",
        meta: { isIhht: true, isHypoxia: false },
      }),
      false
    );

    const clock = createFakeClock(3_000_000);
    const alerts = [];
    const timer = new MultiPhaseTimer({
      clock,
      tickIntervalMs: 250,
      spo2MaxAgeMs: 60_000,
      audio: { play: () => {} },
      vibrate: () => true,
      wakeLock: null,
      onSafetyAlert: (a) => alerts.push(a),
    });

    timer.recordSpo2Reading(98);
    timer.start([
      {
        label: "Cycle 1/1 - Hyperoxie",
        sec: 90,
        meta: { isIhht: true, isHypoxia: false },
      },
      {
        label: "Cycle 1/1 - Hypoxie",
        sec: 120,
        meta: { isIhht: true },
      },
    ]);

    // 70 s en phase hyperoxique sans nouvelle mesure : pas de pause spo2_stale
    clock.advanceBy(70_000);
    assert.equal(timer.status, "running");
    assert.equal(alerts.length, 0);

    // Passage en phase hypoxique à 90 s : la mesure date de 90 s (> 60 s) -> pause immédiate
    clock.advanceBy(20_500);
    assert.equal(timer.status, "paused");
    assert.equal(timer.pauseReason, "spo2_stale");
    assert.equal(alerts.length, 1);
  });
});

describe("bleOximeter (Web Bluetooth optionnel non bloquant)", () => {
  it("décode IEEE-11073 SFLOAT, PLX 0x2A5F et Heart Rate 0x2A37", () => {
    // 96 = mantisse 96 (0x060), exposant 0 => 0x0060
    assert.equal(decodeSfloat16(0x0060), 96);
    // 97.5 = mantisse 975 (0x3CF), exposant -1 (0xF) => 0xF3CF
    assert.ok(Math.abs(decodeSfloat16(0xf3cf) - 97.5) < 1e-6);

    // Trame PLX : flags=0x00, SpO2=95 (0x005F LE), PR=64 (0x0040 LE)
    const plxBuf = new Uint8Array([0x00, 0x5f, 0x00, 0x40, 0x00]);
    assert.deepEqual(parsePlxMeasurement(plxBuf), { spo2: 95, hr: 64 });

    // Trame HR 0x2A37 : flags=0x00 (uint8), HR=68
    const hrBuf = new Uint8Array([0x00, 68]);
    assert.deepEqual(parseHeartRateMeasurement(hrBuf), { hr: 68 });
  });

  it("gère l'absence de navigator.bluetooth et l'annulation sans erreur bloquante", async () => {
    const unsupportedClient = createBleOximeter({ navigatorRef: {} });
    assert.equal(unsupportedClient.isSupported(), false);
    const resUnsupported = await unsupportedClient.connect();
    assert.equal(resUnsupported.ok, false);
    assert.equal(resUnsupported.reason, "unsupported");

    const cancelClient = createBleOximeter({
      navigatorRef: {
        bluetooth: {
          requestDevice: async () => {
            const err = new Error("User cancelled");
            err.name = "NotFoundError";
            throw err;
          },
        },
      },
    });
    assert.equal(cancelClient.isSupported(), true);
    const resCancelled = await cancelClient.connect();
    assert.equal(resCancelled.ok, false);
    assert.equal(resCancelled.reason, "cancelled");
  });
});
