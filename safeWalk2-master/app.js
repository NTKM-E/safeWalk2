// app.js — SafeWalk main application
// Load order: config.js → vision.js → app.js → incidents.js

// ---------- 1. Settings ----------
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const SAN_JOSE     = [37.3382, -121.8863];

// One fixed color per display slot (slot 0 = safest, slot 1 = next, slot 2 = fastest)
const ROUTE_COLORS = ["#2563eb", "#16a34a", "#ea580c"];

// Route scoring always uses the balanced weight (25 m per penalty point).
// Night-mode weighting is always on for lighting issues because SafeWalk is
// designed for nighttime walking — no toggle needed.
const FIXED_PREFERENCE = "balanced";
const IS_NIGHT         = true;   // always apply night multipliers

// ---------- 2. Create the map ----------
const map = L.map("map").setView(SAN_JOSE, 14);
L.tileLayer(
  `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CONFIG.CARTO_KEY}`,
  { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors &copy; CARTO" }
).addTo(map);

// ---------- 3. Route state ----------
let pointA     = null;
let pointB     = null;
let markers    = [];
let routeLines = [];
// lastTrips / lastCoords: kept so incidents.js can re-score without re-fetching.
let lastTrips  = [];
let lastCoords = [];

const statusEl = document.getElementById("status");
const routesEl = document.getElementById("routes");

// ---------- 4. Handle map clicks (route mode) ----------
let appMode = "route";

map.on("click", (e) => {
  if (appMode !== "route") return;
  if (!pointA) {
    pointA = e.latlng;
    markers.push(L.marker(pointA).addTo(map).bindTooltip("A", { permanent: true }));
    statusEl.textContent = "Now click your destination (B).";
  } else if (!pointB) {
    pointB = e.latlng;
    markers.push(L.marker(pointB).addTo(map).bindTooltip("B", { permanent: true }));
    statusEl.textContent = "Finding walking routes…";
    getRoutes(pointA, pointB);
  }
});

document.getElementById("reset").addEventListener("click", reset);

function reset() {
  pointA = null;
  pointB = null;
  markers.forEach((m) => m.remove());
  routeLines.forEach((l) => l.remove());
  markers    = [];
  routeLines = [];
  lastTrips  = [];
  lastCoords = [];
  routesEl.innerHTML = "";
  statusEl.textContent = "Click the map to set your start point (A).";
}

// ---------- 5. Ask Valhalla for routes ----------
// We request 4 alternates (5 total) so the selection logic has plenty of
// candidates to pick 3 truly distinct viable options from.
async function getRoutes(a, b) {
  const body = {
    locations: [
      { lat: a.lat, lon: a.lng },
      { lat: b.lat, lon: b.lng },
    ],
    costing: "pedestrian",
    alternates: 4,
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

    const trips  = [data.trip, ...(data.alternates || []).map((alt) => alt.trip)];
    const coords = trips.map((t) => decodePolyline(t.legs[0].shape));

    lastTrips  = trips;
    lastCoords = coords;

    drawRoutes(trips, coords);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't get routes: " + err.message;
  }
}

// ---------- 6. rescoreRoutes — called by incidents.js when incidents change ----------
function rescoreRoutes() {
  if (!lastTrips.length) return;
  drawRoutes(lastTrips, lastCoords);
}

// ---------- 7. Select 3 display slots from a scored+ranked pool ----------
//
// Slot rules (applied in order):
//   Slot 0 — "Safest":   the cleanest route (fewest high-risk incidents, then fewest
//             medium, then shortest time). Must have zero high-risk incidents if any
//             such route exists in the pool.
//   Slot 1 — "Balanced": the best route that is NOT the same as slot 0 and is not
//             identical to slot 2. Prefer low/no risk; allow medium if nothing better.
//   Slot 2 — "Fastest":  the route with the shortest walking time that is not already
//             chosen for slots 0 or 1.
//
// If the pool has fewer than 3 distinct routes, slots are filled with the best
// available options (duplicates are not shown; the panel shrinks gracefully).
function selectSlots(scored) {
  // scored is already sorted ascending by _routeCost from scoreAndRankRoutes

  // Slot 0: safest — pick the route with the lowest (highRisk, mediumRisk, time) tuple
  const slot0 = [...scored].sort((a, b) => {
    if (a._highRisk   !== b._highRisk)   return a._highRisk   - b._highRisk;
    if (a._mediumRisk !== b._mediumRisk) return a._mediumRisk - b._mediumRisk;
    return a.summary.time - b.summary.time;
  })[0];

  // Slot 2: fastest — shortest time overall
  const slot2candidates = scored.filter((r) => r !== slot0);
  const slot2 = slot2candidates.sort((a, b) => a.summary.time - b.summary.time)[0] ?? null;

  // Slot 1: best remaining that is neither slot0 nor slot2
  const remainingForSlot1 = scored.filter((r) => r !== slot0 && r !== slot2);
  // Among the remaining, prefer the one with the best safety score (lowest routeCost)
  const slot1 = remainingForSlot1[0] ?? null;   // already sorted by routeCost

  return [slot0, slot1, slot2].filter(Boolean);
}

// ---------- 8. Draw routes ----------
function drawRoutes(trips, coords) {
  routeLines.forEach((l) => l.remove());
  routeLines = [];
  routesEl.innerHTML = "";

  // Score all candidates using the dynamic engine in incidents.js.
  // Falls back to raw ordering if incidents.js hasn't loaded yet.
  let scored;
  if (typeof scoreAndRankRoutes === "function") {
    scored = scoreAndRankRoutes(trips, coords, IS_NIGHT, FIXED_PREFERENCE);
  } else {
    scored = trips.map((trip, i) => ({
      ...trip,
      _index: i,
      _coords: coords[i],
      _penalty: 0,
      _routeCost: trip.summary.length * 1000,
      _nearbyIncidents: [],
      _highRisk: 0,
      _mediumRisk: 0,
      _lowRisk: 0,
      _avoided: false,
    }));
  }

  // Pick the 3 display slots
  const slots = selectSlots(scored);
  const slotLabels = ["Safest", "Balanced", "Fastest"];

  slots.forEach((trip, rank) => {
    const color = ROUTE_COLORS[rank];
    const line  = L.polyline(trip._coords, {
      color,
      weight: rank === 0 ? 7 : 5,
      opacity: rank === 0 ? 0.92 : 0.7,
    }).addTo(map);
    routeLines.push(line);

    const km  = trip.summary.length.toFixed(2);
    const min = Math.round(trip.summary.time / 60);
    const item = document.createElement("div");
    item.className = "route-item";

    const badgeHtml   = buildSafetyBadgeHtml(trip);
    const penaltyStr  = trip._penalty !== null ? `⚠ ${trip._penalty.toFixed(2)} pts` : "";
    const slotBadge   = `<span class="slot-badge slot-${rank}">${slotLabels[rank]}</span>`;

    item.innerHTML =
      `<div class="route-header">` +
        `<span class="swatch" style="background:${color}"></span>` +
        `<span class="route-title">Route ${rank + 1} ${slotBadge}</span>` +
      `</div>` +
      `<div class="route-meta">` +
        `<span>📏 ${km} km</span>` +
        `<span>🕑 ${min} min</span>` +
        (penaltyStr ? `<span>${penaltyStr}</span>` : "") +
      `</div>` +
      badgeHtml;

    routesEl.appendChild(item);
  });

  if (routeLines.length) {
    map.fitBounds(L.featureGroup(routeLines).getBounds(), { padding: [40, 40] });
  }
  statusEl.textContent = `${slots.length} route${slots.length !== 1 ? "s" : ""} found. Press Reset to try again.`;
}

// ---------- 9. Build safety badge HTML ----------
function buildSafetyBadgeHtml(trip) {
  if (!trip._nearbyIncidents.length) {
    return `<div class="route-safety-row"><span class="safety-chip safe">✅ No active reports on this route</span></div>`;
  }
  const chips = [];
  if (trip._highRisk)   chips.push(`<span class="safety-chip high">🔴 ${trip._highRisk} high-risk</span>`);
  if (trip._mediumRisk) chips.push(`<span class="safety-chip medium">🟠 ${trip._mediumRisk} medium-risk</span>`);
  if (trip._lowRisk)    chips.push(`<span class="safety-chip low">🟡 ${trip._lowRisk} low-risk</span>`);
  return `<div class="route-safety-row">${chips.join("")}</div>`;
}

// ---------- 10. Decode Valhalla's encoded polyline ----------
function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const result = [];
  while (index < str.length) {
    let shift = 0, res = 0, byte;
    do { byte = str.charCodeAt(index++) - 63; res |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += res & 1 ? ~(res >> 1) : res >> 1;
    shift = 0; res = 0;
    do { byte = str.charCodeAt(index++) - 63; res |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += res & 1 ? ~(res >> 1) : res >> 1;
    result.push([lat / factor, lng / factor]);
  }
  return result;
}
