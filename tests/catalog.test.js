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
