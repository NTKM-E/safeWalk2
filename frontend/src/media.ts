// Photo and location helpers for reporting.

const MAX_PHOTO_SIZE = 800;
export const MAX_GPS_ERROR_M = 100;

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;   // meters
  timestamp: number;  // ms since epoch
}

const FRESH_FIX_MS = 60_000;

export function isFresh(p: Position | null): p is Position {
  return Boolean(p && Date.now() - p.timestamp < FRESH_FIX_MS);
}

/** Shrink an uploaded image to a JPEG no larger than MAX_PHOTO_SIZE on its long side. */
export async function resizeImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return drawToJpeg(bitmap, bitmap.width, bitmap.height);
}

export function drawToJpeg(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, MAX_PHOTO_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the image."))),
      "image/jpeg",
      0.8,
    );
  });
}

/** A one-off fix, used only when the app isn't already tracking the user's position. */
export function getPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("location isn't available in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(toPosition(p)),
      (err) => reject(new Error(err.message || "location permission denied")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 },
    );
  });
}

export function toPosition(p: GeolocationPosition): Position {
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp };
}
