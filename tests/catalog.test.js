import test from "node:test";
import assert from "node:assert/strict";
import {
  EQUIPMENT,
  EXERCISES,
  PROTOCOLS,
  CONTRAINDICATIONS,
  FAMILIES,
} from "../catalog.js";

test("exports principaux presents et immuables", () => {
  assert.ok(Array.isArray(EQUIPMENT) && EQUIPMENT.length >= 14);
  assert.ok(Array.isArray(EXERCISES) && EXERCISES.length >= 55);
  assert.equal(PROTOCOLS.length, 8);
  assert.ok(Array.isArray(CONTRAINDICATIONS) && CONTRAINDICATIONS.length >= 10);

  assert.equal(Object.isFrozen(EQUIPMENT), true);
  assert.equal(Object.isFrozen(EXERCISES), true);
  assert.equal(Object.isFrozen(PROTOCOLS), true);
  assert.equal(Object.isFrozen(CONTRAINDICATIONS), true);
  assert.equal(Object.isFrozen(EXERCISES[0]), true);
  assert.equal(Object.isFrozen(EXERCISES[0].phases), true);
});

test("identifiants uniques dans toutes les collections", () => {
  for (const [label, list] of [
    ["EQUIPMENT", EQUIPMENT],
    ["EXERCISES", EXERCISES],
    ["PROTOCOLS", PROTOCOLS],
    ["CONTRAINDICATIONS", CONTRAINDICATIONS],
  ]) {
    const ids = list.map((item) => item.id);
    const unique = new Set(ids);
    assert.equal(
      unique.size,
      ids.length,
      `Doublon d'id detecte dans ${label}`,
    );
    for (const id of ids) {
      assert.equal(typeof id, "string");
      assert.ok(id.length > 0);
    }
  }
});

test("schema strict des exercices et coherence des durees de phases", () => {
  const validFamilies = new Set(FAMILIES);
  const validIntensities = new Set(["very_low", "low", "moderate", "high"]);

  for (const ex of EXERCISES) {
    assert.equal(typeof ex.id, "string");
    assert.equal(typeof ex.name, "string");
    assert.ok(ex.name.length > 3);
    assert.ok(validFamilies.has(ex.family), `Famille invalide pour ${ex.id}: ${ex.family}`);
    assert.ok(Array.isArray(ex.equipment), `equipment doit etre un tableau (${ex.id})`);
    assert.ok(Array.isArray(ex.zones) && ex.zones.length > 0, `zones requis (${ex.id})`);
    assert.equal(typeof ex.durationSec, "number");
    assert.ok(ex.durationSec > 0, `durationSec > 0 requis (${ex.id})`);
    assert.ok(Array.isArray(ex.phases) && ex.phases.length > 0, `phases requis (${ex.id})`);
    assert.ok(validIntensities.has(ex.intensity), `intensity invalide (${ex.id})`);
    assert.ok(Array.isArray(ex.contraindications), `contraindications requis (${ex.id})`);
    assert.ok(Array.isArray(ex.conflicts), `conflicts requis (${ex.id})`);
    assert.equal(typeof ex.svg, "string");
    assert.ok(ex.svg.length > 0, `svg requis (${ex.id})`);
    assert.ok(Array.isArray(ex.cues) && ex.cues.length > 0, `cues requis (${ex.id})`);

    let computedSec = 0;
    for (const phase of ex.phases) {
      assert.equal(typeof phase.label, "string");
      assert.ok(phase.label.length > 0);
      assert.equal(typeof phase.sec, "number");
      assert.ok(phase.sec > 0);
      if (phase.repeat !== undefined) {
        assert.ok(Number.isInteger(phase.repeat) && phase.repeat > 0);
      }
      computedSec += phase.sec * (phase.repeat ?? 1);
    }
    assert.equal(
      computedSec,
      ex.durationSec,
      `Somme des phases (${computedSec}s) != durationSec (${ex.durationSec}s) pour ${ex.id}`,
    );
  }
});

test("tous les equipements et contre-indications references existent", () => {
  const equipmentIds = new Set(EQUIPMENT.map((e) => e.id));
  const contraIds = new Set(CONTRAINDICATIONS.map((c) => c.id));

  for (const reqEq of [
    "kaatsu_bands",
    "kaatsu_cycle_20",
    "hyperoxia_gen",
    "hypoxia_gen",
    "oximeter",
    "bolster_jacquier",
    "foam_roller",
    "massage_ball",
    "massage_gun",
    "stretch_strap",
    "resistance_bands",
    "sauna",
    "cold_plunge",
    "compression_boots",
  ]) {
    assert.ok(equipmentIds.has(reqEq), `Equipement manquant: ${reqEq}`);
  }

  for (const ex of EXERCISES) {
    for (const eq of ex.equipment) {
      assert.ok(equipmentIds.has(eq), `Equipement inconnu '${eq}' dans ${ex.id}`);
    }
    for (const ci of ex.contraindications) {
      assert.ok(contraIds.has(ci), `Contre-indication inconnue '${ci}' dans ${ex.id}`);
    }
  }
});

test("les 8 protocoles referencent des exercices existants et ont des durees exactes", () => {
  const expectedProtocols = [
    "post_hiit_velo",
    "post_muscu_sans_froid",
    "repos_actif",
    "hrv_basse",
    "veille_competition",
    "soir_sommeil",
    "cheville",
    "decompression_dorsale",
  ];
  const protocolIds = new Set(PROTOCOLS.map((p) => p.id));
  for (const id of expectedProtocols) {
    assert.ok(protocolIds.has(id), `Protocole manquant: ${id}`);
  }

  const exerciseById = new Map(EXERCISES.map((e) => [e.id, e]));
  for (const proto of PROTOCOLS) {
    assert.equal(typeof proto.reference, "string");
    assert.ok(proto.reference.length > 5);
    assert.ok(Array.isArray(proto.exerciseIds) && proto.exerciseIds.length > 0);
    let total = 0;
    for (const exId of proto.exerciseIds) {
      const ex = exerciseById.get(exId);
      assert.ok(ex, `Exercice inexistant '${exId}' dans protocole '${proto.id}'`);
      total += ex.durationSec;
    }
    assert.equal(
      proto.estimatedDurationSec,
      total,
      `estimatedDurationSec invalide pour ${proto.id}`,
    );
  }
});

test("regles de securite encodees : KAATSU, IHHT, froid post-muscu, sauna, webbreath", () => {
  const exerciseById = new Map(EXERCISES.map((e) => [e.id, e]));

  // KAATSU : contre-indications obligatoires + plafonds SKU bras/jambes
  const kaatsuExs = EXERCISES.filter((e) => e.family === "kaatsu");
  assert.ok(kaatsuExs.length >= 4);
  for (const ex of kaatsuExs) {
    for (const reqCi of [
      "tvp_history",
      "uncontrolled_hypertension",
      "pregnancy",
      "severe_varicose_veins",
    ]) {
      assert.ok(
        ex.contraindications.includes(reqCi),
        `${ex.id} doit inclure la contre-indication ${reqCi}`,
      );
    }
    assert.ok(ex.equipment.includes("kaatsu_bands"));
    assert.ok(ex.equipment.includes("kaatsu_cycle_20"));
  }
  const kaatsuBands = EQUIPMENT.find((e) => e.id === "kaatsu_bands");
  assert.ok(kaatsuBands.safetyLimits.arms.maxSku <= 220);
  assert.ok(kaatsuBands.safetyLimits.legs.maxSku <= 350);

  // IHHT : deux appareils separes + oxymetre + phase de bascule
  const ihhtExs = EXERCISES.filter((e) => e.id.startsWith("ihht_"));
  assert.ok(ihhtExs.length >= 2);
  for (const ex of ihhtExs) {
    assert.ok(ex.equipment.includes("hypoxia_gen"));
    assert.ok(ex.equipment.includes("hyperoxia_gen"));
    assert.ok(ex.equipment.includes("oximeter"));
    assert.ok(
      ex.phases.some((p) => p.label.toLowerCase().includes("bascule")),
      `${ex.id} doit comporter une phase de bascule des masques`,
    );
  }

  // Froid : conflit < 4h post-muscu + protocole post_muscu_sans_froid sans froid
  const coldExs = EXERCISES.filter((e) => e.equipment.includes("cold_plunge"));
  assert.ok(coldExs.length >= 2);
  for (const ex of coldExs) {
    assert.ok(
      ex.conflicts.includes("strength_lt_4h"),
      `${ex.id} doit declarer le conflit strength_lt_4h`,
    );
  }
  const postMuscu = PROTOCOLS.find((p) => p.id === "post_muscu_sans_froid");
  for (const exId of postMuscu.exerciseIds) {
    const ex = exerciseById.get(exId);
    assert.equal(ex.equipment.includes("cold_plunge"), false);
    assert.equal(ex.conflicts.includes("strength_lt_4h"), false);
  }

  // Sauna : contre-indications obligatoires
  const saunaExs = EXERCISES.filter((e) => e.equipment.includes("sauna"));
  assert.ok(saunaExs.length >= 2);
  for (const ex of saunaExs) {
    assert.ok(ex.contraindications.includes("uncontrolled_hypertension"));
    assert.ok(ex.contraindications.includes("cardiac_instability"));
  }

  // Breath : deep link webbreath
  const breathExs = EXERCISES.filter((e) => e.family === "breath");
  assert.ok(breathExs.length >= 3);
  for (const ex of breathExs) {
    assert.ok(
      typeof ex.deepLink === "string" && ex.deepLink.includes("webbreath"),
      `${ex.id} doit contenir un deepLink vers webbreath`,
    );
  }
});

test("KAATSU : plafonds SKU <= 250 (bras) / <= 400 (jambes) et aucune association Patterson 2019 <-> SKU", () => {
  const kaatsuBands = EQUIPMENT.find((e) => e.id === "kaatsu_bands");
  assert.ok(kaatsuBands);
  assert.ok(kaatsuBands.safetyLimits.arms.maxSku <= 250);
  assert.ok(kaatsuBands.safetyLimits.arms.optimalSkuRange[1] <= 250);
  assert.equal(kaatsuBands.safetyLimits.arms.firstSessionSupervised, true);
  assert.ok(kaatsuBands.safetyLimits.legs.maxSku <= 400);
  assert.ok(kaatsuBands.safetyLimits.legs.optimalSkuRange[1] <= 400);
  assert.equal(kaatsuBands.safetyLimits.legs.firstSessionSupervised, true);

  // Aucune association Patterson 2019 aux unites SKU dans EQUIPMENT ou CONTRAINDICATIONS
  assert.equal(/patterson/i.test(kaatsuBands.safetyLimits.reference), false);
  const kaatsuBox = EQUIPMENT.find((e) => e.id === "kaatsu_cycle_20");
  assert.equal(/patterson/i.test(kaatsuBox.safetyLimits.reference), false);

  for (const ci of CONTRAINDICATIONS) {
    if (/patterson/i.test(ci.reference ?? "")) {
      assert.ok(
        /%LOP|mmHg/i.test(ci.reference) && /jamais en unites SKU|distinctes des unites/i.test(ci.reference),
        `La citation Patterson dans CONTRAINDICATIONS.${ci.id} doit preciser %LOP/mmHg et exclure SKU`,
      );
    }
  }
  for (const eq of EQUIPMENT) {
    const refs = [eq.safetyLimits?.reference, eq.safetyLimits?.bfrReference].filter(Boolean);
    for (const ref of refs) {
      if (/patterson/i.test(ref)) {
        assert.ok(
          /%LOP|mmHg/i.test(ref) && /jamais en unites SKU/i.test(ref),
          `La citation Patterson dans EQUIPMENT.${eq.id} doit preciser %LOP/mmHg et exclure SKU`,
        );
      }
    }
  }

  const kaatsuExs = EXERCISES.filter((e) => e.family === "kaatsu");
  for (const ex of kaatsuExs) {
    assert.ok(ex.conflicts.includes("first_kaatsu_unsupervised"), `${ex.id} doit exiger supervision initiale`);
    const isArms = ex.id.includes("arms") || ex.zones.includes("arms") || ex.zones.includes("biceps");
    const limit = isArms ? 250 : 400;
    const texts = [ex.name, ...ex.phases.map((p) => p.label), ...ex.cues];
    for (const txt of texts) {
      for (const match of txt.matchAll(/(\d+)\s*SKU/gi)) {
        const val = Number.parseInt(match[1], 10);
        assert.ok(
          val <= limit,
          `Valeur ${val} SKU depasse le plafond ${limit} SKU dans ${ex.id}: "${txt}"`,
        );
      }
      if (/patterson/i.test(txt)) {
        assert.ok(
          /%LOP|mmHg/i.test(txt),
          `Citation Patterson sans distinction %LOP/mmHg dans ${ex.id}: "${txt}"`,
        );
        assert.equal(
          /\d+\s*SKU/i.test(txt),
          false,
          `Association numerique SKU + Patterson interdite dans ${ex.id}: "${txt}"`,
        );
      }
    }
  }
});

test("KAATSU Cycle 2.0 : cinematique stricte 30 s ON / 5 s OFF et <= 8 cycles par serie", () => {
  const kaatsuBox = EQUIPMENT.find((e) => e.id === "kaatsu_cycle_20");
  assert.equal(kaatsuBox.safetyLimits.autoCycleOnSec, 30);
  assert.equal(kaatsuBox.safetyLimits.autoCycleOffSec, 5);
  assert.ok(kaatsuBox.safetyLimits.stepsPerCycleSet <= 8);

  const cycleExs = EXERCISES.filter(
    (e) => e.family === "kaatsu" || e.equipment.includes("kaatsu_cycle_20"),
  );
  assert.equal(cycleExs.length, 6);

  for (const ex of cycleExs) {
    const onPhases = ex.phases.filter((p) => /Cycle\s+\d+\/\d+\s+ON/i.test(p.label));
    const offPhases = ex.phases.filter((p) => /Cycle\s+\d+\/\d+\s+OFF/i.test(p.label));
    assert.ok(
      onPhases.length >= 1 && onPhases.length <= 8,
      `${ex.id} doit avoir entre 1 et 8 cycles par serie (trouve ${onPhases.length})`,
    );
    assert.equal(
      onPhases.length,
      offPhases.length,
      `${ex.id} doit avoir autant de phases ON que OFF`,
    );
    for (const p of onPhases) {
      assert.equal(p.sec, 30, `${ex.id} phase ON doit durer 30 s (${p.label})`);
    }
    for (const p of offPhases) {
      assert.equal(p.sec, 5, `${ex.id} phase OFF doit durer 5 s (${p.label})`);
    }
  }
});

test("IHHT : presence systematique de 15 s de bascule masque entre hypoxie et hyperoxie + bornes SpO2", () => {
  const hypoxiaGen = EQUIPMENT.find((e) => e.id === "hypoxia_gen");
  const oximeter = EQUIPMENT.find((e) => e.id === "oximeter");
  assert.equal(hypoxiaGen.safetyLimits.maskSwitchSec, 15);
  assert.ok(hypoxiaGen.safetyLimits.spo2StopThresholdPct >= 80);
  assert.equal(oximeter.safetyLimits.hardStopThresholdPct, 80);

  const ihhtExs = EXERCISES.filter(
    (e) => e.equipment.includes("hypoxia_gen") && e.equipment.includes("hyperoxia_gen"),
  );
  assert.ok(ihhtExs.length >= 3);

  for (const ex of ihhtExs) {
    for (let i = 0; i < ex.phases.length; i++) {
      const p = ex.phases[i];
      if (/-\s*Hypoxie\b/i.test(p.label)) {
        assert.ok(p.sec >= 180 && p.sec <= 360, `${ex.id} hypoxie hors [180,360]s: ${p.sec}`);
        const next = ex.phases[i + 1];
        assert.ok(next && /bascule/i.test(next.label), `${ex.id} manque bascule apres hypoxie`);
        assert.equal(next.sec, 15, `${ex.id} bascule doit durer 15 s`);
      }
      if (/-\s*Hyperoxie\b/i.test(p.label)) {
        assert.ok(p.sec >= 120 && p.sec <= 300, `${ex.id} hyperoxie hors [120,300]s: ${p.sec}`);
        const prev = ex.phases[i - 1];
        assert.ok(prev && /bascule/i.test(prev.label), `${ex.id} manque bascule avant hyperoxie`);
        assert.equal(prev.sec, 15, `${ex.id} bascule doit durer 15 s`);
        const next = ex.phases[i + 1];
        if (next && /-\s*Hypoxie\b/i.test(ex.phases[i + 2]?.label ?? "")) {
          assert.ok(/bascule/i.test(next.label) && next.sec === 15);
        }
      }
      for (const m of p.label.matchAll(/SpO2\s*(?:<=|>)\s*(\d+)\s*%/gi)) {
        assert.ok(Number.parseInt(m[1], 10) >= 80, `${ex.id} seuil SpO2 < 80 %`);
      }
    }
  }
});

test("coherence globale : 60 exercices, 8 protocoles, 14 materiels, 12 contre-indications sans orphelins", () => {
  assert.equal(EXERCISES.length, 60);
  assert.equal(PROTOCOLS.length, 8);
  assert.equal(EQUIPMENT.length, 14);
  assert.equal(CONTRAINDICATIONS.length, 12);

  const usedEq = new Set(EXERCISES.flatMap((e) => e.equipment));
  const usedCi = new Set(EXERCISES.flatMap((e) => e.contraindications));
  for (const eq of EQUIPMENT) {
    assert.ok(usedEq.has(eq.id), `Materiel orphelin: ${eq.id}`);
  }
  for (const ci of CONTRAINDICATIONS) {
    assert.ok(usedCi.has(ci.id), `Contre-indication orpheline: ${ci.id}`);
  }
});
