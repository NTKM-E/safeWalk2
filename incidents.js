// incidents.js: lets the user report incidents (photo + type), saves them to Supabase,
// and shows them on the map.
// Loaded AFTER app.js, because it uses things defined there: map, statusEl, appMode.

// ---------- 1. Incident types and their values ----------
// "value" is a placeholder weight. Replace these numbers with the values from your
// routing-logic file. Route scoring will read each incident's value later.
// The keys here must match the list allowed by the `type` check in the database table.
const INCIDENT_TYPES = {
  pothole:                 { label: "Pothole",                 emoji: "🕳️", value: 3 },
  unpaved_surface:         { label: "Unpaved surface",         emoji: "🪨", value: 2 },
  pedestrian_signal_issue: { label: "Pedestrian signal issue", emoji: "🚦", value: 4 },
  construction:            { label: "Construction",            emoji: "🚧", value: 4 },
  trash:                   { label: "Trash / debris",          emoji: "🗑️", value: 1 },
  obstruction:             { label: "Obstruction",             emoji: "⛔", value: 5 },
  other:                   { label: "Other",                   emoji: "❓", value: 2 },
};

// ---------- 2. Database connection ----------
// `db` is our connection to Supabase. It uses the URL and publishable key from config.js.
// What this key is allowed to do is decided by the Row Level Security rules in the database.
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const PHOTO_BUCKET = "incident-photos";

// ---------- 3. State ----------
// The incidents currently on the map: {id, lat, lng, type, value, notes, photo, createdAt, marker}
// The array is a copy of what is in the database, so route scoring can read it quickly.
const incidents = [];
let pendingLatLng = null;   // where the user clicked, before the form is saved
let pendingMarker = null;   // temporary red circle at that spot
let statusBeforeReport = "";

// ---------- 4. Grab page elements ----------
const reportBtn = document.getElementById("report-btn");
const countEl = document.getElementById("incident-count");
const dialog = document.getElementById("report-dialog");
const form = document.getElementById("report-form");
const typeSelect = document.getElementById("report-type");
const photoInput = document.getElementById("report-photo");
const photoPreview = document.getElementById("photo-preview");
const notesInput = document.getElementById("report-notes");
const cancelBtn = document.getElementById("report-cancel");
const formError = document.getElementById("report-error");
const saveBtn = form.querySelector('button[type="submit"]');

// Fill the dropdown from INCIDENT_TYPES so the list and the values stay in one place
for (const [key, t] of Object.entries(INCIDENT_TYPES)) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = `${t.emoji} ${t.label} (value ${t.value})`;
  typeSelect.appendChild(option);
}

// ---------- 5. Report mode on/off ----------
reportBtn.addEventListener("click", () => {
  if (appMode === "report") stopReporting();
  else startReporting();
});

function startReporting() {
  appMode = "report"; // app.js now ignores map clicks for A/B
  statusBeforeReport = statusEl.textContent;
  statusEl.textContent = "Click the map where the incident is.";
  reportBtn.textContent = "Cancel reporting";
  map.getContainer().style.cursor = "crosshair";
}

function stopReporting() {
  appMode = "route";
  statusEl.textContent = statusBeforeReport;
  reportBtn.textContent = "Report incident";
  map.getContainer().style.cursor = "";
  clearPending();
}

function clearPending() {
  if (pendingMarker) pendingMarker.remove();
  pendingMarker = null;
  pendingLatLng = null;
}

// ---------- 6. Choose a location, then open the form ----------
map.on("click", (e) => {
  if (appMode !== "report") return; // only act in report mode
  clearPending();
  pendingLatLng = e.latlng;
  pendingMarker = L.circleMarker(e.latlng, {
    radius: 9, color: "#dc2626", fillColor: "#dc2626", fillOpacity: 0.3, dashArray: "3",
  }).addTo(map);
  dialog.showModal(); // the built-in <dialog> element: shows the form on top of the page
});

// Show a preview as soon as a photo is chosen
photoInput.addEventListener("change", () => {
  const file = photoInput.files[0];
  if (file) {
    photoPreview.src = URL.createObjectURL(file);
    photoPreview.hidden = false;
  } else {
    photoPreview.hidden = true;
  }
});

cancelBtn.addEventListener("click", () => dialog.close());

// Runs whenever the dialog closes (Cancel, Esc key, or after saving): tidy up the form
dialog.addEventListener("close", () => {
  form.reset();
  photoPreview.hidden = true;
  formError.textContent = "";
  if (pendingMarker) { pendingMarker.remove(); pendingMarker = null; } // the real marker is separate
});

// ---------- 7. Save the incident ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault(); // stop the browser from reloading the page
  const file = photoInput.files[0];
  if (!file || !pendingLatLng) return;

  // Copy what we need now, because the form and pending point get cleared when the dialog closes
  const { lat, lng } = pendingLatLng;
  const type = typeSelect.value;
  const notes = notesInput.value.trim();

  // Disable the button so a double-click can't save the report twice
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";
  formError.textContent = "";

  try {
    const photoBlob = await resizeImage(file, 800);       // shrink the photo
    const photoUrl = await uploadPhoto(photoBlob);        // 1) upload it to Storage
    const row = await insertIncident({                    // 2) save the report row
      lat, lng, type,
      value: INCIDENT_TYPES[type].value,
      notes,
      photo_url: photoUrl,
    });
    addIncident(rowToIncident(row));                      // 3) show it on the map
    dialog.close();
    stopReporting();
  } catch (err) {
    console.error(err);
    formError.textContent = "Couldn't save the report: " + err.message;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save incident";
  }
});

// Shrinks the photo to at most `maxSize` pixels and returns it as a JPEG file (a Blob).
// Redrawing onto a canvas also drops hidden metadata like GPS.
async function resizeImage(file, maxSize) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
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

// Adds one row to the incidents table. The database fills in the id and created_at.
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
  };
}

// ---------- 8. Load saved incidents when the page opens ----------
async function loadIncidents() {
  const { data, error } = await db
    .from("incidents")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    countEl.textContent = "Couldn't load saved incidents: " + error.message;
    return;
  }
  data.forEach((row) => addIncident(rowToIncident(row)));
}

loadIncidents();

// ---------- 9. Draw an incident on the map ----------
function addIncident(incident) {
  const t = INCIDENT_TYPES[incident.type];
  if (!t) return; // ignore rows with a type this page doesn't know
  const icon = L.divIcon({
    className: "incident-icon",
    html: `<span>${t.emoji}</span>`, // emoji comes from our own table, so it is safe
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
  incident.marker = L.marker([incident.lat, incident.lng], { icon })
    .addTo(map)
    .bindPopup(buildPopup(incident));
  incidents.push(incident);
  updateCount();
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

  const value = document.createElement("div");
  value.textContent = `Value: ${incident.value}`;

  box.append(img, title, value);

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

// Deletes the row from the database first, then removes the marker from the map.
// This relies on the TEMPORARY delete policy from the SQL setup.
async function removeIncident(id) {
  const { error } = await db.from("incidents").delete().eq("id", id);
  if (error) {
    alert("Couldn't remove the incident: " + error.message);
    return;
  }
  const index = incidents.findIndex((i) => i.id === id);
  if (index === -1) return;
  incidents[index].marker.remove();
  incidents.splice(index, 1);
  updateCount();
}

function updateCount() {
  countEl.textContent = incidents.length
    ? `${incidents.length} incident(s) reported`
    : "";
}
