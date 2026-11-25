import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecoveryActivityPayload,
  fetchJsonWithBackoff,
  fetchRecoveryContext,
  flushPendingRecoveryWorkouts,
  normalizeTodayActivity,
  publishRecoveryWorkout,
} from "../intervalsClient.js";
import { computeRecoveryScore, isAllowed, selectProtocol } from "../engine.js";
import { EXERCISES_BY_ID } from "../catalog.js";
import { createOutbox } from "../outbox.js";
import { saveVault } from "../vault.js";

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

describe("intervalsClient", () => {
  it("lit wellness 7j (hrv, sleepSecs, sleepScore, ctl/atl -> tsb) et activités du jour normalisées", async () => {
    const originalStorage = globalThis.localStorage;
    globalThis.localStorage = createMemoryStorage();
    try {
      saveVault({
        INTERVALS_ATHLETE_ID: "i999",
        INTERVALS_API_KEY: "secret_key_never_log",
      });

      const calls = [];
      const mockFetch = async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/wellness?")) {
          return jsonResponse([
            { id: "2026-11-19", hrv: 58 },
            { id: "2026-11-20", hrv: 60 },
            { id: "2026-11-21", hrv: 59 },
            { id: "2026-11-22", hrv: 61 },
            { id: "2026-11-23", hrv: 62 },
            { id: "2026-11-24", hrv: 64 },
            {
              id: "2026-11-25",
              hrv: 70,
              sleepSecs: 28800,
              sleepScore: 86,
              ctl: 75,
              atl: 70,
            },
          ]);
        }
        if (url.includes("/activities?")) {
          return jsonResponse([
            {
              id: "act_prev",
              type: "Ride",
              start_date_local: "2026-11-24T10:00:00",
              elapsed_time: 3600,
              icu_intensity: 72,
            },
            {
              id: "act_str",
              type: "WeightTraining",
              name: "<script>alert(1)</script>Muscu Jambes",
              start_date_local: "2026-11-25T11:00:00Z",
              elapsed_time: 3600,
              icu_rpe: 8,
            },
            {
              id: "act_ride",
              type: "VirtualRide",
              name: "HIIT Zwift",
              start_date_local: "2026-11-25T08:00:00Z",
              elapsed_time: 2700,
              icu_intensity: 91,
              icu_training_load: 85,
            },
          ]);
        }
        throw new Error(`URL inattendue : ${url}`);
      };

      const ctx = await fetchRecoveryContext({
        now: new Date("2026-11-25T13:30:00Z"),
        fetchImpl: mockFetch,
      });

      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.includes("/athlete/i999/wellness"));
      assert.ok(calls[0].init.headers.Authorization.startsWith("Basic "));
      assert.equal(ctx.hrvToday, 70);
      assert.equal(ctx.hrvHistory7d.length, 7);
      assert.equal(ctx.sleepSecs, 28800);
      assert.equal(ctx.sleepHours, 8);
      assert.equal(ctx.sleepScore, 86);
      assert.equal(ctx.ctl, 75);
      assert.equal(ctx.atl, 70);
      assert.equal(ctx.tsb, 5);
      assert.equal(ctx.todayActivities.length, 2);

      const strength = ctx.todayActivities.find((a) => a.type === "strength");
      assert.ok(strength);
      assert.equal(strength.endTime, "2026-11-25T12:00:00.000Z");
      assert.equal(strength.intensity, "high");
      assert.equal(strength.name.includes("<script>"), false);

      const ride = ctx.todayActivities.find((a) => a.type === "ride");
      assert.ok(ride);
      assert.equal(ride.intense, true);

      // Intégration directe avec engine.js
      const score = computeRecoveryScore(ctx);
      assert.ok(score.score >= 70);
      assert.equal(selectProtocol({ todayActivities: ctx.todayActivities }, score), "post_muscu_sans_froid");

      const coldAllowed = isAllowed(EXERCISES_BY_ID.thermal_cold_plunge_full, {
        equipmentAvailable: new Set(["cold_plunge"]),
        todayActivities: ctx.todayActivities,
        now: "2026-11-25T13:30:00Z",
      });
      assert.equal(coldAllowed.ok, false);
      assert.ok(coldAllowed.reasons.includes("strength_lt_4h"));
    } finally {
      globalThis.localStorage = originalStorage;
    }
  });

  it("applique backoff exponentiel + jitter sur 429 / 503 et n'expose jamais la clé API", async () => {
    const delays = [];
    let attempt = 0;
    const mockFetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse("rate limit", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      if (attempt === 2) {
        return jsonResponse("server busy", { status: 503 });
      }
      return jsonResponse({ ok: true, attempt });
    };

    const data = await fetchJsonWithBackoff(
      "https://intervals.icu/api/v1/athlete/0/wellness",
      {
        fetchImpl: mockFetch,
        baseDelayMs: 10,
        jitterMaxMs: 5,
        randomFn: () => 0.5,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
      3
    );

    assert.equal(data.ok, true);
    assert.equal(attempt, 3);
    assert.equal(delays.length, 2);
    // 1er retry via Retry-After: 0 + jitter (floor(0.5 * 6) = 3)
    assert.equal(delays[0], 3);
    // 2e retry exponentiel (10 * 2^1 = 20) + jitter (3)
    assert.equal(delays[1], 23);

    // Vérifie qu'une erreur 401 ne fuit jamais la clé API
    const secretApiKey = "MY_SUPER_SECRET_INTERVALS_TOKEN";
    await assert.rejects(
      () =>
        fetchRecoveryContext({
          athleteId: "0",
          apiKey: secretApiKey,
          fetchImpl: async () => jsonResponse("Unauthorized", { status: 401 }),
        }),
      (err) => {
        assert.equal(err.message.includes(secretApiKey), false);
        return true;
      }
    );
  });

  it("publie une activité + RecoveryLoad/RecoveryType et bascule sur outbox en cas d'échec", async () => {
    const testOutbox = createOutbox({
      dbName: "test_webrecovery_db",
      fallbackStorageKey: "TEST_OUTBOX_V1",
    });
    await testOutbox.clearOutbox();

    const requests = [];
    const okFetch = async (url, init) => {
      requests.push({ url, method: init.method, body: JSON.parse(init.body) });
      if (init.method === "POST") {
        return jsonResponse({ id: "icu_42", name: "WebRecovery" });
      }
      if (init.method === "PUT") {
        return jsonResponse({ id: "icu_42", RecoveryLoad: 25 });
      }
      throw new Error("Méthode inattendue");
    };

    const resOk = await publishRecoveryWorkout({
      athleteId: "0",
      apiKey: "valid_key",
      session: {
        external_id: "rec_ok_1",
        protocolId: "post_hiit_velo",
        name: "Post-HIIT vélo",
        elapsedSec: 900,
        rpe: 4,
        notes: "Jambes légères",
      },
      fetchImpl: okFetch,
      outboxImpl: testOutbox,
    });

    assert.equal(resOk.ok, true);
    assert.equal(resOk.queued, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].body.RecoveryType, "post_hiit_velo");
    assert.equal(requests[0].body.RecoveryLoad, 30);
    assert.equal(requests[1].method, "PUT");
    assert.ok(requests[1].url.endsWith("/activity/icu_42"));
    assert.equal(requests[1].body.RecoveryLoad, 30);
    assert.equal(requests[1].body.RecoveryType, "post_hiit_velo");
    assert.equal(await testOutbox.countOutbox(), 0);

    // En cas d'échec réseau -> mise en file Outbox puis vidage quand réseau revient
    const payloadFail = buildRecoveryActivityPayload({
      external_id: "rec_fail_1",
      protocolId: "soir_sommeil",
      name: "Soir & Sommeil",
      elapsedSec: 600,
      rpe: 2,
    });

    const resQueued = await publishRecoveryWorkout({
      athleteId: "0",
      apiKey: "valid_key",
      payload: payloadFail,
      fetchImpl: async () => {
        throw new Error("Network down");
      },
      outboxImpl: testOutbox,
      maxRetries: 0,
    });

    assert.equal(resQueued.ok, false);
    assert.equal(resQueued.queued, true);
    assert.equal(await testOutbox.countOutbox(), 1);

    // Flush quand Intervals répond à nouveau
    const flushRequests = [];
    const flushRes = await flushPendingRecoveryWorkouts({
      athleteId: "0",
      apiKey: "valid_key",
      outboxImpl: testOutbox,
      fetchImpl: async (url, init) => {
        flushRequests.push({ url, method: init.method, body: JSON.parse(init.body) });
        if (init.method === "POST") return jsonResponse({ id: "icu_99" });
        return jsonResponse({ id: "icu_99" });
      },
    });

    assert.equal(flushRes.sentCount, 1);
    assert.equal(flushRes.remainingCount, 0);
    assert.equal(flushRequests[0].body.external_id, "rec_fail_1");
    assert.equal(flushRequests[0].body.RecoveryType, "soir_sommeil");
  });

  it("énumère type/intensity, utilise 3600 s si endTime absent et ne réécho pas athleteId invalide", async () => {
    const act = normalizeTodayActivity({
      id: "act_x",
      type: "<script>bad</script>",
      intensity: "super_extreme_injection",
      start_date_local: "2026-11-25T10:00:00.000Z",
    });

    assert.equal(act.type, "other");
    assert.equal(act.intensity, "moderate");
    assert.equal(act.endTime, "2026-11-25T11:00:00.000Z");

    const badAthlete = "malicious_raw_id_12345";
    await assert.rejects(
      () =>
        fetchRecoveryContext({
          athleteId: badAthlete,
          apiKey: "valid_key",
          fetchImpl: async () => jsonResponse([]),
        }),
      (err) => {
        assert.equal(err.message.includes(badAthlete), false);
        return true;
      }
    );
  });
});
