// GENERATED from shared/ - do not edit
/**
 * Garde-fou global d'erreurs partagé (script classique defer, hors module ES).
 * Capture les erreurs synchrones, les échecs de chargement de modules ES et les
 * promesses rejetées non gérées, puis les affiche dans un bandeau DOM
 * via une manipulation strictement sécurisée (`textContent`).
 *
 * Paramétrable avant chargement via `globalThis.__ERROR_GUARD_CONFIG__` :
 * - `bannerId` (défaut : `"global-error-banner"`)
 * - `prefix` (défaut : `"Erreur applicative : "`)
 * - `closeLabel` (défaut : `"Fermer le bandeau d'erreur"`)
 * - `closeText` (défaut : `"Fermer ✕"`)
 */
(function () {
  "use strict";

  const rawCfg =
    typeof globalThis !== "undefined" &&
    globalThis.__ERROR_GUARD_CONFIG__ &&
    typeof globalThis.__ERROR_GUARD_CONFIG__ === "object"
      ? globalThis.__ERROR_GUARD_CONFIG__
      : {};

  const CONFIG = {
    bannerId:
      typeof rawCfg.bannerId === "string" && rawCfg.bannerId.trim()
        ? rawCfg.bannerId.trim()
        : "global-error-banner",
    prefix:
      typeof rawCfg.prefix === "string"
        ? rawCfg.prefix
        : "Erreur applicative : ",
    closeLabel:
      typeof rawCfg.closeLabel === "string" && rawCfg.closeLabel.trim()
        ? rawCfg.closeLabel.trim()
        : "Fermer le bandeau d'erreur",
    closeText:
      typeof rawCfg.closeText === "string" && rawCfg.closeText.trim()
        ? rawCfg.closeText.trim()
        : "Fermer ✕",
  };

  /**
   * Formate une localisation fichier:ligne[:colonne] si disponible.
   * @param {string | undefined} filename
   * @param {number | undefined} lineno
   * @param {number | undefined} colno
   * @returns {string}
   */
  function formatLocation(filename, lineno, colno) {
    if (!filename && !lineno) {
      return "";
    }
    let shortFile = filename || "<inconnu>";
    try {
      if (shortFile.startsWith("http://") || shortFile.startsWith("https://")) {
        const parsed = new URL(shortFile);
        shortFile = parsed.pathname.split("/").filter(Boolean).pop() || shortFile;
      }
    } catch {
      // Conservation du nom brut si URL invalide
    }
    if (lineno && colno) {
      return ` (${shortFile}:${lineno}:${colno})`;
    }
    if (lineno) {
      return ` (${shortFile}:${lineno})`;
    }
    return ` (${shortFile})`;
  }

  /**
   * Extrait une description textuelle exacte d'un événement `error`.
   * @param {ErrorEvent | Event} event
   * @returns {string}
   */
  function describeErrorEvent(event) {
    if (event && (event.message || event.error)) {
      const errMsg =
        event.error && typeof event.error.message === "string" && event.error.message
          ? event.error.message
          : event.message || "Erreur JavaScript inconnue";
      const loc = formatLocation(event.filename, event.lineno, event.colno);
      return `${errMsg}${loc}`;
    }

    const target = event && event.target;
    if (target && target !== window) {
      const tag = target.tagName ? String(target.tagName).toLowerCase() : "ressource";
      const src = target.src || target.href || "";
      return src
        ? `Échec de chargement <${tag}> : ${src}`
        : `Échec de chargement d'une ressource <${tag}>`;
    }

    return "Erreur d'exécution non identifiée";
  }

  /**
   * Extrait une description textuelle exacte d'un rejet de promesse non géré.
   * @param {PromiseRejectionEvent} event
   * @returns {string}
   */
  function describeRejectionEvent(event) {
    const reason = event ? event.reason : undefined;
    if (reason instanceof Error) {
      const loc = formatLocation(reason.fileName, reason.lineNumber, reason.columnNumber);
      return `${reason.message || reason.name || "Erreur asynchrone"}${loc}`;
    }
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason;
    }
    if (reason !== undefined && reason !== null) {
      try {
        return JSON.stringify(reason);
      } catch {
        return String(reason);
      }
    }
    return "Promesse rejetée sans détail";
  }

  /**
   * Affiche le message d'erreur dans le bandeau cible sans `innerHTML`.
   * @param {string} detail
   */
  function showGlobalError(detail) {
    const render = () => {
      const banner = document.getElementById(CONFIG.bannerId);
      if (!banner) {
        return;
      }

      banner.replaceChildren();

      const msgSpan = document.createElement("span");
      msgSpan.className = "error-banner-text";
      msgSpan.textContent = `${CONFIG.prefix}${detail}`;

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "btn btn-ghost btn-sm error-banner-close";
      closeBtn.setAttribute("aria-label", CONFIG.closeLabel);
      closeBtn.textContent = CONFIG.closeText;
      closeBtn.addEventListener("click", () => {
        banner.hidden = true;
        banner.replaceChildren();
      });

      banner.append(msgSpan, closeBtn);
      banner.hidden = false;
    };

    if (document.readyState === "loading" && !document.getElementById(CONFIG.bannerId)) {
      document.addEventListener("DOMContentLoaded", render, { once: true });
    } else {
      render();
    }
  }

  // Capture phase = true pour intercepter aussi les échecs de chargement <script type="module">
  window.addEventListener(
    "error",
    (event) => {
      showGlobalError(describeErrorEvent(event));
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    showGlobalError(describeRejectionEvent(event));
  });
})();
