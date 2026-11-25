import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRAINDICATIONS,
  EQUIPMENT,
  EQUIPMENT_BY_ID,
  PROTOCOLS,
} from "../catalog.js";
import { buildSession, computeRecoveryScore } from "../engine.js";

const ITERATIONS = 2000;
const BASE_SEED = Number.parseInt(process.env.PROP_SEED ?? "", 10) || 0x5eed2026;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const ALL_PROTOCOL_IDS = PROTOCOLS.map((p) => p.id);
const ALL_CONTRA_IDS = CONTRAINDICATIONS.map((c) => c.id);
const ALL_EQUIPMENT_IDS = EQUIPMENT.map((e) => e.id);
const ARMS_ZONES = new Set(["arms", "biceps", "triceps", "forearms", "vascular_upper"]);

/**
 * Générateur pseudo-aléatoire déterministe Mulberry32.
 * @param {number} seed
 */
function createRng(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    bool(p = 0.5) {
      return next() < p;
    },
    int(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    subset(arr, prob = 0.35) {
      return arr.filter(() => next() < prob);
    },
  };
}

function toSet(value) {
  if (value instanceof Set) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Set(value);
  }
  return new Set();
}

function toMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return Number.NaN;
}

function isKaatsuItem(item) {
  const conflicts = Array.isArray(item.conflicts) ? item.conflicts : [];
  const equipment = Array.isArray(item.equipment) ? item.equipment : [];
  return (
    item.family === "kaatsu" ||
    conflicts.includes("first_kaatsu_unsupervised") ||
    equipment.includes("kaatsu_bands")
  );
}

function getKaatsuLimb(item) {
  const zones = Array.isArray(item.zones) ? item.zones : [];
  const id = typeof item.id === "string" ? item.id : "";
  return id.includes("arms") || zones.some((z) => ARMS_ZONES.has(z)) ? "arms" : "legs";
}

function isColdOrContrastItem(item) {
  const conflicts = Array.isArray(item.conflicts) ? item.conflicts : [];
  const equipment = Array.isArray(item.equipment) ? item.equipment : [];
  return conflicts.includes("strength_lt_4h") || equipment.includes("cold_plunge");
}

function generateSessionInputs(rng) {
  const protocolId = rng.pick(ALL_PROTOCOL_IDS);
  const baseNowMs = Date.UTC(2026, 10, 25, rng.int(6, 23), rng.int(0, 59), 0);

  const nowFormatRoll = rng.next();
  let now = new Date(baseNowMs);
  if (nowFormatRoll < 0.2) {
    now = baseNowMs;
  } else if (nowFormatRoll < 0.35) {
    now = new Date(baseNowMs).toISOString();
  }

  const contraList = rng.subset(ALL_CONTRA_IDS, rng.float(0, 0.5));
  const equipProb = rng.bool(0.25) ? 0.95 : rng.float(0.1, 0.85);
  const equipList = rng.subset(ALL_EQUIPMENT_IDS, equipProb);

  const actCount = rng.int(0, 4);
  const activityTypes = ["strength", "STRENGTH", "ride", "ride_intense", "run", "mobility"];
  const todayActivities = [];
  for (let i = 0; i < actCount; i++) {
    const type = rng.pick(activityTypes);
    // Fenêtre autour de 4h avant now (-8h à +1h) pour stresser la frontière 4h
    const offsetMs = rng.int(-8 * 3600 * 1000, 3600 * 1000);
    const endMs = baseNowMs + offsetMs;
    const endTime = rng.bool(0.5) ? new Date(endMs) : rng.bool(0.5) ? endMs : new Date(endMs).toISOString();
    todayActivities.push({
      type,
      endTime,
      rpe: rng.int(3, 10),
    });
  }

  const ctx = {
    userContraindications: rng.bool(0.5) ? new Set(contraList) : contraList,
    equipmentAvailable: rng.bool(0.5) ? new Set(equipList) : equipList,
    todayActivities,
    now,
    kaatsuSupervisedOnce: rng.bool(0.5),
    spo2ThresholdPct: rng.bool(0.2) ? rng.int(72, 79) : rng.int(80, 90),
  };

  const maxMinutes = rng.bool(0.1) ? 0 : rng.bool(0.2) ? rng.float(1, 30) : rng.int(5, 90);
  return { protocolId, ctx, options: { maxMinutes } };
}

function runProperty(propIndex, name, fn) {
  const propSeed = (BASE_SEED + propIndex * 7919) >>> 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const iterSeed = (propSeed + i * 104729) >>> 0;
    const rng = createRng(iterSeed);
    try {
      fn(rng, i, iterSeed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.fail(
        `[${name}] Echec iteration=${i} (propSeed=${propSeed}, iterSeed=${iterSeed}): ${msg}`,
      );
    }
  }
}

test("Propriete 1 (2000 runs) : aucune contre-indication utilisateur dans les items retenus", () => {
  runProperty(1, "Prop1-Contraindications", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);
    const userContras = toSet(ctx.userContraindications);

    for (const item of session.items) {
      const itemContras = Array.isArray(item.contraindications) ? item.contraindications : [];
      for (const ci of itemContras) {
        assert.equal(
          userContras.has(ci),
          false,
          `Item ${item.id} porte la contre-indication ${ci} presente dans ctx`,
        );
      }
    }
  });
});

test("Propriete 2 (2000 runs) : aucun item froid/contraste si strength < 4h avant now", () => {
  runProperty(2, "Prop2-ColdAfterStrength", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);
    const nowMs = toMs(ctx.now);

    const hasRecentStrength = ctx.todayActivities.some((act) => {
      if (!act || String(act.type ?? "").toLowerCase() !== "strength") {
        return false;
      }
      const endMs = toMs(act.endTime);
      if (!Number.isFinite(endMs)) {
        return false;
      }
      const elapsed = nowMs - endMs;
      return elapsed >= 0 && elapsed < FOUR_HOURS_MS;
    });

    if (hasRecentStrength) {
      for (const item of session.items) {
        assert.equal(
          isColdOrContrastItem(item),
          false,
          `Item froid/contraste ${item.id} inclus malgre strength < 4h`,
        );
      }
    }
  });
});

test("Propriete 3 (2000 runs) : KAATSU interdit si !kaatsuSupervisedOnce et plafonds catalogue respectes", () => {
  const armsMaxSec = (EQUIPMENT_BY_ID.kaatsu_bands?.safetyLimits?.arms?.maxContinuousMin ?? 15) * 60;
  const legsMaxSec = (EQUIPMENT_BY_ID.kaatsu_bands?.safetyLimits?.legs?.maxContinuousMin ?? 20) * 60;
  const cycleMaxSec = (EQUIPMENT_BY_ID.kaatsu_cycle_20?.safetyLimits?.maxSessionMin ?? 20) * 60;

  runProperty(3, "Prop3-KaatsuSafety", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);

    let armsSec = 0;
    let legsSec = 0;
    let totalKaatsuSec = 0;

    for (const item of session.items) {
      if (!isKaatsuItem(item)) {
        continue;
      }
      assert.equal(
        Boolean(ctx.kaatsuSupervisedOnce),
        true,
        `Item KAATSU ${item.id} inclus sans kaatsuSupervisedOnce`,
      );
      const limb = getKaatsuLimb(item);
      if (limb === "arms") {
        armsSec += item.durationSec;
      } else {
        legsSec += item.durationSec;
      }
      totalKaatsuSec += item.durationSec;
    }

    assert.ok(armsSec <= armsMaxSec, `Duree KAATSU bras ${armsSec}s > plafond ${armsMaxSec}s`);
    assert.ok(legsSec <= legsMaxSec, `Duree KAATSU jambes ${legsSec}s > plafond ${legsMaxSec}s`);
    assert.ok(
      totalKaatsuSec <= cycleMaxSec,
      `Duree totale KAATSU ${totalKaatsuSec}s > plafond Cycle 2.0 ${cycleMaxSec}s`,
    );
  });
});

test("Propriete 4 (2000 runs) : aucun item hyperoxia_ihht sans oximeter dans equipmentAvailable", () => {
  runProperty(4, "Prop4-HyperoxiaIhhtOximeter", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);
    const equipSet = toSet(ctx.equipmentAvailable);

    if (!equipSet.has("oximeter")) {
      for (const item of session.items) {
        assert.notEqual(
          item.family,
          "hyperoxia_ihht",
          `Item hyperoxia_ihht ${item.id} inclus sans oximeter`,
        );
      }
    }
  });
});

test("Propriete 5 (2000 runs) : tout equipement requis par un item est disponible", () => {
  runProperty(5, "Prop5-RequiredEquipment", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);
    const equipSet = toSet(ctx.equipmentAvailable);

    for (const item of session.items) {
      const reqEquip = Array.isArray(item.equipment) ? item.equipment : [];
      for (const eq of reqEquip) {
        assert.equal(
          equipSet.has(eq),
          true,
          `Item ${item.id} requiert ${eq} absent de equipmentAvailable`,
        );
      }
    }
  });
});

test("Propriete 6 (2000 runs) : totalSec <= maxMinutes*60 et egal a la somme des items", () => {
  runProperty(6, "Prop6-DurationBounds", (rng) => {
    const { protocolId, ctx, options } = generateSessionInputs(rng);
    const session = buildSession(protocolId, ctx, options);
    const sumSec = session.items.reduce((acc, item) => acc + item.durationSec, 0);

    assert.equal(
      session.totalSec,
      sumSec,
      `totalSec=${session.totalSec} != somme items=${sumSec}`,
    );
    assert.ok(
      session.totalSec <= options.maxMinutes * 60,
      `totalSec=${session.totalSec} > maxMinutes*60=${options.maxMinutes * 60}`,
    );
  });
});

test("Propriete 7 (2000 runs) : computeRecoveryScore toujours dans [0,100] et sans NaN sur entrees extremes", () => {
  const weirdValues = [
    null,
    undefined,
    0,
    -0,
    -1,
    -100,
    -999999,
    1e-9,
    1,
    50,
    100,
    500,
    1e9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "",
    "50",
    {},
    [],
  ];

  function randomScalar(rng) {
    if (rng.bool(0.6)) {
      return rng.pick(weirdValues);
    }
    return rng.float(-200, 250);
  }

  function randomHistory(rng) {
    const roll = rng.next();
    if (roll < 0.15) return null;
    if (roll < 0.25) return undefined;
    if (roll < 0.4) return [];
    if (roll < 0.5) return "not-an-array";
    const len = rng.int(0, 12);
    const arr = [];
    for (let i = 0; i < len; i++) {
      arr.push(randomScalar(rng));
    }
    return arr;
  }

  runProperty(7, "Prop7-ComputeRecoveryScore", (rng) => {
    const input = rng.bool(0.08)
      ? null
      : rng.bool(0.05)
        ? undefined
        : {
            hrvToday: randomScalar(rng),
            hrvHistory7d: randomHistory(rng),
            sleepHours: randomScalar(rng),
            sleepScore: randomScalar(rng),
            tsb: randomScalar(rng),
          };

    const res = computeRecoveryScore(input);
    assert.equal(typeof res.score, "number", `score non numerique: ${res.score}`);
    assert.equal(Number.isNaN(res.score), false, `score NaN pour input=${JSON.stringify(input)}`);
    assert.equal(Number.isFinite(res.score), true, `score non fini: ${res.score}`);
    assert.ok(
      res.score >= 0 && res.score <= 100,
      `score hors [0,100]: ${res.score} pour input=${JSON.stringify(input)}`,
    );
  });
});
