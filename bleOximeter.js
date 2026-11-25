/**
 * Client Web Bluetooth optionnel et non bloquant pour oxymètre de pouls (GATT 0x1822)
 * et capteur de fréquence cardiaque (GATT 0x180D).
 * Zéro dépendance externe — ES2024+ compatible Navigateur et tests Node.js.
 */

export const PLX_SERVICE_UUID = 0x1822;
export const PLX_SPOT_CHECK_CHAR_UUID = 0x2a5e;
export const PLX_CONTINUOUS_CHAR_UUID = 0x2a5f;

export const HR_SERVICE_UUID = 0x180d;
export const HR_MEASUREMENT_CHAR_UUID = 0x2a37;

/**
 * Vérifie si Web Bluetooth est disponible dans l'environnement courant.
 * @param {Navigator | Record<string, any> | undefined} [navigatorRef]
 * @returns {boolean}
 */
export function isWebBluetoothSupported(navigatorRef = globalThis.navigator) {
  return Boolean(
    navigatorRef &&
      navigatorRef.bluetooth &&
      typeof navigatorRef.bluetooth.requestDevice === "function"
  );
}

/**
 * Décode un flottant court IEEE-11073 16 bits (SFLOAT, little-endian).
 * @param {number} rawUint16
 * @returns {number} Valeur décodée ou `NaN` si valeur réservée.
 */
export function decodeSfloat16(rawUint16) {
  const raw = rawUint16 & 0xffff;
  if (raw === 0x07ff || raw === 0x0800 || raw === 0x0801) {
    return Number.NaN;
  }
  if (raw === 0x07fe) {
    return Number.POSITIVE_INFINITY;
  }
  if (raw === 0x0802) {
    return Number.NEGATIVE_INFINITY;
  }

  let exponent = (raw >> 12) & 0x0f;
  if (exponent >= 8) {
    exponent -= 16;
  }

  let mantissa = raw & 0x0fff;
  if (mantissa >= 0x0800) {
    mantissa -= 0x1000;
  }

  return mantissa * Math.pow(10, exponent);
}

/**
 * Normalise une valeur DataView / ArrayBuffer / TypedArray en DataView.
 * @param {DataView | ArrayBuffer | ArrayBufferView | null | undefined} value
 * @returns {DataView | null}
 */
function toDataView(value) {
  if (!value) return null;
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (ArrayBuffer.isView(value)) {
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Décode une mesure Pulse Oximeter (`0x2A5F` Continuous ou `0x2A5E` Spot-Check).
 * Prend en charge SFLOAT IEEE-11073 standard ainsi que le format octet simplifié.
 * @param {DataView | ArrayBuffer | ArrayBufferView} rawValue
 * @returns {{ spo2: number | null, hr: number | null }}
 */
export function parsePlxMeasurement(rawValue) {
  const view = toDataView(rawValue);
  if (!view || view.byteLength === 0) {
    return { spo2: null, hr: null };
  }

  // Format simplifié 1 octet : SpO2 directe
  if (view.byteLength === 1) {
    const byteSpo2 = view.getUint8(0);
    return {
      spo2: byteSpo2 >= 50 && byteSpo2 <= 100 ? byteSpo2 : null,
      hr: null,
    };
  }

  // Format standard GATT PLX : byte 0 = flags, bytes 1..2 = SpO2 (SFLOAT), bytes 3..4 = PR (SFLOAT)
  let spo2 = null;
  let hr = null;

  if (view.byteLength >= 3) {
    const sfloatSpo2 = decodeSfloat16(view.getUint16(1, true));
    if (Number.isFinite(sfloatSpo2) && sfloatSpo2 >= 50 && sfloatSpo2 <= 100) {
      spo2 = Math.round(sfloatSpo2);
    } else {
      // Repli octet standard si l'appareil émet un octet brut à l'offset 1
      const byteSpo2 = view.getUint8(1);
      if (byteSpo2 >= 50 && byteSpo2 <= 100) {
        spo2 = byteSpo2;
      }
    }
  }

  if (view.byteLength >= 5) {
    const sfloatHr = decodeSfloat16(view.getUint16(3, true));
    if (Number.isFinite(sfloatHr) && sfloatHr >= 25 && sfloatHr <= 250) {
      hr = Math.round(sfloatHr);
    }
  } else if (view.byteLength === 3) {
    const byteHr = view.getUint8(2);
    if (byteHr >= 25 && byteHr <= 250) {
      hr = byteHr;
    }
  }

  return { spo2, hr };
}

/**
 * Décode une mesure Heart Rate (`0x2A37`).
 * @param {DataView | ArrayBuffer | ArrayBufferView} rawValue
 * @returns {{ hr: number | null }}
 */
export function parseHeartRateMeasurement(rawValue) {
  const view = toDataView(rawValue);
  if (!view || view.byteLength < 2) {
    return { hr: null };
  }
  const flags = view.getUint8(0);
  const isUint16 = (flags & 0x01) !== 0;
  const rawHr =
    isUint16 && view.byteLength >= 3
      ? view.getUint16(1, true)
      : view.getUint8(1);

  return {
    hr: Number.isFinite(rawHr) && rawHr >= 25 && rawHr <= 250 ? rawHr : null,
  };
}

/**
 * Crée un contrôleur BLE optionnel et non bloquant pour oxymètre / cardiofréquencemètre.
 * @param {object} [options]
 * @param {(reading: { spo2: number | null, hr: number | null, timestampMs: number, source: "ble" }) => void} [options.onReading]
 * @param {(status: { state: "unsupported" | "disconnected" | "connecting" | "connected", deviceName: string, message: string }) => void} [options.onStatusChange]
 * @param {(error: { reason: string, message: string }) => void} [options.onError]
 * @param {Navigator | Record<string, any>} [options.navigatorRef]
 */
export function createBleOximeter(options = {}) {
  const onReading = typeof options.onReading === "function" ? options.onReading : null;
  const onStatusChange =
    typeof options.onStatusChange === "function" ? options.onStatusChange : null;
  const onError = typeof options.onError === "function" ? options.onError : null;
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;

  /** @type {"unsupported" | "disconnected" | "connecting" | "connected"} */
  let state = isWebBluetoothSupported(navigatorRef)
    ? "disconnected"
    : "unsupported";
  let device = null;
  let deviceName = "";
  let lastReading = { spo2: null, hr: null, timestampMs: null };
  /** @type {Array<{ char: any, handler: (e: any) => void }>} */
  const subscriptions = [];

  function emitStatus(nextState, message) {
    state = nextState;
    onStatusChange?.({
      state: nextState,
      deviceName,
      message,
    });
  }

  function handleDisconnectEvent() {
    cleanupSubscriptions();
    emitStatus("disconnected", "Oxymètre BLE déconnecté — saisie manuelle active.");
  }

  function cleanupSubscriptions() {
    for (const sub of subscriptions.splice(0, subscriptions.length)) {
      try {
        sub.char?.removeEventListener?.("characteristicvaluechanged", sub.handler);
        sub.char?.stopNotifications?.().catch?.(() => {});
      } catch {
        // Ignorer les erreurs de nettoyage après déconnexion GATT
      }
    }
  }

  async function subscribeCharacteristic(service, uuid, parser) {
    try {
      const char = await service.getCharacteristic(uuid);
      if (!char) return false;
      const handler = (event) => {
        const value = event?.target?.value;
        const parsed = parser(value);
        if (parsed.spo2 !== null || parsed.hr !== null) {
          const ts = Date.now();
          lastReading = {
            spo2: parsed.spo2 ?? lastReading.spo2,
            hr: parsed.hr ?? lastReading.hr,
            timestampMs: ts,
          };
          onReading?.({
            spo2: parsed.spo2 ?? null,
            hr: parsed.hr ?? null,
            timestampMs: ts,
            source: "ble",
          });
        }
      };

      if (typeof char.startNotifications === "function") {
        char.addEventListener?.("characteristicvaluechanged", handler);
        await char.startNotifications();
        subscriptions.push({ char, handler });
        return true;
      }
      if (typeof char.readValue === "function") {
        const val = await char.readValue();
        handler({ target: { value: val } });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Lance la demande de périphérique Web Bluetooth sans jamais bloquer la saisie manuelle.
   * @returns {Promise<{ ok: boolean, reason?: string, deviceName?: string, message: string }>}
   */
  async function connect() {
    if (!isWebBluetoothSupported(navigatorRef)) {
      const msg =
        "Web Bluetooth non supporté sur ce navigateur — utilisez la saisie manuelle SpO₂.";
      emitStatus("unsupported", msg);
      onError?.({ reason: "unsupported", message: msg });
      return { ok: false, reason: "unsupported", message: msg };
    }

    emitStatus("connecting", "Sélection de l'oxymètre BLE...");

    try {
      const selected = await navigatorRef.bluetooth.requestDevice({
        filters: [{ services: [PLX_SERVICE_UUID] }, { services: [HR_SERVICE_UUID] }],
        optionalServices: [PLX_SERVICE_UUID, HR_SERVICE_UUID],
      });

      if (!selected) {
        emitStatus("disconnected", "Connexion Bluetooth annulée.");
        return {
          ok: false,
          reason: "cancelled",
          message: "Connexion Bluetooth annulée.",
        };
      }

      device = selected;
      deviceName = String(selected.name || "Oxymètre BLE");
      selected.removeEventListener?.("gattserverdisconnected", handleDisconnectEvent);
      selected.addEventListener?.("gattserverdisconnected", handleDisconnectEvent);

      const server = await selected.gatt?.connect?.();
      if (!server) {
        const msg = "Serveur GATT indisponible sur cet appareil.";
        emitStatus("disconnected", msg);
        onError?.({ reason: "gatt_unavailable", message: msg });
        return { ok: false, reason: "gatt_unavailable", message: msg };
      }

      let hasActiveStream = false;

      try {
        const plxService = await server.getPrimaryService(PLX_SERVICE_UUID);
        if (plxService) {
          const contOk = await subscribeCharacteristic(
            plxService,
            PLX_CONTINUOUS_CHAR_UUID,
            parsePlxMeasurement
          );
          const spotOk = await subscribeCharacteristic(
            plxService,
            PLX_SPOT_CHECK_CHAR_UUID,
            parsePlxMeasurement
          );
          hasActiveStream = contOk || spotOk;
        }
      } catch {
        // Service Pulse Oximeter absent (ex. ceinture HR uniquement)
      }

      try {
        const hrService = await server.getPrimaryService(HR_SERVICE_UUID);
        if (hrService) {
          const hrOk = await subscribeCharacteristic(
            hrService,
            HR_MEASUREMENT_CHAR_UUID,
            (val) => ({ spo2: null, ...parseHeartRateMeasurement(val) })
          );
          hasActiveStream = hasActiveStream || hrOk;
        }
      } catch {
        // Service Heart Rate absent
      }

      if (!hasActiveStream) {
        const msg = `Connecté à ${deviceName}, mais aucune caractéristique SpO₂/FC standard (0x2A5F/0x2A5E/0x2A37) trouvée — saisie manuelle active.`;
        emitStatus("connected", msg);
        return { ok: true, deviceName, message: msg };
      }

      const msg = `Connecté à ${deviceName}`;
      emitStatus("connected", msg);
      return { ok: true, deviceName, message: msg };
    } catch (err) {
      const errName = err instanceof Error ? err.name : "";
      if (errName === "NotFoundError" || errName === "AbortError") {
        const msg = "Sélection Bluetooth annulée — saisie manuelle active.";
        emitStatus("disconnected", msg);
        return { ok: false, reason: "cancelled", message: msg };
      }
      const msg =
        err instanceof Error && err.message
          ? `Erreur BLE : ${err.message}`
          : "Impossible de connecter l'oxymètre BLE — saisie manuelle active.";
      emitStatus("disconnected", msg);
      onError?.({ reason: "ble_error", message: msg });
      return { ok: false, reason: "ble_error", message: msg };
    }
  }

  function disconnect() {
    cleanupSubscriptions();
    if (device) {
      try {
        device.removeEventListener?.("gattserverdisconnected", handleDisconnectEvent);
        if (device.gatt?.connected) {
          device.gatt.disconnect();
        }
      } catch {
        // Ignorer lors de la fermeture
      }
    }
    device = null;
    deviceName = "";
    emitStatus("disconnected", "Oxymètre BLE déconnecté.");
  }

  return {
    connect,
    disconnect,
    getStatus: () => state,
    getDeviceName: () => deviceName,
    getLastReading: () => ({ ...lastReading }),
    isSupported: () => isWebBluetoothSupported(navigatorRef),
  };
}
