// incidents.js: lets the user report incidents (photo + type), saves them to Supabase,
// shows them on the map, and asks people walking past whether they are still there.
// Loaded AFTER app.js and vision.js, because it uses things defined there:
// map, statusEl, appMode (app.js) and classifyImage, visionEnabled (vision.js).
//
// Reporting:
//   📷 Take photo  -> live camera photo, located automatically with GPS
//   🖼️ Upload photo -> photo from the gallery, the user clicks the map to mark where it was taken
// Every new report starts as "unverified". The database (see supabase/verification.sql)
// counts confirmations from other users and marks it "verified" or "resolved".

// ---------- 1. Incident types and their values ----------
// "value" is a placeholder weight. Replace these numbers with the values from your
// routing-logic file. Route scoring will read each incident's value later.
// The keys here must match the list allowed by the `type` check in the database table,
// and the AI's list in vision.js.
const INCIDENT_TYPES = {
  pothole:                 { label: "Pothole",                 emoji: "🕳️", value: 3 },
  unpaved_surface:         { label: "Unpaved surface",         emoji: "🪨", value: 2 },
  pedestrian_signal_issue: { label: "Pedestrian signal issue", emoji: "🚦", value: 4 },
  lighting:                { label: "Lighting issue",          emoji: "💡", value: 3 },
  construction:            { label: "Construction",            emoji: "🚧", value: 4 },
  trash:                   { label: "Trash / debris",          emoji: "🗑️", value: 1 },
  obstruction:             { label: "Obstruction",             emoji: "⛔", value: 5 },
  other:                   { label: "Other",                   emoji: "❓", value: 2 },
};

// ---------- 2. Settings ----------
const NEARBY_METERS = 40;          // how close you must walk to an incident to be asked about it
const MAX_GPS_ERROR_METERS = 100;  // location fixes less accurate than this are not used
const REFRESH_MS = 60 * 1000;      // how often to reload incidents (to see other people's reports)

// Demo mode: open the page as index.html?demo, then RIGHT-click the map to pretend you
// are standing there. Lets you test GPS features on a laptop without walking around.
const DEMO_MODE = new URLSearchParams(window.location.search).has("demo");

// ---------- 3. Database connection ----------
// `db` is our connection to Supabase. It uses the URL and publishable key from config.js.
// What this key is allowed to do is decided by the Row Level Security rules in the database.
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const PHOTO_BUCKET = "incident-photos";

// ---------- 4. Who is this user? ----------
// There are no accounts yet, so each browser gets a random id that is kept in localStorage.
// It lets the database count one answer per person, and stops people verifying their own report.
// (Anyone can clear their storage to get a new id, so this is fine for a demo, not for real use.)
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
    return newId(); // storage blocked (e.g. private window): a new id for this visit only
  }
}

// crypto.randomUUID only exists on https:// or localhost, so build one by hand otherwise.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// ---------- 5. State ----------
// The incidents currently on the map:
// {id, lat, lng, type, value, notes, photo, createdAt, status, confirmCount, denyCount,
//  reporterId, livePhoto, marker}
// The array is a copy of what is in the database, so route scoring can read it quickly.
const incidents = [];
let draft = null;                 // the report being filled in: {blob, live, ai}
let placingReport = null;         // an uploaded-photo report waiting for a map click
let cameraStream = null;          // the open camera, so we can switch it off
let livePositionPromise = null;   // GPS request started when the camera opens
let previewUrl = null;
let statusBeforeReport = "";

let userPosition = null;          // latest {lat, lng, accuracy} of this user
let simulatedPosition = null;     // set by right-click in demo mode
let userDot = null;               // blue dot on the map
let verifyQueue = [];             // nearby incidents waiting to be asked about
let verifying = null;             // the incident shown in the verify popup right now
const askedIds = loadAskedIds();  // incidents this user was already asked about

// ---------- 6. Grab page elements ----------
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

// Fill the dropdown from INCIDENT_TYPES so the list and the values stay in one place
for (const [key, t] of Object.entries(INCIDENT_TYPES)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = `${t.emoji} ${t.label} (value ${t.value})`;
  typeSelect.appendChild(option);
}

// ---------- 7. Open the report form ----------
reportBtn.addEventListener("click", () => {
  if (appMode === "report") stopPlacing();
  else openReportDialog();
});

function openReportDialog() {
  // The camera only works on https:// pages or on localhost
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  takePhotoBtn.disabled = !hasCamera;
  locationText.textContent = hasCamera ? "" : "The camera needs an https:// page (or localhost).";
  aiText.textContent = visionEnabled() ? "" : "Tip: add GEMINI_KEY to config.js for automatic type suggestions.";
  dialog.showModal(); // the built-in <dialog> element: shows the form on top of the page
}

cancelBtn.addEventListener("click", () => dialog.close());

// Runs whenever the dialog closes (Cancel, Esc key, or after saving): tidy up the form
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
  showNextVerify(); // a "still there?" question may have been waiting for the form to close
});

// ---------- 8. Option A: take a live photo ----------
takePhotoBtn.addEventListener("click", async () => {
  formError.textContent = "";
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, // the back camera on phones
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

  // Ask for the location now, so it is ready by the time the photo is taken
  livePositionPromise = getPosition();
  livePositionPromise.catch(() => {}); // the error is shown later, when we use it
});

snapBtn.addEventListener("click", async () => {
  if (!cameraVideo.videoWidth) return; // the camera hasn't started yet
  const blob = await drawToJpeg(cameraVideo, cameraVideo.videoWidth, cameraVideo.videoHeight, 800);
  stopCamera();
  cameraBox.hidden = true;
  sourceBox.hidden = false; // lets the user retake or switch to an upload
  setDraftPhoto(blob, true);

  locationText.textContent = "📍 Getting your location...";
  try {
    const pos = await livePositionPromise;
    if (draft?.blob !== blob) return; // the user has picked another photo since
    locationText.textContent = `📍 Will be marked at your current location (±${Math.round(pos.accuracy)} m).`;
  } catch (err) {
    if (draft?.blob !== blob) return;
    locationText.textContent = `Couldn't get your location (${err.message}). You'll mark the spot on the map instead.`;
    saveBtn.textContent = "Next: mark on map";
  }
});

function stopCamera() {
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
}

// ---------- 9. Option B: upload a photo ----------
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

// Show the photo and ask the AI what kind of incident it is
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
    if (draft?.blob !== blob) return; // a newer photo replaced this one
    draft.ai = result;
    if (result.type === "none") {
      aiText.textContent = `🤖 No hazard spotted: ${result.description} Pick a type yourself if there is one.`;
      return;
    }
    const t = INCIDENT_TYPES[result.type];
    typeSelect.value = result.type;
    aiText.textContent =
      `🤖 Looks like ${t.emoji} ${t.label} (${Math.round(result.confidence * 100)}% sure): ` +
      `${result.description} Change the type if this is wrong.`;
  } catch (err) {
    console.error(err);
    if (draft?.blob === blob) aiText.textContent = "🤖 AI suggestion unavailable: " + err.message;
  }
}

// ---------- 10. Save: live photos straight away, uploads after a map click ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault(); // stop the browser from reloading the page
  if (!draft) return;

  // Copy what we need now, because the form gets cleared when the dialog closes
  const report = {
    blob: draft.blob,
    live: draft.live,
    type: typeSelect.value,
    notes: notesInput.value.trim(),
  };
  const positionPromise = livePositionPromise;

  // Disable the button so a double-click can't save the report twice
  saveBtn.disabled = true;
  formError.textContent = "";

  if (report.live && positionPromise) {
    saveBtn.textContent = "Saving...";
    const pos = await positionPromise.catch(() => null);
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
    // No GPS: fall through and let the user mark the spot by hand
  }

  dialog.close();
  startPlacing(report);
});

function startPlacing(report) {
  placingReport = report;
  appMode = "report"; // app.js now ignores map clicks for A/B
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
}

map.on("click", async (e) => {
  if (appMode !== "report" || !placingReport) return; // only act while placing a report
  const report = placingReport;
  placingReport = null; // ignore more clicks while this one saves
  statusEl.textContent = "Saving incident...";
  try {
    await saveReport(report, e.latlng);
    stopPlacing();
  } catch (err) {
    console.error(err);
    placingReport = report; // let the user try again
    statusEl.textContent = `Couldn't save the report: ${err.message}. Click the map to try again.`;
  }
});

// 1) upload the photo, 2) save the row, 3) show it on the map.
// The database sets status = 'unverified' on every new row by itself.
async function saveReport(report, latlng) {
  const photoUrl = await uploadPhoto(report.blob);
  const row = await insertIncident({
    lat: latlng.lat,
    lng: latlng.lng,
    type: report.type,
    value: INCIDENT_TYPES[report.type].value,
    notes: report.notes,
    photo_url: photoUrl,
    reporter_id: DEVICE_ID,
    live_photo: report.live,
  });
  showIncident(rowToIncident(row));
  updateCount();
}

// Shrinks the photo to at most `maxSize` pixels and returns it as a JPEG file (a Blob).
// Redrawing onto a canvas also drops hidden metadata like GPS.
async function resizeImage(file, maxSize) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return drawToJpeg(bitmap, bitmap.width, bitmap.height, maxSize);
}

// Draws an image or a camera frame onto a canvas, shrunk to `maxSize`, and returns a JPEG Blob.
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

// Uploads the photo to the "incident-photos" bucket and returns its public link.
// Supabase returns { data, error } instead of throwing, so we check `error` ourselves.
async function uploadPhoto(blob) {
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`; // unique file name
  const { error } = await db.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return db.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Adds one row to the incidents table. The database fills in the id, created_at and status.
// .select().single() asks Supabase to send back the row it just created.
async function insertIncident(fields) {
  const { data, error } = await db.from("incidents").insert(fields).select().single();
  if (error) throw error;
  return data;
}

// The database uses snake_case names (photo_url, created_at); the page uses its own names.
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

// ---------- 11. Load saved incidents (on open, then every minute) ----------
// Resolved incidents (enough people said "it's gone") are not shown.
async function loadIncidents() {
  const { data, error } = await db
    .from("incidents")
    .select("*")
    .neq("status", "resolved")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    countEl.textContent =
      "Couldn't load saved incidents: " + error.message +
      " (has supabase/verification.sql been run?)";
    return;
  }
  const seen = new Set();
  data.forEach((row) => {
    const incident = rowToIncident(row);
    seen.add(incident.id);
    showIncident(incident);
  });
  // Take away incidents that were removed or resolved since the last load
  [...incidents].forEach((i) => { if (!seen.has(i.id)) dropIncident(i.id); });
  updateCount();
  checkNearby();
}

// Reload one incident, e.g. after this user answered "still there?"
async function refreshIncident(id) {
  const { data, error } = await db.from("incidents").select("*").eq("id", id).single();
  if (error) {
    console.error(error);
    return;
  }
  if (data.status === "resolved") dropIncident(id);
  else showIncident(rowToIncident(data));
  updateCount();
}

loadIncidents();
setInterval(loadIncidents, REFRESH_MS);

// ---------- 12. Draw an incident on the map ----------
// Adds a new marker, or updates the marker if this incident is already on the map.
function showIncident(incident) {
  if (!INCIDENT_TYPES[incident.type]) return; // ignore rows with a type this page doesn't know
  const existing = incidents.find((i) => i.id === incident.id);
  if (existing) {
    // Update in place, so anything holding this object (like the verify queue) stays current
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
  const status = incident.status === "verified" ? "verified" : "unverified";
  return L.divIcon({
    className: `incident-icon ${status}`, // the ring style shows whether it is verified
    html: `<span>${t.emoji}</span>`,     // emoji comes from our own table, so it is safe
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

// The popup is built with DOM elements and textContent (not innerHTML) so that
// text a user types in "notes" can never inject HTML into the page.
function buildPopup(incident) {
  const t = INCIDENT_TYPES[incident.type];
  const box = document.createElement("div");
  box.className = "incident-popup";

  const img = document.createElement("img");
  img.src = incident.photo;

  const title = document.createElement("strong");
  title.textContent = `${t.emoji} ${t.label}`;

  const badge = document.createElement("div");
  const verified = incident.status === "verified";
  badge.className = verified ? "badge verified" : "badge";
  badge.textContent = verified ? "✔ Verified" : "Unverified";

  const votes = document.createElement("div");
  votes.textContent = voteSummary(incident);

  const value = document.createElement("div");
  value.textContent = `Value: ${incident.value} · ${incident.livePhoto ? "📷 live photo" : "🖼️ uploaded photo"}`;

  box.append(img, title, badge, votes, value);

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
  const people = (n) => (n === 1 ? "1 person" : `${n} people`);
  return `✅ ${people(incident.confirmCount)} confirmed it · ❌ ${people(incident.denyCount)} said it's gone`;
}

// Deletes the row from the database first, then removes the marker from the map.
// This relies on the TEMPORARY delete policy from the SQL setup.
async function removeIncident(id) {
  const { error } = await db.from("incidents").delete().eq("id", id);
  if (error) {
    alert("Couldn't remove the incident: " + error.message);
    return;
  }
  dropIncident(id);
  updateCount();
}

// Takes an incident off the map (it stays in the database)
function dropIncident(id) {
  const index = incidents.findIndex((i) => i.id === id);
  if (index === -1) return;
  incidents[index].marker.remove();
  incidents.splice(index, 1);
}

function updateCount() {
  const verified = incidents.filter((i) => i.status === "verified").length;
  countEl.textContent = incidents.length
    ? `${incidents.length} incident(s) reported · ${verified} verified`
    : "";
}

// ---------- 13. Track the user's location ----------
// Used for live photos and for asking passers-by whether an incident is still there.
// Resolves to {lat, lng, accuracy} or rejects with a readable error.
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
      (err) => reject(new Error(err.message || "location permission was denied")),
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
      if (simulatedPosition) return; // demo mode: the right-clicked spot wins
      onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
    },
    (err) => console.warn("Location unavailable, so nearby-incident questions are off:", err.message),
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

if (DEMO_MODE) {
  map.on("contextmenu", (e) => {
    simulatedPosition = { lat: e.latlng.lat, lng: e.latlng.lng, accuracy: 5 };
    onPosition(simulatedPosition);
  });
  statusEl.textContent += " (Demo mode: right-click the map to set where you are.)";
}

// ---------- 14. Ask passers-by: "Is this hazard still here?" ----------
// When the user is within NEARBY_METERS of an incident someone else reported,
// we ask them once. Their answer is saved in the `verifications` table, and the
// database updates the incident's counts and status.
function checkNearby() {
  if (!userPosition || userPosition.accuracy > MAX_GPS_ERROR_METERS) return;
  const here = [userPosition.lat, userPosition.lng];
  for (const incident of incidents) {
    if (incident.reporterId === DEVICE_ID) continue; // your own report
    if (askedIds.has(incident.id)) continue;         // already asked
    if (incident === verifying || verifyQueue.includes(incident)) continue;
    if (map.distance(here, [incident.lat, incident.lng]) <= NEARBY_METERS) {
      verifyQueue.push(incident);
    }
  }
  showNextVerify();
}

function showNextVerify() {
  if (verifying || dialog.open) return; // one question at a time, and never over the report form
  // Skip incidents that were removed while they waited in the queue
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
// Closing with the Esc key counts as "Not sure"
verifyDialog.addEventListener("close", () => { if (verifying) answerVerify(null); });

// isPresent: true = still there, false = gone, null = not sure (nothing is saved)
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
    // 23505 = this user already answered for this incident; nothing more to do
    if (error && error.code !== "23505") {
      console.error(error);
      countEl.textContent = "Couldn't save your answer: " + error.message;
    } else {
      await refreshIncident(incident.id); // shows the new counts and status
    }
  }
  showNextVerify();
}

// Remember which incidents we already asked about, so we don't ask again after a reload
function loadAskedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("safewalk-asked")) || []);
  } catch {
    return new Set();
  }
}

function markAsked(id) {
  askedIds.add(id);
  try {
    localStorage.setItem("safewalk-asked", JSON.stringify([...askedIds]));
  } catch {
    // storage blocked: we may ask again after a reload, which is harmless
  }
}
