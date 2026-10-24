// Per-device ID (no accounts): one verification answer per device per report.

export const DEVICE_ID = getDeviceId();

function getDeviceId(): string {
  try {
    let id = localStorage.getItem("safewalk-device-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("safewalk-device-id", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Reports this device has already been asked about, so we don't ask twice.
export function loadAskedIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("safewalk-asked") ?? "[]"));
  } catch {
    return new Set();
  }
}

export function saveAskedIds(ids: Set<string>): void {
  try {
    localStorage.setItem("safewalk-asked", JSON.stringify([...ids]));
  } catch { /* storage unavailable */ }
}
