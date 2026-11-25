import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSession, isAllowed } from "../engine.js";
import {
  enforceSymbolicConstraints,
  generateFallbackSession,
} from "../fallbackGenerator.js";
import {
  buildResponseSchema,
  personalizeSessionWithGemini,
} from "../geminiClient.js";

function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function makeAllEquipment() {
  return new Set([
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
  ]);
}

describe("fallbackGenerator & geminiClient", () => {
  it("fallback hors-ligne déterministe = engine.buildSession brut", async () => {
    const ctx = {
      equipmentAvailable: makeAllEquipment(),
      userContraindications: new Set(["tvp_history"]),
      kaatsuSupervisedOnce: true,
      todayActivities: [
        { type: "strength", endTime: "2026-11-25T10:00:00Z" },
      ],
      now: "2026-11-25T12:00:00Z",
    };

    const rawBuilt = buildSession("post_hiit_velo", ctx);
    const fallback = generateFallbackSession("post_hiit_velo", ctx);

    assert.equal(fallback.source, "FALLBACK_LOCAL");
    assert.deepEqual(
      fallback.items.map((e) => e.id),
      rawBuilt.items.map((e) => e.id)
    );
    assert.deepEqual(fallback.removed, rawBuilt.removed);
    assert.equal(fallback.totalSec, rawBuilt.totalSec);

    // Sans clé API -> retourne exactement buildSession brut sans appel réseau
    let fetchCalled = false;
    const res = await personalizeSessionWithGemini({
      apiKey: "",
      protocolId: "post_hiit_velo",
      ctx,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("Ne doit pas être appelé");
      },
    });

    assert.equal(fetchCalled, false);
    assert.equal(res.source, "FALLBACK_LOCAL");
    assert.deepEqual(
      res.items.map((e) => e.id),
      rawBuilt.items.map((e) => e.id)
    );
  });

  it("Gemini réordonne et personnalise les cues sans jamais ajouter un exercice interdit", async () => {
    const ctx = {
      equipmentAvailable: new Set([
        "bolster_jacquier",
        "foam_roller",
        "massage_ball",
        "massage_gun",
        "stretch_strap",
        "compression_boots",
        "cold_plunge",
      ]),
      userContraindications: new Set(),
      kaatsuSupervisedOnce: false,
      // Muscu < 4h : bain froid strictement interdit ; KAATSU non supervisé interdit
      todayActivities: [
        { type: "strength", endTime: "2026-11-25T11:00:00Z" },
      ],
      now: "2026-11-25T12:00:00Z",
    };

    const baseSession = generateFallbackSession("post_hiit_velo", ctx);
    assert.ok(baseSession.items.length >= 2);
    const allowedIds = baseSession.items.map((i) => i.id);
    assert.equal(allowedIds.includes("thermal_cold_plunge_legs"), false);
    assert.equal(allowedIds.includes("kaatsu_cycle_legs_progressive"), false);

    // Vérifie que le responseSchema restreint l'enum aux seuls IDs déjà filtrés
    const schema = buildResponseSchema(baseSession.items);
    assert.deepEqual(schema.properties.items.items.properties.id.enum, allowedIds);

    const reversedIds = [...allowedIds].reverse();

    const mockFetch = async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "Réflexion interne ignorée" },
                {
                  text: JSON.stringify({
                    rationale:
                      "<b>Priorité</b> relâchement respiratoire après votre séance.",
                    items: [
                      // Tentative d'injection d'exercices interdits / hors session
                      {
                        id: "thermal_cold_plunge_legs",
                        cues: ["Plongez dans le bain froid"],
                      },
                      {
                        id: "kaatsu_cycle_legs_progressive",
                        cues: ["KAATSU non supervisé"],
                      },
                      {
                        id: "ihht_recovery_10_10",
                        cues: ["IHHT sans oxymètre"],
                      },
                      {
                        id: reversedIds[0],
                        cues: [
                          "<script>bad()</script>Respiration lente et fluide.",
                          "Garder une cadence de 99 bpm.",
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      });

    const result = await personalizeSessionWithGemini({
      apiKey: "fake_gemini_key",
      model: "gemini-3.5-flash",
      protocolId: "post_hiit_velo",
      ctx,
      baseSession,
      fetchImpl: mockFetch,
    });

    assert.equal(result.source, "FALLBACK_LOCAL");
    assert.equal(result.guardrailApplied, true);
    assert.equal(result.rationale, baseSession.rationale);
    assert.deepEqual(result.rejectedIds, [
      "thermal_cold_plunge_legs",
      "kaatsu_cycle_legs_progressive",
      "ihht_recovery_10_10",
    ]);

    // Aucun exercice interdit présent, tous les items passent engine.isAllowed
    const resultIds = result.items.map((i) => i.id);
    assert.equal(resultIds[0], reversedIds[0]);
    assert.equal(resultIds.length, allowedIds.length);
    for (const item of result.items) {
      assert.equal(isAllowed(item, ctx).ok, true);
    }

    // Cues catalogue immuables préservées + cue Gemini sans chiffre en complément (cue avec chiffre filtrée)
    const baseEx = baseSession.items.find((e) => e.id === reversedIds[0]);
    assert.deepEqual(
      result.items[0].cues.slice(0, baseEx.cues.length),
      baseEx.cues
    );
    assert.equal(
      result.items[0].cues.some((c) => c.includes("<script>")),
      false
    );
    assert.equal(
      result.items[0].cues.some((c) => c.includes("99")),
      false
    );
    assert.ok(
      result.items[0].cues.some((c) => c.includes("Respiration lente et fluide."))
    );
    assert.equal(result.items[0].durationSec, baseEx.durationSec);
  });

  it("garde les cues catalogue, limite les cues Gemini à 2 sans chiffres et revalide KAATSU + maxMinutes", () => {
    const ctx = {
      equipmentAvailable: makeAllEquipment(),
      kaatsuSupervisedOnce: true,
      now: "2026-11-25T14:00:00Z",
    };
    const baseSession = generateFallbackSession("post_muscu_sans_froid", ctx);
    assert.ok(baseSession.items.length >= 2);

    const validated = enforceSymbolicConstraints(
      {
        rationale: "<b>Séance</b> optimisée.",
        items: baseSession.items.map((ex) => ({
          id: ex.id,
          cues: [
            "Cue alpha valide.",
            "Cue beta 120 mmHg à exclure.",
            "Cue gamma valide.",
            "Cue delta dépassant max 2.",
          ],
        })),
      },
      { baseSession, ctx, options: { maxMinutes: 12 } }
    );

    assert.ok(validated.totalSec <= 12 * 60);
    assert.equal(validated.source, "FALLBACK_LOCAL");
    assert.equal(validated.rationale, baseSession.rationale);
    for (const item of validated.items) {
      const baseEx = baseSession.items.find((e) => e.id === item.id);
      assert.deepEqual(item.cues.slice(0, baseEx.cues.length), baseEx.cues);
      const extras = item.cues.slice(baseEx.cues.length);
      assert.equal(extras.length <= 2, true);
      for (const extra of extras) {
        assert.equal(/\d/.test(extra), false);
      }
    }
  });

  it("en repli, filtre resolvedBase.items via isAllowed et assainit buildPrompts", async () => {
    const ctxSafe = {
      equipmentAvailable: makeAllEquipment(),
      kaatsuSupervisedOnce: true,
      now: "2026-11-25T12:00:00Z",
    };
    const staleBase = generateFallbackSession("post_muscu_sans_froid", ctxSafe);

    // Contexte durci entre-temps : TVP + activité malveillante non listée
    const ctxUpdated = {
      ...ctxSafe,
      userContraindications: new Set(["tvp_history"]),
      todayActivities: [
        { type: "<script>evil</script>", intensity: "extreme_override" },
      ],
    };

    // 1. Repli hors-ligne (sans clé) doit filtrer staleBase via isAllowed
    const offlineFallback = await personalizeSessionWithGemini({
      apiKey: "",
      protocolId: "post_muscu_sans_froid",
      ctx: ctxUpdated,
      baseSession: staleBase,
    });
    assert.equal(offlineFallback.source, "FALLBACK_LOCAL");
    assert.equal(
      offlineFallback.items.some((ex) => ex.family === "kaatsu"),
      false
    );

    // 2. Prompt envoyé à Gemini applique liste blanche type/intensity + sanitizeCueText
    let capturedPrompt = "";
    const errorFallback = await personalizeSessionWithGemini({
      apiKey: "fake_key",
      protocolId: "<img src=x onerror=alert(1)>",
      ctx: ctxUpdated,
      baseSession: {
        ...staleBase,
        protocolId: "<img src=x>post_muscu_sans_froid",
      },
      recoveryScore: { score: 65, level: "<b>good</b>" },
      fetchImpl: async (_url, init) => {
        capturedPrompt = JSON.parse(init.body).contents[0].parts[0].text;
        return jsonResponse("Boom", { status: 500 });
      },
    });
    assert.equal(errorFallback.source, "FALLBACK_LOCAL");
    assert.equal(
      errorFallback.items.some((ex) => ex.family === "kaatsu"),
      false
    );
    assert.ok(capturedPrompt.includes('"type":"other"'));
    assert.ok(capturedPrompt.includes('"intensity":"moderate"'));
    assert.equal(capturedPrompt.includes("<img"), false);
    assert.equal(capturedPrompt.includes("<b>"), false);
  });

  it("re-valide via isAllowed même si baseSession contient un exercice devenu interdit", () => {
    const ctxSafe = {
      equipmentAvailable: makeAllEquipment(),
      kaatsuSupervisedOnce: true,
      now: "2026-11-25T12:00:00Z",
    };
    const baseSession = generateFallbackSession("post_muscu_sans_froid", ctxSafe);

    // L'utilisateur coche ensuite une contre-indication TVP avant la validation
    const ctxUpdated = {
      ...ctxSafe,
      userContraindications: new Set(["tvp_history"]),
    };

    const validated = enforceSymbolicConstraints(
      {
        rationale: "Test re-validation",
        items: baseSession.items.map((ex) => ({ id: ex.id, cues: ["OK"] })),
      },
      { baseSession, ctx: ctxUpdated }
    );

    assert.equal(
      validated.items.some((ex) => ex.family === "kaatsu"),
      false
    );
    assert.ok(validated.rejectedIds.includes("kaatsu_cycle_legs_recovery_soft"));
  });

  it("bascule sur le fallback déterministe si Gemini renvoie HTTP 500 ou JSON invalide", async () => {
    const ctx = {
      equipmentAvailable: makeAllEquipment(),
      kaatsuSupervisedOnce: true,
      now: "2026-11-25T14:00:00Z",
    };
    const baseSession = generateFallbackSession("repos_actif", ctx);

    const res500 = await personalizeSessionWithGemini({
      apiKey: "fake_gemini_key",
      protocolId: "repos_actif",
      ctx,
      baseSession,
      fetchImpl: async () => jsonResponse("Internal error", { status: 500 }),
    });

    assert.equal(res500.source, "FALLBACK_LOCAL");
    assert.deepEqual(
      res500.items.map((i) => i.id),
      baseSession.items.map((i) => i.id)
    );

    const resBadJson = await personalizeSessionWithGemini({
      apiKey: "fake_gemini_key",
      protocolId: "repos_actif",
      ctx,
      baseSession,
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "{not valid json" }] } }],
        }),
    });

    assert.equal(resBadJson.source, "FALLBACK_LOCAL");
    assert.equal(resBadJson.totalSec, baseSession.totalSec);
  });

  it("auto-répare un modèle 404 en interrogeant la liste des modèles actifs", async () => {
    const ctx = {
      equipmentAvailable: makeAllEquipment(),
      kaatsuSupervisedOnce: true,
      now: "2026-11-25T14:00:00Z",
    };
    const baseSession = generateFallbackSession("cheville", ctx);

    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("obsolete-model:generateContent")) {
        return jsonResponse("Not found", { status: 404 });
      }
      if (url.includes("?pageSize=100")) {
        return jsonResponse({
          models: [
            {
              name: "models/gemini-3.8-flash",
              displayName: "Gemini 3.8 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        });
      }
      if (url.includes("gemini-3.8-flash:generateContent")) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      rationale: "Mobilité cheville adaptée.",
                      items: baseSession.items.map((ex) => ({
                        id: ex.id,
                        cues: ["Mouvement contrôlé sans douleur."],
                      })),
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`URL inattendue : ${url}`);
    };

    const res = await personalizeSessionWithGemini({
      apiKey: "fake_key",
      model: "gemini-obsolete-model",
      protocolId: "cheville",
      ctx,
      baseSession,
      fetchImpl: mockFetch,
    });

    assert.equal(res.source, "GEMINI");
    assert.equal(res.model, "gemini-3.8-flash");
    assert.equal(res.autoUpgradedFrom, "gemini-obsolete-model");
    assert.equal(calls.length, 3);
  });
});
