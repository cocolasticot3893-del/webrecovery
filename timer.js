/**
 * Minuteur multi-phases générique pour WebRecovery (ES2024+ zéro-build).
 * Gère les phases séquentielles avec répétitions (`repeat`), pause/reprise/skip,
 * signaux sonores WebAudio, vibrations, Wake Lock écran et hook de sécurité SpO₂
 * appelé chaque seconde (`onSafetyCheck`).
 * Horloge et périphériques injectables pour tests unitaires déterministes.
 */

const PHASE_FREQ_HZ = Object.freeze({
  start: 392,
  phase: 440,
  warning: 293.66,
  alert: 220,
  done: 523.25,
});

/**
 * Formate une durée entière en secondes au format `mm:ss`.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatDurationSec(totalSeconds) {
  const safe = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Déplie une liste de phases avec `repeat` (phase unitaire ou bloc `{ repeat, phases }`)
 * en une séquence plate d'étapes exécutables.
 * @param {Array<Record<string, unknown>>} phases
 * @returns {Array<{
 *   label: string,
 *   sec: number,
 *   durationMs: number,
 *   type: string,
 *   rep: number,
 *   totalReps: number,
 *   stepIndex: number,
 *   totalSteps: number,
 *   meta: Record<string, unknown>
 * }>}
 */
export function expandPhases(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    return [];
  }

  /** @type {Array<{ label: string, sec: number, type: string, rep: number, totalReps: number, meta: Record<string, unknown> }>} */
  const rawSteps = [];

  for (const item of phases) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const repeatCount = Math.max(1, Math.floor(Number(item.repeat) || 1));

    // Bloc imbriqué { repeat, phases: [...] }
    if (Array.isArray(item.phases) && item.phases.length > 0) {
      const subExpanded = expandPhases(item.phases);
      for (let cycle = 1; cycle <= repeatCount; cycle += 1) {
        for (const sub of subExpanded) {
          rawSteps.push({
            label: repeatCount > 1 ? `${sub.label} (${cycle}/${repeatCount})` : sub.label,
            sec: sub.sec,
            type: sub.type,
            rep: cycle,
            totalReps: repeatCount,
            meta: { ...sub.meta },
          });
        }
      }
      continue;
    }

    const sec = Number(item.sec);
    if (!Number.isFinite(sec) || sec <= 0) {
      continue;
    }

    const label = String(item.label ?? "Phase").trim() || "Phase";
    const type = String(item.type ?? "work");
    const meta =
      item.meta && typeof item.meta === "object" ? { ...item.meta } : {};

    for (let rep = 1; rep <= repeatCount; rep += 1) {
      rawSteps.push({
        label,
        sec,
        type,
        rep,
        totalReps: repeatCount,
        meta,
      });
    }
  }

  const totalSteps = rawSteps.length;
  return rawSteps.map((step, index) => ({
    ...step,
    durationMs: Math.round(step.sec * 1000),
    stepIndex: index,
    totalSteps,
  }));
}

/**
 * Contrôleur WebAudio minimaliste sans dépendance externe.
 */
class WebAudioBeeper {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
  }

  /**
   * Joue un bip synthétique court selon le type d'événement.
   * @param {"start" | "phase" | "warning" | "alert" | "done"} kind
   */
  play(kind) {
    const AudioCtx =
      typeof globalThis.AudioContext === "function"
        ? globalThis.AudioContext
        : typeof globalThis.webkitAudioContext === "function"
          ? globalThis.webkitAudioContext
          : null;
    if (!AudioCtx) {
      return;
    }

    try {
      if (!this.ctx) {
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const baseFreq = PHASE_FREQ_HZ[kind] ?? PHASE_FREQ_HZ.phase;

      osc.type = kind === "alert" ? "sawtooth" : kind === "done" ? "triangle" : "sine";
      osc.frequency.setValueAtTime(baseFreq, now);

      if (kind === "done") {
        osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.16);
      } else if (kind === "alert") {
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(180, now + 0.14);
      }

      const duration = kind === "done" ? 0.35 : kind === "alert" ? 0.32 : 0.18;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(kind === "alert" ? 0.1 : 0.065, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch {
      // Contexte audio bloqué ou indisponible
    }
  }

  close() {
    if (this.ctx && typeof this.ctx.close === "function") {
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}

/**
 * Interprète la valeur de retour de `onSafetyCheck`.
 * Retourne `{ ok: true }` sauf si `false` ou `{ ok: false }` / `{ interrupt: true }`.
 * @param {unknown} result
 * @returns {{ ok: boolean, reason: string }}
 */
function parseSafetyResult(result) {
  if (result === false) {
    return { ok: false, reason: "Interruption de sécurité déclenchée." };
  }
  if (result && typeof result === "object") {
    const obj = /** @type {Record<string, unknown>} */ (result);
    if (obj.ok === false || obj.interrupt === true || obj.abort === true) {
      return {
        ok: false,
        reason:
          typeof obj.reason === "string" && obj.reason.trim()
            ? obj.reason.trim()
            : "Seuil de sécurité physiologique franchi.",
      };
    }
  }
  return { ok: true, reason: "" };
}

/**
 * Minuteur multi-phases générique avec garde-fou temps réel par seconde.
 */
export class MultiPhaseTimer {
  /**
   * @param {object} [options]
   * @param {Array<Record<string, unknown>>} [options.phases]
   * @param {(snapshot: object) => void} [options.onTick]
   * @param {(phaseInfo: object) => void} [options.onPhase]
   * @param {(summary: object) => void} [options.onDone]
   * @param {(snapshot: object) => (boolean | object | Promise<boolean | object>)} [options.onSafetyCheck]
   * @param {(state: object) => void} [options.onStateChange]
   * @param {number} [options.tickIntervalMs=250]
   * @param {boolean} [options.muted=false]
   * @param {boolean} [options.vibrateEnabled=true]
   * @param {{ now: () => number, setInterval: Function, clearInterval: Function }} [options.clock]
   * @param {{ play: (kind: string) => void, close?: () => void }} [options.audio]
   * @param {(pattern: number | number[]) => boolean} [options.vibrate]
   * @param {{ request: (type: string) => Promise<unknown> } | null} [options.wakeLock]
   */
  constructor(options = {}) {
    this.onTick = typeof options.onTick === "function" ? options.onTick : null;
    this.onPhase = typeof options.onPhase === "function" ? options.onPhase : null;
    this.onDone = typeof options.onDone === "function" ? options.onDone : null;
    this.onSafetyCheck =
      typeof options.onSafetyCheck === "function" ? options.onSafetyCheck : null;
    this.onStateChange =
      typeof options.onStateChange === "function" ? options.onStateChange : null;

    this.tickIntervalMs = Math.max(50, Number(options.tickIntervalMs) || 250);
    this.muted = Boolean(options.muted);
    this.vibrateEnabled = options.vibrateEnabled !== false;

    this.clock = options.clock ?? {
      now: () => Date.now(),
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (id) => globalThis.clearInterval(id),
    };

    this.audio = options.audio ?? new WebAudioBeeper();
    this.vibrateFn =
      typeof options.vibrate === "function"
        ? options.vibrate
        : (pattern) => {
            if (
              typeof globalThis.navigator !== "undefined" &&
              typeof globalThis.navigator.vibrate === "function"
            ) {
              try {
                return globalThis.navigator.vibrate(pattern);
              } catch {
                return false;
              }
            }
            return false;
          };

    this.wakeLockProvider =
      options.wakeLock !== undefined
        ? options.wakeLock
        : typeof globalThis.navigator !== "undefined" &&
            globalThis.navigator.wakeLock &&
            typeof globalThis.navigator.wakeLock.request === "function"
          ? globalThis.navigator.wakeLock
          : null;

    /** @type {Array<ReturnType<typeof expandPhases>[number]>} */
    this.steps = [];
    this.totalPlannedDurationMs = 0;

    /** @type {"idle" | "running" | "paused" | "done" | "interrupted"} */
    this.status = "idle";
    this.currentStepIndex = 0;
    this.phaseElapsedMs = 0;
    this.totalElapsedMs = 0;
    this.checkedSeconds = 0;
    this.lastTickAtMs = 0;
    this.intervalId = null;
    this.wakeLockSentinel = null;
    this.interruptReason = "";

    if (Array.isArray(options.phases) && options.phases.length > 0) {
      this.load(options.phases);
    }
  }

  /**
   * Charge une nouvelle liste de phases et réinitialise le minuteur.
   * @param {Array<Record<string, unknown>>} phases
   * @returns {Array<ReturnType<typeof expandPhases>[number]>}
   */
  load(phases) {
    this._clearInterval();
    this._releaseWakeLock();
    this.steps = expandPhases(phases);
    this.totalPlannedDurationMs = this.steps.reduce(
      (sum, step) => sum + step.durationMs,
      0
    );
    this.status = "idle";
    this.currentStepIndex = 0;
    this.phaseElapsedMs = 0;
    this.totalElapsedMs = 0;
    this.checkedSeconds = 0;
    this.lastTickAtMs = 0;
    this.interruptReason = "";
    this._emitStateChange();
    this._emitTick();
    return this.steps;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = Boolean(muted);
  }

  /** @param {boolean} enabled */
  setVibrateEnabled(enabled) {
    this.vibrateEnabled = Boolean(enabled);
  }

  /**
   * Démarre le minuteur (charge `phases` si fourni).
   * @param {Array<Record<string, unknown>>} [phases]
   * @returns {boolean}
   */
  start(phases) {
    if (Array.isArray(phases)) {
      this.load(phases);
    } else if (this.status === "done" || this.status === "interrupted") {
      this.currentStepIndex = 0;
      this.phaseElapsedMs = 0;
      this.totalElapsedMs = 0;
      this.checkedSeconds = 0;
      this.interruptReason = "";
    }

    if (this.steps.length === 0) {
      return false;
    }

    this._clearInterval();
    this.status = "running";
    this.lastTickAtMs = this.clock.now();

    this._acquireWakeLock();
    this._cue("start", [40]);
    this._emitStateChange();
    this._emitPhase();
    this._emitTick();

    this.intervalId = this.clock.setInterval(() => {
      this._onInterval();
    }, this.tickIntervalMs);

    return true;
  }

  /**
   * Met le minuteur en pause en conservant la progression exacte.
   * @returns {boolean}
   */
  pause() {
    if (this.status !== "running") {
      return false;
    }
    const now = this.clock.now();
    const deltaMs = Math.max(0, now - this.lastTickAtMs);
    this.lastTickAtMs = now;
    if (deltaMs > 0) {
      this._advance(deltaMs);
    }
    if (this.status !== "running") {
      return false;
    }

    this._clearInterval();
    this._releaseWakeLock();
    this.status = "paused";
    this._emitStateChange();
    this._emitTick();
    return true;
  }

  /**
   * Reprend après une pause.
   * @returns {boolean}
   */
  resume() {
    if (this.status !== "paused" || this.steps.length === 0) {
      return false;
    }
    this.status = "running";
    this.lastTickAtMs = this.clock.now();
    this._acquireWakeLock();
    this._cue("phase", [30]);
    this._emitStateChange();
    this._emitTick();

    this.intervalId = this.clock.setInterval(() => {
      this._onInterval();
    }, this.tickIntervalMs);

    return true;
  }

  /**
   * Bascule entre pause et reprise.
   * @returns {boolean}
   */
  togglePause() {
    if (this.status === "running") {
      return this.pause();
    }
    if (this.status === "paused") {
      return this.resume();
    }
    return false;
  }

  /**
   * Passe immédiatement à la phase suivante (ou termine si dernière phase).
   * @returns {boolean}
   */
  skip() {
    if (this.status !== "running" && this.status !== "paused") {
      return false;
    }

    if (this.status === "running") {
      const now = this.clock.now();
      const deltaMs = Math.max(0, now - this.lastTickAtMs);
      this.lastTickAtMs = now;
      this.totalElapsedMs += deltaMs;
    }

    this.phaseElapsedMs = 0;
    this.currentStepIndex += 1;

    if (this.currentStepIndex >= this.steps.length) {
      this._finish(true);
      return true;
    }

    this._cue("phase", [50, 40, 50]);
    this._emitPhase();
    this._emitTick();
    return true;
  }

  /**
   * Arrête et réinitialise le minuteur sans appeler `onDone`.
   */
  stop() {
    this._clearInterval();
    this._releaseWakeLock();
    this.status = "idle";
    this.currentStepIndex = 0;
    this.phaseElapsedMs = 0;
    this.totalElapsedMs = 0;
    this.checkedSeconds = 0;
    this.lastTickAtMs = 0;
    this.interruptReason = "";
    this._emitStateChange();
    this._emitTick();
  }

  /**
   * Libère les ressources (intervalle, Wake Lock, AudioContext).
   */
  destroy() {
    this.stop();
    if (this.audio && typeof this.audio.close === "function") {
      this.audio.close();
    }
  }

  /**
   * Retourne l'instantané courant du minuteur.
   * @returns {object}
   */
  getSnapshot() {
    const step = this.steps[this.currentStepIndex] ?? null;
    const phaseRemainingMs = step
      ? Math.max(0, step.durationMs - this.phaseElapsedMs)
      : 0;
    const remainingTotalMs = this._computeRemainingTotalMs();

    return {
      status: this.status,
      stepIndex: this.currentStepIndex,
      totalSteps: this.steps.length,
      phase: step,
      phaseLabel: step ? step.label : "",
      phaseDurationSec: step ? step.sec : 0,
      phaseElapsedSec: Math.floor(this.phaseElapsedMs / 1000),
      phaseRemainingSec: Math.ceil(phaseRemainingMs / 1000),
      phaseRemainingMs,
      phaseProgress: step
        ? Math.min(1, Math.max(0, this.phaseElapsedMs / step.durationMs))
        : 0,
      totalElapsedSec: Math.floor(this.totalElapsedMs / 1000),
      totalElapsedMs: this.totalElapsedMs,
      totalRemainingSec: Math.ceil(remainingTotalMs / 1000),
      totalPlannedSec: Math.round(this.totalPlannedDurationMs / 1000),
      interruptReason: this.interruptReason,
    };
  }

  /** @private */
  _onInterval() {
    if (this.status !== "running") {
      return;
    }
    const now = this.clock.now();
    const deltaMs = Math.max(0, now - this.lastTickAtMs);
    this.lastTickAtMs = now;
    this._advance(deltaMs);
  }

  /**
   * Avance le temps de `deltaMs`, exécute les vérifications de sécurité par seconde
   * et gère les transitions multi-phases.
   * @param {number} deltaMs
   * @private
   */
  _advance(deltaMs) {
    if (this.status !== "running" || deltaMs <= 0) {
      return;
    }

    const previousWholeSec = Math.floor(this.totalElapsedMs / 1000);
    const nextTotalElapsedMs = this.totalElapsedMs + deltaMs;
    const nextWholeSec = Math.floor(nextTotalElapsedMs / 1000);

    // Contrôle de sécurité appelé exactement une fois par seconde franchie (ex. SpO₂)
    if (this.onSafetyCheck && nextWholeSec > previousWholeSec) {
      for (let sec = previousWholeSec + 1; sec <= nextWholeSec; sec += 1) {
        this.checkedSeconds = sec;
        const snapshot = {
          ...this.getSnapshot(),
          totalElapsedSec: sec,
        };
        let checkResult;
        try {
          checkResult = this.onSafetyCheck(snapshot);
        } catch (err) {
          const msg =
            err instanceof Error && err.message
              ? err.message
              : "Erreur critique de contrôle sécurité.";
          this._interrupt(msg);
          return;
        }

        if (checkResult && typeof /** @type {any} */ (checkResult).then === "function") {
          /** @type {Promise<unknown>} */ (checkResult)
            .then((resolved) => {
              if (this.status !== "running") return;
              const verdict = parseSafetyResult(resolved);
              if (!verdict.ok) {
                this._interrupt(verdict.reason);
              }
            })
            .catch(() => {
              if (this.status === "running") {
                this._interrupt("safety_check_error");
              }
            });
        } else {
          const verdict = parseSafetyResult(checkResult);
          if (!verdict.ok) {
            this._interrupt(verdict.reason);
            return;
          }
        }
      }
    }

    this.totalElapsedMs = nextTotalElapsedMs;
    this.phaseElapsedMs += deltaMs;

    let transitioned = false;
    while (
      this.currentStepIndex < this.steps.length &&
      this.phaseElapsedMs >= this.steps[this.currentStepIndex].durationMs
    ) {
      this.phaseElapsedMs -= this.steps[this.currentStepIndex].durationMs;
      this.currentStepIndex += 1;
      transitioned = true;
    }

    if (this.currentStepIndex >= this.steps.length) {
      this.phaseElapsedMs = 0;
      this._finish(false);
      return;
    }

    if (transitioned) {
      this._cue("phase", [60, 40, 60]);
      this._emitPhase();
    }

    this._emitTick();
  }

  /**
   * Interrompt le minuteur suite à un échec `onSafetyCheck`.
   * @param {string} reason
   * @private
   */
  _interrupt(reason) {
    this._clearInterval();
    this._releaseWakeLock();
    this.status = "interrupted";
    this.interruptReason = reason;
    this._cue("alert", [250, 100, 250, 100, 350]);
    this._emitStateChange();
    this._emitTick();
    if (this.onDone) {
      this.onDone({
        completed: false,
        interrupted: true,
        skippedLast: false,
        reason,
        elapsedSec: Math.floor(this.totalElapsedMs / 1000),
        totalElapsedMs: this.totalElapsedMs,
        stepIndex: this.currentStepIndex,
        totalSteps: this.steps.length,
        phase: this.steps[this.currentStepIndex] ?? null,
      });
    }
  }

  /**
   * Termine normalement la séance.
   * @param {boolean} skippedLast
   * @private
   */
  _finish(skippedLast) {
    this._clearInterval();
    this._releaseWakeLock();
    this.status = "done";
    this.currentStepIndex = Math.max(0, this.steps.length - 1);
    this._cue("done", [100, 60, 160]);
    this._emitStateChange();
    this._emitTick();
    if (this.onDone) {
      this.onDone({
        completed: true,
        interrupted: false,
        skippedLast,
        reason: "",
        elapsedSec: Math.floor(this.totalElapsedMs / 1000),
        totalElapsedMs: this.totalElapsedMs,
        stepIndex: this.steps.length - 1,
        totalSteps: this.steps.length,
        phase: this.steps[this.steps.length - 1] ?? null,
      });
    }
  }

  /** @private */
  _computeRemainingTotalMs() {
    if (this.steps.length === 0 || this.status === "done") {
      return 0;
    }
    const current = this.steps[this.currentStepIndex];
    if (!current) {
      return 0;
    }
    let remaining = Math.max(0, current.durationMs - this.phaseElapsedMs);
    for (let i = this.currentStepIndex + 1; i < this.steps.length; i += 1) {
      remaining += this.steps[i].durationMs;
    }
    return remaining;
  }

  /**
   * @param {"start" | "phase" | "warning" | "alert" | "done"} kind
   * @param {number[]} vibratePattern
   * @private
   */
  _cue(kind, vibratePattern) {
    if (!this.muted && this.audio && typeof this.audio.play === "function") {
      this.audio.play(kind);
    }
    if (this.vibrateEnabled && this.vibrateFn) {
      this.vibrateFn(vibratePattern);
    }
  }

  /** @private */
  _clearInterval() {
    if (this.intervalId !== null) {
      this.clock.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** @private */
  _acquireWakeLock() {
    if (!this.wakeLockProvider || this.wakeLockSentinel) {
      return;
    }
    try {
      const req = this.wakeLockProvider.request("screen");
      if (req && typeof req.then === "function") {
        req
          .then((sentinel) => {
            if (this.status === "running") {
              this.wakeLockSentinel = sentinel;
            } else if (sentinel && typeof sentinel.release === "function") {
              sentinel.release().catch(() => {});
            }
          })
          .catch(() => {});
      }
    } catch {
      // Wake Lock non supporté ou refusé
    }
  }

  /** @private */
  _releaseWakeLock() {
    if (
      this.wakeLockSentinel &&
      typeof this.wakeLockSentinel.release === "function"
    ) {
      this.wakeLockSentinel.release().catch(() => {});
    }
    this.wakeLockSentinel = null;
  }

  /** @private */
  _emitTick() {
    if (this.onTick) {
      this.onTick(this.getSnapshot());
    }
  }

  /** @private */
  _emitPhase() {
    if (this.onPhase) {
      const step = this.steps[this.currentStepIndex] ?? null;
      if (step) {
        this.onPhase({
          ...step,
          snapshot: this.getSnapshot(),
        });
      }
    }
  }

  /** @private */
  _emitStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        status: this.status,
        stepIndex: this.currentStepIndex,
        totalSteps: this.steps.length,
        interruptReason: this.interruptReason,
      });
    }
  }
}
