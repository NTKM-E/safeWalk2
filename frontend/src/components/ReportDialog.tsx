// Report a hazard: take or upload a photo, let the AI suggest a type, confirm, save.
// Live camera photos are placed at the user's GPS position; uploaded photos (or
// live ones without a good GPS fix) are placed by clicking the map afterwards.
import { useEffect, useRef, useState } from "react";
import { api, type AiSuggestion, type Report } from "../api";
import { DEVICE_ID } from "../device";
import type { LngLat } from "../api";
import { MAX_GPS_ERROR_M, drawToJpeg, getPosition, isFresh, resizeImage, type Position } from "../media";
import { REPORT_TYPES, isReportType, type ReportType } from "../reportTypes";

export interface PendingReport {
  photo: Blob;
  livePhoto: boolean;
  type: ReportType;
  notes: string;
  ai: AiSuggestion | null;
  near: LngLat | null;  // rough location to zoom the map to while the user places it
}

interface Props {
  visionEnabled: boolean;
  currentPosition: Position | null;  // the position the app is already tracking
  onClose: () => void;
  onSaved: (report: Report) => void;
  onPlaceOnMap: (pending: PendingReport) => void;
}

interface Draft {
  blob: Blob;
  url: string;
  live: boolean;
}

export default function ReportDialog({ visionEnabled, currentPosition, onClose, onSaved, onPlaceOnMap }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const positionRef = useRef<Promise<Position> | null>(null);
  const latestPosition = useRef(currentPosition);
  latestPosition.current = currentPosition;

  const [cameraOn, setCameraOn] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ai, setAi] = useState<AiSuggestion | null>(null);
  const [aiText, setAiText] = useState(visionEnabled ? "" : "AI suggestions are off (no Gemini API key on the server). Pick the type yourself.");
  const [type, setType] = useState<ReportType>("other");
  const [notes, setNotes] = useState("");
  const [locationText, setLocationText] = useState("");
  const [fix, setFix] = useState<Position | null>(null);
  const [needsMap, setNeedsMap] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => stopCamera();
  }, []);

  useEffect(() => () => { if (draft) URL.revokeObjectURL(draft.url); }, [draft]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  // ---------- Option A: live camera photo ----------
  async function startCamera() {
    setError("");
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (err) {
      setError(`Couldn't open the camera (${(err as Error).message}). You can upload a photo instead.`);
      return;
    }
    setCameraOn(true);
    // If the app isn't tracking the user yet, start locating now so a fix is ready by the snap.
    positionRef.current = isFresh(latestPosition.current) ? null : getPosition();
    positionRef.current?.catch(() => {});
  }

  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
  }, [cameraOn]);

  async function snap() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const blob = await drawToJpeg(video, video.videoWidth, video.videoHeight);
    stopCamera();
    setPhoto(blob, true);
    setLocationText("📍 Getting your location…");
    let pos: Position | null = null;
    try {
      // Prefer the tracked position at the moment of the snap; fall back to the one-off fix.
      pos = isFresh(latestPosition.current) ? latestPosition.current : await positionRef.current!;
    } catch (err) {
      setLocationText(`Couldn't get your location (${(err as Error).message}). You'll mark the spot on the map instead.`);
    }
    setFix(pos);
    if (!pos) {
      setNeedsMap(true);
    } else if (pos.accuracy <= MAX_GPS_ERROR_M) {
      setLocationText(`📍 Will be marked at your current location (±${Math.round(pos.accuracy)} m).`);
      setNeedsMap(false);
    } else {
      setLocationText(
        `📍 Your location is only accurate to ±${Math.round(pos.accuracy)} m, so the map will zoom to where you are ` +
        `and you'll tap the exact spot.`,
      );
      setNeedsMap(true);
    }
  }

  // ---------- Option B: upload a photo ----------
  async function onFile(file: File | undefined) {
    if (!file) return;
    stopCamera();
    try {
      setPhoto(await resizeImage(file), false);
      positionRef.current = null;
      setFix(null);
      setNeedsMap(true);
      setLocationText("After this step, click the map where the photo was taken.");
    } catch {
      setError("That file could not be read as an image.");
    }
  }

  function setPhoto(blob: Blob, live: boolean) {
    setDraft({ blob, url: URL.createObjectURL(blob), live });
    setError("");
    setAi(null);
    suggestType(blob);
  }

  async function suggestType(blob: Blob) {
    if (!visionEnabled) return;
    setAiText("🤖 Looking at the photo…");
    try {
      const result = await api.classify(blob);
      setAi(result);
      if (result.type === "none") {
        setAiText(`🤖 No hazard spotted: ${result.description} Pick a type yourself if there is one.`);
        return;
      }
      if (isReportType(result.type)) setType(result.type);
      const t = isReportType(result.type) ? REPORT_TYPES[result.type] : null;
      setAiText(
        `🤖 Looks like ${t?.emoji ?? ""} ${t?.label ?? result.type} (${Math.round(result.confidence * 100)}% sure): ` +
        `${result.description} Change the type if this is wrong.`,
      );
    } catch (err) {
      setAiText(`🤖 AI suggestion unavailable: ${(err as Error).message}`);
    }
  }

  // ---------- Save ----------
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const pending: PendingReport = {
      photo: draft.blob, livePhoto: draft.live, type, notes: notes.trim(), ai,
      near: draft.live && fix ? [fix.lng, fix.lat] : null,
    };
    setError("");

    if (draft.live && fix && !needsMap) {
      setSaving(true);
      try {
        const report = await api.createReport({ ...pending, lat: fix.lat, lng: fix.lng, deviceId: DEVICE_ID });
        onSaved(report);
        close();
      } catch (err) {
        setError(`Couldn't save the report: ${(err as Error).message}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    close();
    onPlaceOnMap(pending);
  }

  function close() {
    stopCamera();
    dialogRef.current?.close();
  }

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Report a hazard</h2>
        <p className="muted">Broken streetlight, damaged sidewalk, blocked path… Your report updates route scores for everyone.</p>

        {!cameraOn && (
          <div className="button-row">
            <button type="button" className="btn" onClick={startCamera} disabled={!hasCamera}
              title={hasCamera ? "" : "The camera needs an https:// page (or localhost)."}>
              📷 Take photo
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>🖼 Upload photo</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />

        {cameraOn && (
          <div className="camera">
            <video ref={videoRef} autoPlay playsInline muted />
            <button type="button" className="btn btn-primary" onClick={snap}>Snap photo</button>
          </div>
        )}
        {draft && !cameraOn && <img className="photo-preview" src={draft.url} alt="Photo preview" />}
        {aiText && <p className="ai-text">{aiText}</p>}

        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as ReportType)}>
            {Object.entries(REPORT_TYPES).map(([key, t]) => (
              <option key={key} value={key}>{t.emoji} {t.label}</option>
            ))}
          </select>
        </label>
        <label>
          Notes (optional)
          <textarea rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {locationText && <p className="muted">{locationText}</p>}
        {error && <p className="error">{error}</p>}

        <div className="button-row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!draft || saving}>
            {saving ? "Saving…" : needsMap ? "Next: mark on map" : "Save report"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
