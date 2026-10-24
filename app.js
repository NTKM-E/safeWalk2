// ---------- 1. Settings ----------
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"; // free public demo server
const SAN_JOSE = [37.3382, -121.8863];                           // [lat, lng]
const ROUTE_COLORS = ["#2563eb", "#16a34a", "#ea580c"];          // one color per route

// ---------- 2. Create the map ----------
const map = L.map("map").setView(SAN_JOSE, 14);

// Tiles are the little square images that make up the map picture.
// We use CARTO's Voyager basemap. It needs a free API key, which is added
// to the end of the tile URL as "?key=...".
// The key comes from config.js (CONFIG is defined there), not from this file.
L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CONFIG.CARTO_KEY}`, {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
}).addTo(map);

// ---------- 3. State: what the user has picked so far ----------
let pointA = null;       // {lat, lng}
let pointB = null;
let markers = [];        // Leaflet markers currently on the map
let routeLines = [];     // Leaflet polylines currently on the map

const statusEl = document.getElementById("status");
const routesEl = document.getElementById("routes");

// ---------- 4. Handle map clicks ----------
map.on("click", (e) => {
  // If the user is placing a report, this click is its location, not a route point.
  if (placingReport) {
    placeReport(e.latlng);
    return;
  }
  if (!pointA) {
    pointA = e.latlng;
    markers.push(L.marker(pointA).addTo(map).bindTooltip("A", { permanent: true }));
    statusEl.textContent = "Now click your destination (B).";
  } else if (!pointB) {
    pointB = e.latlng;
    markers.push(L.marker(pointB).addTo(map).bindTooltip("B", { permanent: true }));
    statusEl.textContent = "Finding walking routes...";
    getRoutes(pointA, pointB);
  }
  // If both points are set, extra clicks do nothing until Reset is pressed.
});

document.getElementById("reset").addEventListener("click", reset);

function reset() {
  pointA = null;
  pointB = null;
  markers.forEach((m) => m.remove());
  routeLines.forEach((l) => l.remove());
  markers = [];
  routeLines = [];
  routesEl.innerHTML = "";
  statusEl.textContent = "Click the map to set your start point (A).";
}

// ---------- 5. Ask Valhalla for routes ----------
async function getRoutes(a, b) {
  const body = {
    locations: [
      { lat: a.lat, lon: a.lng },   // Valhalla calls longitude "lon"
      { lat: b.lat, lon: b.lng },
    ],
    costing: "pedestrian",          // walking profile (uses sidewalks, crossings, etc.)
    alternates: 2,                  // ask for up to 2 extra routes besides the best one
    directions_options: { units: "kilometers" },
  };

  try {
    const res = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Valhalla returned HTTP " + res.status);
    const data = await res.json();

    // The main route is data.trip; extra routes are in data.alternates[i].trip
    const trips = [data.trip, ...(data.alternates || []).map((alt) => alt.trip)];
    drawRoutes(trips);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't get routes: " + err.message;
  }
}

// ---------- 6. Draw the routes ----------
function drawRoutes(trips) {
  routesEl.innerHTML = "";

  trips.forEach((trip, i) => {
    // Valhalla sends the path as one compressed string; decode it to [lat, lng] points
    const coords = decodePolyline(trip.legs[0].shape);

    const line = L.polyline(coords, {
      color: ROUTE_COLORS[i % ROUTE_COLORS.length],
      weight: 6,
      opacity: 0.85,
    }).addTo(map);
    routeLines.push(line);

    // Show distance and time in the panel
    const km = trip.summary.length.toFixed(2);
    const min = Math.round(trip.summary.time / 60);
    const item = document.createElement("div");
    item.className = "route-item";
    item.innerHTML =
      `<span class="swatch" style="background:${ROUTE_COLORS[i % ROUTE_COLORS.length]}"></span>` +
      `Route ${i + 1}: ${km} km, ${min} min`;
    routesEl.appendChild(item);
  });

  // Zoom the map so every route is visible
  map.fitBounds(L.featureGroup(routeLines).getBounds(), { padding: [40, 40] });
  statusEl.textContent = `Found ${trips.length} route(s). Press Reset to try again.`;
}

// ---------- 7. Report an issue with a photo ----------
// Flow: choose photo -> Gemini suggests category + severity (see vision.js)
// -> user can correct it -> user clicks the map to place the report.
// Reports are saved in this browser (localStorage) so they survive a reload.
const REPORTS_KEY = "safewalk-reports";
let reports = [];          // [{id, lat, lng, category, severity, confidence, description, thumb, createdAt}]
let pendingReport = null;  // a classified report waiting for its map location
let placingReport = false; // true after "Place on map": the next map click sets its location

const photoInput = document.getElementById("photo");
const previewEl = document.getElementById("preview");
const reportStatusEl = document.getElementById("report-status");
const reportFormEl = document.getElementById("report-form");
const categorySelect = document.getElementById("report-category");
const severitySelect = document.getElementById("report-severity");

// Fill the dropdowns from the lists in vision.js
for (const [key, cat] of Object.entries(ISSUE_CATEGORIES)) {
  categorySelect.add(new Option(`${cat.icon} ${cat.label}`, key));
}
SEVERITY_LEVELS.forEach((level) => severitySelect.add(new Option(level, level)));

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  pendingReport = null;
  placingReport = false;
  reportFormEl.hidden = true;
  reportStatusEl.textContent = "Analyzing photo...";

  try {
    const dataUrl = await resizeImage(file);
    previewEl.src = dataUrl;
    previewEl.hidden = false;

    const result = await classifyImage(dataUrl);
    const cat = ISSUE_CATEGORIES[result.category];
    reportStatusEl.textContent =
      `AI suggestion: ${cat.icon} ${cat.label} (${result.severity}, ` +
      `${Math.round(result.confidence * 100)}% confident). ${result.description}`;

    categorySelect.value = result.category;
    severitySelect.value = result.severity;
    // Keep a small copy of the photo for the map popup (the full one is too big to save).
    pendingReport = { ...result, thumb: await resizeImage(file, 240, 0.7) };
    reportFormEl.hidden = false;
  } catch (err) {
    console.error(err);
    reportStatusEl.textContent = "Couldn't analyze photo: " + err.message;
  }
});

document.getElementById("place-report").addEventListener("click", () => {
  placingReport = true;
  reportStatusEl.textContent = "Click the map where the issue is.";
});

function placeReport(latlng) {
  const report = {
    ...pendingReport,
    // The user's choice wins over the AI suggestion
    category: categorySelect.value,
    severity: severitySelect.value,
    id: Date.now(),
    lat: latlng.lat,
    lng: latlng.lng,
    createdAt: new Date().toISOString(),
  };
  reports.push(report);
  saveReports();
  drawReport(report);

  pendingReport = null;
  placingReport = false;
  reportFormEl.hidden = true;
  previewEl.hidden = true;
  photoInput.value = "";
  reportStatusEl.textContent = "Report added. Thanks!";
}

function drawReport(report) {
  const cat = ISSUE_CATEGORIES[report.category] || ISSUE_CATEGORIES.none;
  const icon = L.divIcon({ className: "report-pin", html: cat.icon, iconSize: [24, 24] });

  // Build the popup with textContent, not innerHTML, because the description
  // comes from the AI model and should never be treated as HTML.
  const popup = document.createElement("div");
  popup.className = "report-popup";
  if (report.thumb) {
    const img = document.createElement("img");
    img.src = report.thumb;
    popup.appendChild(img);
  }
  const title = document.createElement("strong");
  title.textContent = `${cat.label} (${report.severity})`;
  const desc = document.createElement("div");
  desc.textContent = report.description;
  popup.append(title, desc);

  L.marker([report.lat, report.lng], { icon }).addTo(map).bindPopup(popup);
}

function saveReports() {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
  } catch (err) {
    console.warn("Couldn't save reports (storage full or blocked):", err);
  }
}

function loadReports() {
  try {
    reports = JSON.parse(localStorage.getItem(REPORTS_KEY)) || [];
  } catch {
    reports = [];
  }
  reports.forEach(drawReport);
}

loadReports();

// ---------- 8. Decode Valhalla's compressed path ----------
// Valhalla uses the "encoded polyline" format with 6 decimals of precision.
// Each number is stored as the *difference* from the previous one, packed into
// ASCII characters, to keep the response small.
function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coords = [];

  while (index < str.length) {
    // Read one number (latitude change), 5 bits at a time
    let shift = 0, result = 0, byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1; // lowest bit = sign

    // Read the next number (longitude change) the same way
    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
