import test from "node:test";
import assert from "node:assert/strict";
import {
  EQUIPMENT,
  EQUIPMENT_BY_ID,
  EXERCISES_BY_ID,
  PROTOCOLS_BY_ID,
} from "../catalog.js";
import {
  buildSession,
  computeRecoveryScore,
  isAllowed,
  selectProtocol,
} from "../engine.js";

const ALL_EQUIPMENT = new Set(EQUIPMENT.map((e) => e.id));

function makeBaseCtx(overrides = {}) {
  return {
    userContraindications: new Set(),
    equipmentAvailable: new Set(ALL_EQUIPMENT),
    todayActivities: [],
    now: new Date(2026, 10, 25, 14, 0, 0),
    kaatsuSupervisedOnce: true,
    spo2ThresholdPct: 82,
    ...overrides,
  };
}

// =============================================================================
// 1. computeRecoveryScore
// =============================================================================

test("computeRecoveryScore : bonne recuperation avec z-score ln(rMSSD) positif", () => {
  const res = computeRecoveryScore({
    hrvToday: 85,
    hrvHistory7d: [60, 62, 58, 64, 61, 59, 63],
    sleepHours: 8,
    sleepScore: 88,
    tsb: 10,
  });

  assert.equal(res.level, "good");
  assert.ok(res.score >= 70 && res.score <= 100);
  assert.ok(res.parts.hrv.zScore > 2);
  assert.equal(res.parts.hrv.samples, 7);
  assert.ok(Math.abs(res.parts.hrv.lnToday - Math.log(85)) < 1e-3);
});

test("computeRecoveryScore : recuperation basse (HRV chute + mauvais sommeil + TSB negatif)", () => {
  const res = computeRecoveryScore({
    hrvToday: 35,
    hrvHistory7d: [65, 68, 62, 70, 64, 66, 67],
    sleepHours: 4.5,
    sleepScore: 35,
    tsb: -25,
  });

  assert.equal(res.level, "low");
  assert.ok(res.score >= 0 && res.score < 45);
  assert.ok(res.parts.hrv.zScore < -2);
});

test("computeRecoveryScore : tolere historique HRV vide, 1 valeur, constant ou objet vide", () => {
  const emptyHist = computeRecoveryScore({
    hrvToday: 60,
    hrvHistory7d: [],
    sleepHours: 7,
    tsb: 0,
  });
  assert.equal(Number.isFinite(emptyHist.score), true);
  assert.equal(emptyHist.parts.hrv.zScore, null);
  assert.equal(emptyHist.parts.hrv.samples, 0);

  const singleHist = computeRecoveryScore({
    hrvToday: 60,
    hrvHistory7d: [62],
    sleepHours: 7,
  });
  assert.equal(Number.isFinite(singleHist.score), true);
  assert.equal(singleHist.parts.hrv.zScore, null);

  const constHist = computeRecoveryScore({
    hrvToday: 60,
    hrvHistory7d: [60, 60, 60, 60],
  });
  assert.equal(constHist.parts.hrv.zScore, 0);
  assert.equal(Number.isFinite(constHist.score), true);

  const allMissing = computeRecoveryScore({});
  assert.equal(allMissing.score, 50);
  assert.equal(allMissing.level, "moderate");
});

// =============================================================================
// 2. isAllowed — interdits durs & cas limites
// =============================================================================

test("isAllowed : interdit dur sur contre-indication utilisateur", () => {
  const ctx = makeBaseCtx({
    userContraindications: new Set(["tvp_history"]),
  });
  const res = isAllowed(EXERCISES_BY_ID.kaatsu_cycle_legs_progressive, ctx);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes("contraindication:tvp_history"));
});

test("isAllowed : interdit dur sur materiel manquant", () => {
  const eqWithoutSauna = new Set(ALL_EQUIPMENT);
  eqWithoutSauna.delete("sauna");
  const ctx = makeBaseCtx({ equipmentAvailable: eqWithoutSauna });

  const res = isAllowed(EXERCISES_BY_ID.thermal_sauna_endurance, ctx);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes("missing_equipment:sauna"));
});

test("isAllowed : interdit froid < 4h apres musculation et autorise a 4h pile", () => {
  const now = new Date(2026, 10, 25, 16, 0, 0);
  const coldEx = EXERCISES_BY_ID.thermal_cold_plunge_full;

  // 3h59m apres fin de strength -> bloque
  const lt4hCtx = makeBaseCtx({
    now,
    todayActivities: [
      {
        type: "strength",
        endTime: new Date(now.getTime() - (4 * 3600 * 1000 - 60 * 1000)),
      },
    ],
  });
  const blocked = isAllowed(coldEx, lt4hCtx);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.reasons.includes("strength_lt_4h"));

  // 4h00 pile apres fin de strength -> autorise
  const exact4hCtx = makeBaseCtx({
    now,
    todayActivities: [
      {
        type: "strength",
        endTime: new Date(now.getTime() - 4 * 3600 * 1000),
      },
    ],
  });
  const allowed = isAllowed(coldEx, exact4hCtx);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.reasons, []);

  // Séance strength avec endTime invalide ou manquant -> fail-closed (bloque le froid)
  const invalidEndCtx = makeBaseCtx({
    now,
    todayActivities: [{ type: "strength", endTime: "not-a-date" }],
  });
  const blockedInvalid = isAllowed(coldEx, invalidEndCtx);
  assert.equal(blockedInvalid.ok, false);
  assert.ok(blockedInvalid.reasons.includes("strength_lt_4h"));
});

test("isAllowed : interdit KAATSU si !kaatsuSupervisedOnce", () => {
  const ctx = makeBaseCtx({ kaatsuSupervisedOnce: false });
  const res = isAllowed(EXERCISES_BY_ID.kaatsu_walk_light, ctx);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes("first_kaatsu_unsupervised"));
});

test("isAllowed : interdit IHHT si pas d'oximeter et verifie seuil SpO2", () => {
  const eqNoOximeter = new Set(ALL_EQUIPMENT);
  eqNoOximeter.delete("oximeter");
  const ctx = makeBaseCtx({ equipmentAvailable: eqNoOximeter });

  const ihhtRes = isAllowed(EXERCISES_BY_ID.ihht_standard_5_3, ctx);
  assert.equal(ihhtRes.ok, false);
  assert.ok(ihhtRes.reasons.includes("missing_oximeter"));

  // Sans generateur hypoxique mais avec oxymetre : hyperoxie seule autorisee, IHHT bloque
  const eqNoHypoxia = new Set(ALL_EQUIPMENT);
  eqNoHypoxia.delete("hypoxia_gen");
  const ctxNoHypoxia = makeBaseCtx({ equipmentAvailable: eqNoHypoxia });
  assert.equal(isAllowed(EXERCISES_BY_ID.ihht_standard_5_3, ctxNoHypoxia).ok, false);
  assert.equal(isAllowed(EXERCISES_BY_ID.hyperoxia_post_hiit_15, ctxNoHypoxia).ok, true);

  // Seuil SpO2 < 80% dangereux sur IHHT
  const unsafeSpo2Ctx = makeBaseCtx({ spo2ThresholdPct: 78 });
  const unsafeRes = isAllowed(EXERCISES_BY_ID.ihht_standard_5_3, unsafeSpo2Ctx);
  assert.equal(unsafeRes.ok, false);
  assert.ok(unsafeRes.reasons.includes("unsafe_spo2_threshold"));
});

// =============================================================================
// 3. selectProtocol — regles de priorite
// =============================================================================

test("selectProtocol : respecte l'ordre de priorite complet", () => {
  const afternoon = new Date(2026, 10, 25, 15, 0, 0);
  const evening = new Date(2026, 10, 25, 20, 30, 0);
  const beforeEvening = new Date(2026, 10, 25, 19, 59, 0);

  // 1. strength aujourd'hui prime sur tout
  assert.equal(
    selectProtocol(
      {
        now: evening,
        todayActivities: [
          { type: "ride", intense: true },
          { type: "strength", endTime: afternoon },
        ],
      },
      { score: 30, level: "low" },
    ),
    "post_muscu_sans_froid",
  );

  // 2. ride intense
  assert.equal(
    selectProtocol(
      {
        now: evening,
        todayActivities: [{ type: "ride", intense: true }],
      },
      { score: 30, level: "low" },
    ),
    "post_hiit_velo",
  );

  // ride douce ne declenche pas post_hiit_velo
  assert.equal(
    selectProtocol(
      {
        now: afternoon,
        todayActivities: [{ type: "ride", intense: false }],
      },
      { score: 80, level: "good" },
    ),
    "repos_actif",
  );

  // 3. score low -> hrv_basse
  assert.equal(
    selectProtocol({ now: evening, todayActivities: [] }, { score: 40, level: "low" }),
    "hrv_basse",
  );

  // 4. soir >= 20h -> soir_sommeil
  assert.equal(
    selectProtocol({ now: evening, todayActivities: [] }, { score: 75, level: "good" }),
    "soir_sommeil",
  );

  // 5. avant 20h sans autre declencheur -> repos_actif
  assert.equal(
    selectProtocol(
      { now: beforeEvening, todayActivities: [] },
      { score: 75, level: "good" },
    ),
    "repos_actif",
  );
});

// =============================================================================
// 4. buildSession — filtrage, substitution meme famille, troncature & plafonds KAATSU
// =============================================================================

test("buildSession : filtre et remplace un exercice interdit par la meme famille si possible", () => {
  const now = new Date(2026, 10, 25, 16, 0, 0);
  // post_hiit_velo contient thermal_cold_plunge_legs, bloque par strength < 4h
  const ctx = makeBaseCtx({
    now,
    todayActivities: [
      { type: "strength", endTime: new Date(now.getTime() - 2 * 3600 * 1000) },
    ],
  });

  const session = buildSession("post_hiit_velo", ctx);

  assert.ok(
    session.removed.some(
      (r) => r.id === "thermal_cold_plunge_legs" && r.reasons.includes("strength_lt_4h"),
    ),
  );
  // Remplacement dans la famille thermal (ex: sauna autorise sans conflit strength_lt_4h)
  const replacement = session.items.find(
    (item) => item.replacedFrom === "thermal_cold_plunge_legs",
  );
  assert.ok(replacement, "Un remplacant de famille thermal doit etre propose");
  assert.equal(replacement.family, "thermal");
  assert.equal(
    session.items.some((i) => i.id === "thermal_cold_plunge_legs"),
    false,
  );
});

test("buildSession : supprime sans remplacement si toute la famille est contre-indiquee", () => {
  const ctx = makeBaseCtx({
    userContraindications: new Set(["tvp_history"]),
  });
  // post_muscu_sans_froid contient kaatsu_cycle_legs_recovery_soft
  const session = buildSession("post_muscu_sans_froid", ctx);

  assert.ok(
    session.removed.some(
      (r) =>
        r.id === "kaatsu_cycle_legs_recovery_soft" &&
        r.reasons.includes("contraindication:tvp_history"),
    ),
  );
  assert.equal(
    session.items.some((i) => i.family === "kaatsu"),
    false,
  );
});

test("buildSession : tronque la seance a maxMinutes", () => {
  const ctx = makeBaseCtx();
  const session = buildSession("repos_actif", ctx, { maxMinutes: 15 });

  assert.ok(session.totalSec <= 15 * 60);
  assert.ok(session.items.length > 0);
  const sumItems = session.items.reduce((acc, item) => acc + item.durationSec, 0);
  assert.equal(session.totalSec, sumItems);
  assert.ok(
    session.removed.some((r) => r.reasons.includes("max_minutes_exceeded")),
  );
});

test("buildSession : respecte les plafonds KAATSU (maxContinuousMin) du catalogue", () => {
  const ctx = makeBaseCtx();
  const armsMaxSec =
    EQUIPMENT_BY_ID.kaatsu_bands.safetyLimits.arms.maxContinuousMin * 60;

  // Protocole synthetique cumulant 3 exercices KAATSU bras (> 15 min)
  const protoArmsOverflow = {
    id: "test_kaatsu_arms_overflow",
    exerciseIds: [
      "kaatsu_cycle_arms_recovery_soft", // 435 s
      "kaatsu_cycle_arms_recovery_soft", // 435 s -> 870 s <= 900 s
      "kaatsu_cycle_arms_progressive", // 355 s -> 1225 s > 900 s (doit etre bloque)
    ],
  };

  const session = buildSession(protoArmsOverflow, ctx);
  const kaatsuTotalSec = session.items
    .filter((i) => i.family === "kaatsu")
    .reduce((acc, i) => acc + i.durationSec, 0);

  assert.ok(kaatsuTotalSec <= armsMaxSec);
  assert.ok(
    session.removed.some(
      (r) =>
        r.id === "kaatsu_cycle_arms_progressive" &&
        r.reasons.includes("kaatsu_max_continuous_exceeded"),
    ),
  );

  // Verification sur tous les protocoles du catalogue
  for (const protoId of Object.keys(PROTOCOLS_BY_ID)) {
    const s = buildSession(protoId, ctx);
    const totalKaatsu = s.items
      .filter((i) => i.family === "kaatsu")
      .reduce((acc, i) => acc + i.durationSec, 0);
    assert.ok(totalKaatsu <= 20 * 60);
  }
});

test("buildSession : leve une erreur sur un protocolId inconnu", () => {
  assert.throws(
    () => buildSession("protocole_inexistant", makeBaseCtx()),
    /Protocole inconnu/,
  );
});
