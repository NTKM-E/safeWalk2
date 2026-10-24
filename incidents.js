// incidents.js: full SafeWalk incident pipeline.
//   • Report incidents with camera or uploaded photo (live GPS or map-click location)
//   • AI photo classification via vision.js (Gemini)
//   • Verification system: other users confirm / deny each report
//   • Safety-level classification for route scoring
//   • Dynamic route scoring: incident penalties affect which routes are recommended
//
// Load order in index.html: config.js → vision.js → app.js → incidents.js → crimes.js → avoid.js

// ---------- 1. Incident types, severity, and scoring defaults ----------
// "severity" mirrors the constants.py design from safewalk-dynamic-routing:
//   the higher the number, the more a verified fresh report penalises a route.
// "halfLifeHours": how quickly a report's influence fades (exponential decay).
// "nightMultiplier": extra weight applied when night mode is on.
// "safetyLevel": human-readable risk classification shown in the UI.
const INCIDENT_TYPES = {
  obstruction: {
    label: "Obstruction",
    emoji: "⛔",
    severity: 9.0,
    halfLifeHours: 24,
    nightMultiplier: 1.0,
    safetyLevel: "high",
    safetyLabel: "🔴 High Risk",
  },
  pedestrian_signal_issue: {
    label: "Pedestrian signal issue",
    emoji: "🚦",
    severity: 7.0,
    halfLifeHours: 48,
    nightMultiplier: 1.2,
    safetyLevel: "high",
    safetyLabel: "🔴 High Risk",
  },
  construction: {
    label: "Construction",
    emoji: "🚧",
    severity: 6.0,
    halfLifeHours: 48,
    nightMultiplier: 1.0,
    safetyLevel: "medium",
    safetyLabel: "🟠 Medium Risk",
  },
  lighting: {
    label: "Lighting issue",
    emoji: "💡",
    severity: 6.0,
    halfLifeHours: 168,
    nightMultiplier: 1.8,
    safetyLevel: "medium",
    safetyLabel: "🟠 Medium Risk",
  },
  unpaved_surface: {
    label: "Unpaved surface",
    emoji: "🪨",
    severity: 3.0,
    halfLifeHours: 336,
    nightMultiplier: 1.0,
    safetyLevel: "low",
    safetyLabel: "🟡 Low Risk",
  },
  trash: {
    label: "Trash / debris",
    emoji: "🗑️",
    severity: 2.0,
    halfLifeHours: 48,
    nightMultiplier: 1.0,
    safetyLevel: "low",
    safetyLabel: "🟡 Low Risk",
  },
  other: {
    label: "Other",
    emoji: "❓",
    severity: 2.0,
    halfLifeHours: 48,
    nightMultiplier: 1.0,
    safetyLevel: "low",
    safetyLabel: "🟡 Low Risk",
  },
};

// ---------- 2. Scoring constants ----------
// How many "equivalent walking meters" each penalty point adds to a route.
// These are preference-mode weights used when re-ranking Valhalla routes.
const PREFERENCE_WEIGHTS = {
  time: 5.0,   // almost ignore reports – just go fast
  balanced: 25.0,  // default: noticeable detour for medium issues
  safety: 50.0,  // strong avoidance of any reported hazard
};

// Beta(1,1) Bayesian confidence: prevents a single vote from creating certainty.
function confidenceFromVotes(confirmations, denials) {
  return (1.0 + confirmations) / (2.0 + confirmations + denials);
}

// Exponential freshness decay: 1.0 when new, 0.5 after halfLifeHours, etc.
function freshness(createdAt, halfLifeHours) {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageHours = ageMs / 3_600_000;
  return Math.pow(2, -ageHours / halfLifeHours);
}

// Per-incident penalty (used in route scoring).
// penalty = severity × nightMultiplier × confidence × freshness
function incidentPenalty(incident, isNight) {
  const t = INCIDENT_TYPES[incident.type];
  if (!t || incident.status === "resolved") return 0;
  const nightMul = isNight ? t.nightMultiplier : 1.0;
  const conf = confidenceFromVotes(incident.confirmCount || 0, incident.denyCount || 0);
  const fresh = freshness(incident.createdAt, t.halfLifeHours);
  return t.severity * nightMul * conf * fresh;
}

// ---------- 3. Settings ----------
const NEARBY_METERS = 40;
const MAX_GPS_ERROR_METERS = 100;
const REFRESH_MS = 60 * 1000;
const DEMO_MODE = new URLSearchParams(window.location.search).has("demo");

// ---------- 4. Database connection ----------
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const PHOTO_BUCKET = "incident-photos";

// ---------- 5. Per-device ID (no accounts; one answer per device per incident) ----------
const DEVICE_ID = getDeviceId();

function getDeviceId() {
  try {
    let id = localStorage.getItem("safewalk-device-id");
    if (!id) {
      id = newId();
      localStorage.setItem("safewalk-device-id", id);
    }
    return id;
  } catch {
    return newId();
  }
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// ---------- 6. State ----------
// incidents: objects in memory matching what is in the database
// {id, lat, lng, type, value, notes, photo, createdAt, status, confirmCount, denyCount,
//  reporterId, livePhoto, marker}
const incidents = [];
let draft = null;
let placingReport = null;
let cameraStream = null;
let livePositionPromise = null;
let previewUrl = null;
let statusBeforeReport = "";

let userPosition = null;
let simulatedPosition = null;
let userDot = null;
let verifyQueue = [];
let verifying = null;
const askedIds = loadAskedIds();

// ---------- 7. Grab page elements ----------
const reportBtn = document.getElementById("report-btn");
const countEl = document.getElementById("incident-count");
const dialog = document.getElementById("report-dialog");
const form = document.getElementById("report-form");
const sourceBox = document.getElementById("photo-source");
const takePhotoBtn = document.getElementById("take-photo");
const uploadPhotoBtn = document.getElementById("upload-photo");
const photoInput = document.getElementById("report-photo");
const cameraBox = document.getElementById("camera");
const cameraVideo = document.getElementById("camera-video");
const snapBtn = document.getElementById("snap");
const photoPreview = document.getElementById("photo-preview");
const aiText = document.getElementById("ai-suggestion");
const typeSelect = document.getElementById("report-type");
const notesInput = document.getElementById("report-notes");
const locationText = document.getElementById("report-location");
const cancelBtn = document.getElementById("report-cancel");
const formError = document.getElementById("report-error");
const saveBtn = document.getElementById("report-save");

const verifyDialog = document.getElementById("verify-dialog");
const verifyPhoto = document.getElementById("verify-photo");
const verifyText = document.getElementById("verify-text");

// Fill the type dropdown from INCIDENT_TYPES
for (const [key, t] of Object.entries(INCIDENT_TYPES)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = `${t.emoji} ${t.label} — ${t.safetyLabel}`;
  typeSelect.appendChild(option);
}

// ---------- 8. Open the report form ----------
reportBtn.addEventListener("click", () => {
  if (appMode === "report") stopPlacing();
  else openReportDialog();
});

function openReportDialog() {
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  takePhotoBtn.disabled = !hasCamera;
  locationText.textContent = hasCamera ? "" : "The camera needs an https:// page (or localhost).";
  aiText.textContent = visionEnabled()
    ? ""
    : "Tip: add GEMINI_KEY to config.js for automatic type suggestions.";
  dialog.showModal();
}

cancelBtn.addEventListener("click", () => dialog.close());

dialog.addEventListener("close", () => {
  stopCamera();
  form.reset();
  draft = null;
  livePositionPromise = null;
  photoPreview.hidden = true;
  cameraBox.hidden = true;
  sourceBox.hidden = false;
  aiText.textContent = "";
  locationText.textContent = "";
  formError.textContent = "";
  saveBtn.disabled = true;
  saveBtn.textContent = "Save incident";
  showNextVerify();
});

// ---------- 9. Option A: live camera photo ----------
takePhotoBtn.addEventListener("click", async () => {
  formError.textContent = "";
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (err) {
    formError.textContent = `Couldn't open the camera (${err.message}). You can upload a photo instead.`;
    return;
  }
  cameraVideo.srcObject = cameraStream;
  cameraBox.hidden = false;
  sourceBox.hidden = true;
  photoPreview.hidden = true;
  livePositionPromise = getPosition();
  livePositionPromise.catch(() => { });
});

snapBtn.addEventListener("click", async () => {
  if (!cameraVideo.videoWidth) return;
  const blob = await drawToJpeg(cameraVideo, cameraVideo.videoWidth, cameraVideo.videoHeight, 800);
  stopCamera();
  cameraBox.hidden = true;
  sourceBox.hidden = false;
  setDraftPhoto(blob, true);

  locationText.textContent = "📍 Getting your location...";
  try {
    const pos = await livePositionPromise;
    if (draft?.blob !== blob) return;
    locationText.textContent = `📍 Will be marked at your current location (±${Math.round(pos.accuracy)} m).`;
  } catch (err) {
    if (draft?.blob !== blob) return;
    locationText.textContent = `Couldn't get your location (${err.message}). You'll mark the spot on the map instead.`;
    saveBtn.textContent = "Next: mark on map";
  }
});

function stopCamera() {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
}

// ---------- 10. Option B: upload photo ----------
uploadPhotoBtn.addEventListener("click", () => photoInput.click());

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  stopCamera();
  cameraBox.hidden = true;
  sourceBox.hidden = false;
  try {
    setDraftPhoto(await resizeImage(file, 800), false);
    locationText.textContent = "After this step, click the map where the photo was taken.";
    saveBtn.textContent = "Next: mark on map";
  } catch (err) {
    console.error(err);
    formError.textContent = "That file could not be read as an image.";
  }
});

function setDraftPhoto(blob, live) {
  draft = { blob, live, ai: null };
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  photoPreview.src = previewUrl;
  photoPreview.hidden = false;
  formError.textContent = "";
  saveBtn.disabled = false;
  saveBtn.textContent = "Save incident";
  suggestType(blob);
}

async function suggestType(blob) {
  if (!visionEnabled()) return;
  aiText.textContent = "🤖 Looking at the photo...";
  try {
    const result = await classifyImage(blob);
    if (draft?.blob !== blob) return;
    draft.ai = result;
    if (result.type === "none") {
      aiText.textContent = `🤖 No hazard spotted: ${result.description} Pick a type yourself if there is one.`;
      return;
    }
    const t = INCIDENT_TYPES[result.type];
    if (t) typeSelect.value = result.type;
    aiText.textContent =
      `🤖 Looks like ${t?.emoji || ""} ${t?.label || result.type} (${Math.round(result.confidence * 100)}% sure): ` +
      `${result.description} Change the type if this is wrong.`;
  } catch (err) {
    console.error(err);
    if (draft?.blob === blob) aiText.textContent = "🤖 AI suggestion unavailable: " + err.message;
  }
}

// ---------- 11. Save: live photos immediately, uploads after a map click ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!draft) return;

  const report = {
    blob: draft.blob,
    live: draft.live,
    type: typeSelect.value,
    notes: notesInput.value.trim(),
  };
  const posPromise = livePositionPromise;

  saveBtn.disabled = true;
  formError.textContent = "";

  if (report.live && posPromise) {
    saveBtn.textContent = "Saving...";
    const pos = await posPromise.catch(() => null);
    if (pos) {
      try {
        await saveReport(report, pos);
        dialog.close();
      } catch (err) {
        console.error(err);
        formError.textContent = "Couldn't save the report: " + err.message;
        saveBtn.disabled = false;
        saveBtn.textContent = "Save incident";
      }
      return;
    }
  }

  dialog.close();
  startPlacing(report);
});

function startPlacing(report) {
  placingReport = report;
  appMode = "report";
  statusBeforeReport = statusEl.textContent;
  statusEl.textContent = "Click the map where the photo was taken.";
  reportBtn.textContent = "Cancel reporting";
  map.getContainer().style.cursor = "crosshair";
}

function stopPlacing() {
  placingReport = null;
  appMode = "route";
  statusEl.textContent = statusBeforeReport;
  reportBtn.textContent = "Report incident";
  map.getContainer().style.cursor = "";

  // Verification dialogs must wait until map placement is finished.
  // Resume the queue now that the map is clickable again.
  showNextVerify();
}

map.on("click", async (e) => {
  if (appMode !== "report" || !placingReport) return;
  const report = placingReport;
  placingReport = null;
  statusEl.textContent = "Saving incident...";
  try {
    await saveReport(report, e.latlng);
    stopPlacing();
  } catch (err) {
    console.error(err);
    placingReport = report;
    statusEl.textContent = `Couldn't save: ${err.message}. Click the map to try again.`;
  }
});

async function saveReport(report, latlng) {
  const photoUrl = await uploadPhoto(report.blob);
  const row = await insertIncident({
    lat: latlng.lat,
    lng: latlng.lng,
    type: report.type,
    value: INCIDENT_TYPES[report.type]?.severity ?? 2,
    notes: report.notes,
    photo_url: photoUrl,
    reporter_id: DEVICE_ID,
    live_photo: report.live,
  });
  showIncident(rowToIncident(row));
  updateCount();
  // Re-score routes now that a new incident is on the map
  rescoreRoutes();
}

// ---------- 12. Image helpers ----------
async function resizeImage(file, maxSize) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return drawToJpeg(bitmap, bitmap.width, bitmap.height, maxSize);
}

function drawToJpeg(source, width, height, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the image."))),
      "image/jpeg",
      0.8
    );
  });
}

async function uploadPhoto(blob) {
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await db.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return db.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function insertIncident(fields) {
  const { data, error } = await db.from("incidents").insert(fields).select().single();
  if (error) throw error;
  return data;
}

function rowToIncident(row) {
  return {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    type: row.type,
    value: row.value,
    notes: row.notes || "",
    photo: row.photo_url,
    createdAt: row.created_at,
    status: row.status || "unverified",
    confirmCount: row.confirm_count || 0,
    denyCount: row.deny_count || 0,
    reporterId: row.reporter_id,
    livePhoto: Boolean(row.live_photo),
  };
}

// ---------- 13. Load saved incidents (on open, then every minute) ----------
async function loadIncidents() {
  const { data, error } = await db
    .from("incidents")
    .select("*")
    .neq("status", "resolved")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    countEl.textContent =
      "Couldn't load incidents: " + error.message +
      " (has supabase/verification.sql been run?)";
    return;
  }
  const seen = new Set();
  data.forEach((row) => {
    const incident = rowToIncident(row);
    seen.add(incident.id);
    showIncident(incident);
  });
  [...incidents].forEach((i) => { if (!seen.has(i.id)) dropIncident(i.id); });
  updateCount();
  checkNearby();
  // Re-evaluate routes with latest incident data
  rescoreRoutes();
}

async function refreshIncident(id) {
  const { data, error } = await db.from("incidents").select("*").eq("id", id).single();
  if (error) { console.error(error); return; }
  if (data.status === "resolved") dropIncident(id);
  else showIncident(rowToIncident(data));
  updateCount();
  rescoreRoutes();
}

loadIncidents();
setInterval(loadIncidents, REFRESH_MS);

// ---------- 14. Draw an incident on the map ----------
function showIncident(incident) {
  if (!INCIDENT_TYPES[incident.type]) return;
  const existing = incidents.find((i) => i.id === incident.id);
  if (existing) {
    Object.assign(existing, incident, { marker: existing.marker });
    existing.marker.setIcon(incidentIcon(existing));
    existing.marker.setPopupContent(buildPopup(existing));
    return;
  }
  incident.marker = L.marker([incident.lat, incident.lng], { icon: incidentIcon(incident) })
    .addTo(map)
    .bindPopup(buildPopup(incident));
  incidents.push(incident);
}

function incidentIcon(incident) {
  const t = INCIDENT_TYPES[incident.type];
  const statusClass = incident.status === "verified" ? "verified" : "unverified";
  return L.divIcon({
    className: `incident-icon ${statusClass}`,
    html: `<span>${t.emoji}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function buildPopup(incident) {
  const t = INCIDENT_TYPES[incident.type];
  const box = document.createElement("div");
  box.className = "incident-popup";

  const img = document.createElement("img");
  img.src = incident.photo;

  const title = document.createElement("strong");
  title.textContent = `${t.emoji} ${t.label}`;

  const safetyBadge = document.createElement("div");
  safetyBadge.className = `safety-badge safety-${t.safetyLevel}`;
  safetyBadge.textContent = t.safetyLabel;

  const statusBadge = document.createElement("div");
  const isVerified = incident.status === "verified";
  statusBadge.className = isVerified ? "badge verified" : "badge";
  statusBadge.textContent = isVerified ? "✔ Verified" : "Unverified";

  const votes = document.createElement("div");
  votes.textContent = voteSummary(incident);

  const penalty = incidentPenalty(incident, IS_NIGHT);
  const penaltyEl = document.createElement("div");
  penaltyEl.className = "penalty-info";
  penaltyEl.textContent = `Route penalty: ${penalty.toFixed(2)} pts · ${incident.livePhoto ? "📷 live photo" : "🖼️ uploaded"}`;

  box.append(img, title, safetyBadge, statusBadge, votes, penaltyEl);

  if (incident.notes) {
    const notes = document.createElement("div");
    notes.textContent = incident.notes;
    box.appendChild(notes);
  }

  const remove = document.createElement("button");
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeIncident(incident.id));
  box.appendChild(remove);

  return box;
}

function voteSummary(incident) {
  const n = (x) => (x === 1 ? "1 person" : `${x} people`);
  return `✅ ${n(incident.confirmCount)} confirmed · ❌ ${n(incident.denyCount)} said it's gone`;
}

async function removeIncident(id) {
  const { error } = await db.from("incidents").delete().eq("id", id);
  if (error) { alert("Couldn't remove: " + error.message); return; }
  dropIncident(id);
  updateCount();
  rescoreRoutes();
}

function dropIncident(id) {
  const index = incidents.findIndex((i) => i.id === id);
  if (index === -1) return;
  incidents[index].marker.remove();
  incidents.splice(index, 1);
}

function updateCount() {
  const verified = incidents.filter((i) => i.status === "verified").length;
  countEl.textContent = incidents.length
    ? `${incidents.length} incident(s) · ${verified} verified`
    : "";
}

// ---------- 15. Location tracking ----------
function getPosition() {
  if (simulatedPosition) return Promise.resolve(simulatedPosition);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("location isn't available in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (p.coords.accuracy > MAX_GPS_ERROR_METERS) {
          reject(new Error(`location is only accurate to ±${Math.round(p.coords.accuracy)} m`));
        } else {
          resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        }
      },
      (err) => reject(new Error(err.message || "location permission denied")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}

function onPosition(pos) {
  userPosition = pos;
  if (!userDot) {
    userDot = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({ className: "user-dot", iconSize: [20, 20] }),
      interactive: false,
    }).addTo(map);
  } else {
    userDot.setLatLng([pos.lat, pos.lng]);
  }
  checkNearby();
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (p) => {
      if (simulatedPosition) return;
      onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
    },
    (err) => console.warn("Location unavailable:", err.message),
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

if (DEMO_MODE) {
  map.on("contextmenu", (e) => {
    simulatedPosition = { lat: e.latlng.lat, lng: e.latlng.lng, accuracy: 5 };
    onPosition(simulatedPosition);
  });
  statusEl.textContent += " (Demo: right-click the map to set your position.)";
}

// ---------- 16. Ask passers-by: "Is this hazard still here?" ----------
function checkNearby() {
  if (!userPosition || userPosition.accuracy > MAX_GPS_ERROR_METERS) return;
  const here = [userPosition.lat, userPosition.lng];
  for (const incident of incidents) {
    if (incident.reporterId === DEVICE_ID) continue;
    if (askedIds.has(incident.id)) continue;
    if (incident === verifying || verifyQueue.includes(incident)) continue;
    if (map.distance(here, [incident.lat, incident.lng]) <= NEARBY_METERS) {
      verifyQueue.push(incident);
    }
  }
  showNextVerify();
}

function showNextVerify() {
  // Do not open another modal while the user is placing a report on the map.
  // A verification dialog over the map intercepts clicks and makes it appear
  // that the location picker is not responding.
  if (verifying || dialog.open || placingReport || appMode === "report") return;
  verifyQueue = verifyQueue.filter((i) => incidents.includes(i));
  verifying = verifyQueue.shift() || null;
  if (!verifying) return;

  const t = INCIDENT_TYPES[verifying.type];
  verifyPhoto.src = verifying.photo;
  verifyText.textContent =
    `Someone reported ${t.emoji} ${t.label} near you. ` +
    (verifying.notes ? `"${verifying.notes}" ` : "") +
    voteSummary(verifying) + ".";
  verifyDialog.showModal();
}

document.getElementById("verify-yes").addEventListener("click", () => answerVerify(true));
document.getElementById("verify-no").addEventListener("click", () => answerVerify(false));
document.getElementById("verify-unsure").addEventListener("click", () => answerVerify(null));
verifyDialog.addEventListener("close", () => { if (verifying) answerVerify(null); });

async function answerVerify(isPresent) {
  const incident = verifying;
  verifying = null;
  verifyDialog.close();
  markAsked(incident.id);

  if (isPresent !== null) {
    const { error } = await db.from("verifications").insert({
      incident_id: incident.id,
      device_id: DEVICE_ID,
      is_present: isPresent,
    });
    if (error && error.code !== "23505") {
      console.error(error);
      countEl.textContent = "Couldn't save your answer: " + error.message;
    } else {
      await refreshIncident(incident.id);
    }
  }
  showNextVerify();
}

function loadAskedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("safewalk-asked")) || []);
  } catch { return new Set(); }
}

function markAsked(id) {
  askedIds.add(id);
  try {
    localStorage.setItem("safewalk-asked", JSON.stringify([...askedIds]));
  } catch { }
}

// ---------- 17. Dynamic route scoring ----------
// Every route is given a graded risk instead of a pass/fail:
//   • each nearby hazard adds  penalty × proximity  points (penalty = severity × confidence × freshness)
//   • each nearby crime report adds  severity × recency × proximity  points (crimes.js)
//   • "extra metres" = points × a weight per level, i.e. how much longer a walk you'd accept to avoid
//     it. High-risk hazards are weighted heavily (a detour of well over a kilometre is worth it),
//     low-risk ones lightly. So a route is only picked if its detour is worth the risk it removes.
//   • routeCost = length in metres + extra metres. Routes are ranked by that cost.
//   • The 0–100 "risk score" shown to the user is 100 × (1 − e^(−points / RISK_SCALE)).
const ROUTE_CORRIDOR_METERS = 75;   // beyond this a report is ignored
const FULL_WEIGHT_METERS    = 25;   // within this a report counts fully; it fades out between 25 and 75 m
const LEVEL_WEIGHT_M = { high: 300, medium: 60, low: 25 };  // metres of detour per penalty point
const CRIME_WEIGHT_M     = 15;      // metres of detour per crime point
const MAX_CRIME_EXTRA_M  = 1500;    // crimes alone never justify more than this much extra walking
const LIGHTING_RISK_POINTS = 4;    // fully unlit route penalty when night lighting data is available
const LIGHTING_WEIGHT_M = 300;      // maximum extra walking metres accepted for better lighting
const RISK_SCALE         = 30;      // bigger = the 0–100 score rises more slowly

// 1 when the report is close to the route, fading to 0 at the edge of the corridor.
// (GPS and map clicks are imprecise, so a hard cutoff would be unfair.)
function proximityFactor(d) {
  if (d <= FULL_WEIGHT_METERS) return 1;
  if (d >= ROUTE_CORRIDOR_METERS) return 0;
  return (ROUTE_CORRIDOR_METERS - d) / (ROUTE_CORRIDOR_METERS - FULL_WEIGHT_METERS);
}

// Shortest distance in metres from a point to a polyline [[lat, lng], ...].
// Measures to the line SEGMENTS, not just the vertices, so a hazard beside a long
// straight stretch is not missed. Uses a flat local approximation (accurate at city scale).
function distToPolylineMeters(coords, lat, lng) {
  const ky = 111320;
  const kx = 111320 * Math.cos(lat * Math.PI / 180);
  let ax = (coords[0][1] - lng) * kx;
  let ay = (coords[0][0] - lat) * ky;
  if (coords.length === 1) return Math.sqrt(ax * ax + ay * ay);
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const bx = (coords[i][1] - lng) * kx;
    const by = (coords[i][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.sqrt(px * px + py * py);
    if (d < best) best = d;
    ax = bx; ay = by;
  }
  return best;
}

// A bounding box around a route, widened by `padM` metres, for cheap "is it anywhere near?" checks.
function routeBox(coords, padM) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
  }
  const dLat = padM / 111320;
  const dLng = padM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return { s: s - dLat, n: n + dLat, w: w - dLng, e: e + dLng };
}
const inBox = (box, lat, lng) => lat >= box.s && lat <= box.n && lng >= box.w && lng <= box.e;

function scoreAndRankRoutes(trips, decodedCoords, isNight, preference) {
  // The preference weights (time / balanced / safety) scale how much a risk point is worth
  const mult = (PREFERENCE_WEIGHTS[preference] ?? PREFERENCE_WEIGHTS.balanced) / PREFERENCE_WEIGHTS.balanced;
  const haveCrimes = typeof crimes !== "undefined" && typeof crimePenalty === "function"; // crimes.js

  return trips
    .map((trip, i) => {
      const coords = decodedCoords[i];
      const box = routeBox(coords, ROUTE_CORRIDOR_METERS);

      // --- reported hazards ---
      const nearbyIncidents = [];
      let hazardPts = 0, hazardExtraM = 0;
      for (const inc of incidents) {
        if (inc.status === "resolved" || !inBox(box, inc.lat, inc.lng)) continue;
        const d = distToPolylineMeters(coords, inc.lat, inc.lng);
        if (d > ROUTE_CORRIDOR_METERS) continue;
        nearbyIncidents.push(inc);
        const pts = incidentPenalty(inc, isNight) * proximityFactor(d);
        hazardPts += pts;
        hazardExtraM += pts * LEVEL_WEIGHT_M[INCIDENT_TYPES[inc.type]?.safetyLevel || "low"];
      }

      // --- crime reports ---
      let crimePts = 0, crimeCount = 0;
      if (haveCrimes) {
        // Only crimes inside the date slider's range count, so what you see is what is scored
        const maxAge = typeof crimeDays !== "undefined" ? crimeDays : Infinity;
        for (const c of crimes) {
          if (!inBox(box, c.lat, c.lng)) continue;
          if (crimeAgeDays(c.date) > maxAge) continue;
          const f = proximityFactor(distToPolylineMeters(coords, c.lat, c.lng));
          if (!f) continue;
          crimeCount++;
          crimePts += crimePenalty(c) * f;
        }
      }

      // --- mapped street-light coverage ---
      const lighting = typeof lightCoverageForRoute === "function"
        ? lightCoverageForRoute(coords)
        : null;
      const lightingAvailable = Boolean(lighting?.available);
      const lightingCoverage = lightingAvailable ? lighting.coverage : 0;
      const lightingPts = isNight && lightingAvailable
        ? (1 - lightingCoverage) * LIGHTING_RISK_POINTS
        : 0;

      const lightingExtraM = isNight && lightingAvailable
        ? (1 - lightingCoverage) * LIGHTING_WEIGHT_M
        : 0;
      const extraM = (hazardExtraM + Math.min(crimePts * CRIME_WEIGHT_M, MAX_CRIME_EXTRA_M) + lightingExtraM) * mult;
      const riskPts = hazardPts + crimePts + lightingPts;

      // For display: count nearby hazards by their own safety level
      const countLevel = (lvl) => nearbyIncidents.filter((x) => INCIDENT_TYPES[x.type]?.safetyLevel === lvl).length;

      return {
        ...trip,
        _index: i,
        _coords: coords,
        _riskPts: riskPts,
        _riskScore: Math.round(100 * (1 - Math.exp(-riskPts / RISK_SCALE))),
        _hazardPts: hazardPts,
        _crimePts: crimePts,
        _crimeCount: crimeCount,
        _lightingAvailable: lightingAvailable,
        _lightingCoverage: lightingCoverage,
        _lightingFixtures: lighting?.fixtures ?? 0,
        _routeCost: trip.summary.length * 1000 + extraM,
        _nearbyIncidents: nearbyIncidents,
        _highRisk: countLevel("high"),
        _mediumRisk: countLevel("medium"),
        _lowRisk: countLevel("low"),
      };
    })
    .sort((a, b) => a._routeCost - b._routeCost);
}

// Haversine distance in metres between two lat/lng points
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
