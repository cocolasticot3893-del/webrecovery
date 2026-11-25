import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createDriveSync,
  pushCustomExercisesToDrive,
  validateDriveWebhookUrl,
} from "../driveSync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");

describe("driveSync sécurité Apps Script", () => {
  it("exige requireAppsScript=true par défaut et la regex stricte sans query/hash", () => {
    const validUrl =
      "https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec";
    assert.equal(validateDriveWebhookUrl(validUrl).valid, true);

    assert.equal(
      validateDriveWebhookUrl("https://evil.example.com/webhook").valid,
      false
    );
    assert.equal(
      validateDriveWebhookUrl(
        "https://script.googleusercontent.com/macros/echo?user=1"
      ).valid,
      false
    );
    assert.equal(validateDriveWebhookUrl(`${validUrl}?secret=leak`).valid, false);
    assert.equal(validateDriveWebhookUrl(`${validUrl}#frag`).valid, false);
    assert.equal(
      validateDriveWebhookUrl("https://script.google.com/macros/s/short/exec")
        .valid,
      false
    );

    const client = createDriveSync({ app: "webrecovery" });
    assert.equal(
      client.validateDriveWebhookUrl("https://evil.example.com/hook").valid,
      false
    );
  });

  it("refuse d'envoyer les exercices hors webhook Apps Script strict par défaut", async () => {
    await assert.rejects(() =>
      pushCustomExercisesToDrive({
        webhookUrl: "https://evil.example.com/hook",
        secret: "top_secret",
        exercisesJson: [{ id: "ex1" }],
        fetchImpl: async () => {
          throw new Error("Ne doit pas appeler fetch");
        },
      })
    );
  });
});

describe("Durcissement statique index.html, sw.js et app.js", () => {
  it("index.html applique la CSP stricte sans unsafe-inline ni style= et défauts fail-closed", () => {
    const html = readFileSync(join(ROOT_DIR, "index.html"), "utf8");

    assert.match(html, /style-src 'self';/);
    assert.equal(html.includes("'unsafe-inline'"), false);
    assert.match(html, /form-action 'self'/);
    assert.match(html, /frame-src 'none'/);
    assert.match(html, /worker-src 'self'/);
    assert.equal(/\sstyle=/.test(html), false);

    // SpO2 live vide par défaut, seuil SpO2 min="80", ihht/sauna non cochés par défaut
    assert.match(html, /id="live-spo2-input"[^>]*>/);
    assert.equal(/id="live-spo2-input"[^>]*value=/.test(html), false);
    assert.match(html, /id="spo2-threshold"[\s\S]*?min="80"/);
    assert.equal(/id="q-ihht-safety-ok"[^>]*checked/.test(html), false);
    assert.equal(/id="q-sauna-cleared"[^>]*checked/.test(html), false);

    // 7 contre-indications ajoutées dans l'UI
    for (const id of [
      "q-lymphedema-av-fistula",
      "q-severe-respiratory-anemia",
      "q-acute-fever-infection",
      "q-cold-urticaria-raynaud",
      "q-acute-trauma-open-wound",
      "q-spinal-instability-radiculopathy",
      "q-orthostatic-hypotension",
    ]) {
      assert.ok(html.includes(`id="${id}"`), `Checkbox manquante : ${id}`);
    }
  });

  it("sw.js cache uniquement PRECACHE_ASSETS sans ignoreSearch ni cache opportuniste", () => {
    const sw = readFileSync(join(ROOT_DIR, "sw.js"), "utf8");
    const fetchSection = sw.slice(sw.indexOf('addEventListener("fetch"'));
    assert.equal(fetchSection.includes("ignoreSearch"), false);
    assert.ok(sw.includes("PRECACHE_PATHS.has(url.pathname)"));
    assert.equal(fetchSection.includes("cache.put("), false);
  });

  it("app.js vérifie isAllowed dans getItemBlockReason/loadIntoTimer et valide l'URL Drive", () => {
    const app = readFileSync(join(ROOT_DIR, "app.js"), "utf8");
    assert.ok(app.includes("isAllowed(ex, ctx)"));
    assert.ok(app.includes("ihhtSafetyOk: false"));
    assert.ok(app.includes("saunaCleared: false"));
    assert.ok(app.includes("clampNumber(parsed?.spo2ThresholdPct, 80, 95, 85)"));
    assert.equal(/\bsetAttribute\s*\(\s*['"]style['"]/.test(app), false);
  });

  it("Conformité PWA smartphone : manifest PNG, meta/apple-touch-icon, #pwa-install-btn sans style= et sw v2", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT_DIR, "manifest.webmanifest"), "utf8")
    );
    assert.equal(manifest.id, "./");
    assert.ok(Array.isArray(manifest.icons));

    const hasIcon = (src, sizes, purpose) =>
      manifest.icons.some(
        (icon) =>
          icon.src === src &&
          icon.type === "image/png" &&
          icon.sizes === sizes &&
          icon.purpose === purpose
      );

    assert.ok(hasIcon("./icons/icon-192.png", "192x192", "any"));
    assert.ok(hasIcon("./icons/icon-512.png", "512x512", "any"));
    assert.ok(hasIcon("./icons/icon-512-maskable.png", "512x512", "maskable"));

    const html = readFileSync(join(ROOT_DIR, "index.html"), "utf8");
    assert.match(
      html,
      /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\.\/icons\/icon-180\.png"\s*\/>/
    );
    assert.match(
      html,
      /<button[^>]*id="pwa-install-btn"[^>]*>/
    );
    assert.equal(/\sstyle=/.test(html), false);

    const sw = readFileSync(join(ROOT_DIR, "sw.js"), "utf8");
    assert.match(sw, /const CACHE_NAME = "webrecovery-v2";/);
    for (const iconPath of [
      "./icons/icon-180.png",
      "./icons/icon-192.png",
      "./icons/icon-512.png",
      "./icons/icon-512-maskable.png",
    ]) {
      assert.ok(sw.includes(`"${iconPath}"`), `Icone manquante dans sw.js : ${iconPath}`);
    }
  });
});
