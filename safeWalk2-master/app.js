// app.js — SafeWalk main application
// Load order: config.js → vision.js → app.js → incidents.js → crimes.js → avoid.js

// ---------- 1. Settings ----------
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";
const SAN_JOSE     = [37.3382, -121.8863];

// One fixed color per display slot (slot 0 = safest, slot 1 = balanced, slot 2 = fastest)
const ROUTE_COLORS = ["#2563eb", "#16a34a", "#ea580c"];

// Route scoring always uses the balanced weight. Night-mode weighting is always on
// because SafeWalk is designed for nighttime walking — no toggle needed.
const FIXED_PREFERENCE = "balanced";
const IS_NIGHT         = true;   // always apply night multipliers

const MAX_DETOUR_RATIO = 2.0;    // drop candidate routes more than 2x as long as the shortest one
const VIA_MIN_TRIP_M   = 300;    // don't bother with side-street detours on trips shorter than this

// ---------- 2. Create the map ----------
const map = L.map("map").setView(SAN_JOSE, 14);
L.tileLayer(
  `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CONFIG.CARTO_KEY}`,
  {
    maxZoom: 19,
    maxNativeZoom: 18, // beyond zoom 18, stretch the zoom-18 tiles instead of requesting tiles that may not exist
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }
).addTo(map);

// ---------- 3. Route state ----------
let pointA     = null;
let pointB     = null;
let markers    = [];
let routeLines = [];
// lastTrips / lastCoords: kept so incidents.js and crimes.js can re-score without re-fetching.
let lastTrips  = [];
let lastCoords = [];
// lastA / lastB / lastAvoidKey: remember the trip and which hazards were avoided, so we
// only ask Valhalla again when the list of hazards to avoid actually changes.
let lastA = null;
let lastB = null;
let lastAvoidKey = "";
let routeNote = "";        // short extra text for the status line
let routeRequestId = 0;    // numbers each search, so a slow old one can't overwrite a newer one

const statusEl = document.getElementById("status");
const routesEl = document.getElementById("routes");

// Remember which side the SafeWalk control panel belongs on.
const panel = document.getElementById("panel");
const panelPosition = document.getElementById("panel-position");
const savedPanelPosition = localStorage.getItem("safewalk-panel-position") || "left";
panelPosition.value = savedPanelPosition;
panel.classList.toggle("panel-right", savedPanelPosition === "right");
panelPosition.addEventListener("change", () => {
  const position = panelPosition.value === "right" ? "right" : "left";
  panel.classList.toggle("panel-right", position === "right");
  localStorage.setItem("safewalk-panel-position", position);
});

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
  routeRequestId++;   // any search still running is now stale
  pointA = null;
  pointB = null;
  markers.forEach((m) => m.remove());
  routeLines.forEach((l) => l.remove());
  markers    = [];
  routeLines = [];
  lastTrips  = [];
  lastCoords = [];
  lastA = null;
  lastB = null;
  lastAvoidKey = "";
  routeNote = "";
  routesEl.innerHTML = "";
  statusEl.textContent = "Click the map to set your start point (A).";
}

// ---------- 5. Ask Valhalla for routes ----------
// Valhalla's alternates are all variations of the same corridor, so on their own they often
// pass the same hazards. We build a bigger, more varied pool of candidates, then score them
// all ourselves and keep the best three:
//   1) a normal search (includes the quickest route),
//   2) a search that blocks small squares around reported hazards (exclude_polygons). If that
//      fails because no path exists, we retry with fewer hazards instead of giving up,
//   3) two searches that pass through a point to the left / right of the straight line A→B,
//      which forces genuinely different streets.
async function getRoutes(a, b) {
  const myId = ++routeRequestId;
  lastA = a;
  lastB = b;
  const avoid = buildAvoidLocations(a, b);   // defined in avoid.js
  lastAvoidKey = avoidKey(avoid);
  routeNote = "";

  try {
    const prefetch = prefetchCrimes(a, b);   // loads crime reports around A–B while Valhalla works

    const [normalTrips, around] = await Promise.all([
      requestRoutes(a, b, null, 4).then(tripsFrom),
      searchAroundHazards(a, b, avoid),
    ]);
    let trips = normalTrips;

    if (around) {
      trips = trips.concat(around.trips);
      const n = around.tier.points.length;
      routeNote = ` Searched around ${n} reported hazard${n !== 1 ? "s" : ""}.`;
    } else if (avoid.length) {
      routeNote = " No detour around the reported hazards was possible.";
    }

    // Side-street candidates (use the same avoid set that worked above, if any)
    trips = trips.concat(await searchViaRoutes(a, b, around ? around.tier : null));

    trips = dropLongDetours(removeDuplicateTrips(trips));
    const coords = trips.map((t) => decodePolyline(t.legs[0].shape));
    console.info(`Route pool: ${trips.length} distinct candidate route(s)`);

    // Make sure crime reports along every candidate are loaded BEFORE we score
    await prefetch;
    await loadCrimesAlong(coords);
    if (typeof loadLightsAlong === "function") await loadLightsAlong(coords);
    if (myId !== routeRequestId) return;   // user pressed Reset or started over

    lastTrips  = trips;
    lastCoords = coords;
    drawRoutes(trips, coords, true);
  } catch (err) {
    if (myId !== routeRequestId) return;
    console.error(err);
    statusEl.textContent = "Couldn't get routes: " + err.message;
  }
}

// Sends one request to Valhalla.
//   tier:       an avoid tier from avoid.js (or null for no avoiding)
//   alternates: how many alternative routes to ask for (ignored when `via` is used)
//   via:        optional {lat, lon} the route must pass through on the way from A to B
async function requestRoutes(a, b, tier, alternates, via = null) {
  const locations = [{ lat: a.lat, lon: a.lng }];
  if (via) locations.push({ lat: via.lat, lon: via.lon, type: "through" }); // "through" keeps it one leg
  locations.push({ lat: b.lat, lon: b.lng });

  const body = {
    locations,
    costing: "pedestrian",
    directions_options: { units: "kilometers" },
  };
  if (!via) body.alternates = alternates;                    // Valhalla only allows alternates for 2 points
  if (tier && tier.points.length) Object.assign(body, avoidRequestFields(tier)); // avoid.js

  const res = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Valhalla returned HTTP " + res.status);
  return res.json();
}

// Try avoiding every hazard; if no path exists, try fewer. Never throws: returns
// {trips, tier} for the first tier that works, or null.
async function searchAroundHazards(a, b, avoid) {
  if (!avoid.length) return null;
  for (const tier of avoidTiers(avoid)) {
    try {
      const trips = tripsFrom(await requestRoutes(a, b, tier, 3));
      return { trips, tier };
    } catch (err) {
      console.warn(`Avoid search (${tier.points.length} hazards, ${tier.as}) failed:`, err.message);
    }
  }
  return null;
}

// Two extra searches that are forced through a point beside the straight A→B line.
async function searchViaRoutes(a, b, tier) {
  const results = await Promise.allSettled(
    viaPoints(a, b).map((via) => requestRoutes(a, b, tier, 0, via))
  );
  const trips = [];
  for (const r of results) {
    if (r.status === "fulfilled") trips.push(...tripsFrom(r.value));
    else console.warn("Side-street search failed:", r.reason?.message || r.reason);
  }
  return trips;
}

// A point left and a point right of the middle of A→B, a third of the trip length away
// (clamped to 150–500 m), so the routes through them use different streets.
function viaPoints(a, b) {
  const dist = haversineMeters(a.lat, a.lng, b.lat, b.lng);   // from incidents.js
  if (dist < VIA_MIN_TRIP_M) return [];
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const cos = Math.cos(midLat * Math.PI / 180);
  const dx = (b.lng - a.lng) * 111320 * cos;   // A→B in metres (east)
  const dy = (b.lat - a.lat) * 111320;         //               (north)
  const len = Math.hypot(dx, dy);
  const px = -dy / len;                        // unit vector at 90° to A→B
  const py = dx / len;
  const offset = Math.max(150, Math.min(500, dist * 0.3));
  return [1, -1].map((side) => ({
    lat: midLat + (py * offset * side) / 111320,
    lon: midLng + (px * offset * side) / (111320 * cos),
  }));
}

// Valhalla puts the main route in data.trip and the extra ones in data.alternates[i].trip
function tripsFrom(data) {
  return [data.trip, ...(data.alternates || []).map((alt) => alt.trip)];
}

// The searches can return the very same route. Routes with identical paths are
// duplicates, so keep only the first of each.
function removeDuplicateTrips(trips) {
  const seen = new Set();
  return trips.filter((trip) => {
    const key = trip.legs[0].shape;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A route through a side-street point can wander. Drop anything far longer than the shortest.
function dropLongDetours(trips) {
  const shortest = Math.min(...trips.map((t) => t.summary.length));
  return trips.filter((t) => t.summary.length <= shortest * MAX_DETOUR_RATIO);
}

// ---------- 5b. Crime data for scoring (loaders live in crimes.js) ----------
// Crime failures must never stop routing, so both helpers swallow their errors.
function prefetchCrimes(a, b) {
  if (typeof loadCrimesForBounds !== "function") return Promise.resolve();
  const pad = 0.006; // ~600 m around the straight A–B box
  const bounds = L.latLngBounds(
    [Math.min(a.lat, b.lat) - pad, Math.min(a.lng, b.lng) - pad],
    [Math.max(a.lat, b.lat) + pad, Math.max(a.lng, b.lng) + pad]
  );
  return loadCrimesForBounds(bounds).catch((err) => console.warn("Crime prefetch failed:", err));
}

async function loadCrimesAlong(allCoords) {
  if (typeof loadCrimesForBounds !== "function") return;
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const coords of allCoords) {
    for (const [lat, lng] of coords) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
    }
  }
  if (!isFinite(s)) return;
  const pad = 0.001;
  try {
    await loadCrimesForBounds(L.latLngBounds([s - pad, w - pad], [n + pad, e + pad]));
  } catch (err) {
    console.warn("Couldn't load crime reports along the routes:", err);
  }
}

function routeBounds(a, b) {
  const pad = 0.006; // roughly 600 m around the straight A–B box
  return L.latLngBounds(
    [Math.min(a.lat, b.lat) - pad, Math.min(a.lng, b.lng) - pad],
    [Math.max(a.lat, b.lat) + pad, Math.max(a.lng, b.lng) + pad]
  );
}

// ---------- 6. rescoreRoutes — called by incidents.js and crimes.js when data changes ----------
// If the set of hazards to avoid has changed (a new report, a vote, a removal), the
// detours Valhalla gave us are out of date, so ask Valhalla again. Otherwise just re-score
// (without moving the map, so a background refresh never yanks the view away).
function rescoreRoutes() {
  if (!lastTrips.length) return;
  if (lastA && lastB && avoidKey(buildAvoidLocations(lastA, lastB)) !== lastAvoidKey) {
    getRoutes(lastA, lastB);
    return;
  }
  drawRoutes(lastTrips, lastCoords, false);
}

// ---------- 7. Select 3 display slots from a scored pool ----------
// Each result is {trip, slot}, where slot 0 = Safest, 1 = Balanced, 2 = Fastest.
//   Safest   — the lowest total risk (hazards + crime). Ties go to the quicker route.
//   Fastest  — the shortest walking time among the rest.
//   Balanced — the best remaining route by overall cost (distance + risk detour cost).
// With fewer than 3 distinct routes the panel simply shows fewer.
function selectSlots(scored) {
  // Round to half a point so a trivially lower risk doesn't beat a much faster route
  const bucket = (r) => Math.round(r._riskPts * 2) / 2;

  const safest = [...scored].sort(
    (a, b) => bucket(a) - bucket(b) || a.summary.time - b.summary.time
  )[0];
  const fastest = scored
    .filter((r) => r !== safest)
    .sort((a, b) => a.summary.time - b.summary.time)[0] ?? null;
  const balanced = scored.find((r) => r !== safest && r !== fastest) ?? null; // scored is sorted by cost

  return [
    safest   && { trip: safest,   slot: 0 },
    balanced && { trip: balanced, slot: 1 },
    fastest  && { trip: fastest,  slot: 2 },
  ].filter(Boolean);
}

// ---------- 8. Draw routes ----------
// fit = true moves the map to show the routes (only for a fresh search).
function drawRoutes(trips, coords, fit = true) {
  routeLines.forEach((l) => l.remove());
  routeLines = [];
  routesEl.innerHTML = "";

  // Score all candidates using the engine in incidents.js
  let scored;
  if (typeof scoreAndRankRoutes === "function") {
    scored = scoreAndRankRoutes(trips, coords, IS_NIGHT, FIXED_PREFERENCE);
  } else {
    scored = trips.map((trip, i) => ({
      ...trip,
      _index: i,
      _coords: coords[i],
      _riskPts: 0,
      _riskScore: 0,
      _crimeCount: 0,
      _routeCost: trip.summary.length * 1000,
      _nearbyIncidents: [],
      _highRisk: 0,
      _mediumRisk: 0,
      _lowRisk: 0,
    }));
  }

  const slots = selectSlots(scored);
  const slotLabels = ["Safest", "Balanced", "Fastest"];

  slots.forEach(({ trip, slot }, n) => {
    const color = ROUTE_COLORS[slot];
    const lineOptions = {
      color,
      weight: slot === 0 ? 7 : 5,
      opacity: slot === 0 ? 0.92 : 0.7,
    };
    const lines = typeof drawRouteWithLighting === "function"
      ? drawRouteWithLighting(trip._coords, color, lineOptions)
      : [L.polyline(trip._coords, lineOptions).addTo(map)];
    routeLines.push(...lines);

    const km  = trip.summary.length.toFixed(2);
    const min = Math.round(trip.summary.time / 60);
    const level = riskLevel(trip._riskScore);
    const item = document.createElement("div");
    item.className = "route-item";

    item.innerHTML =
      `<div class="route-header">` +
        `<span class="swatch" style="background:${color}"></span>` +
        `<span class="route-title">Route ${n + 1} <span class="slot-badge slot-${slot}">${slotLabels[slot]}</span></span>` +
      `</div>` +
      `<div class="route-meta">` +
        `<span>📏 ${km} km</span>` +
        `<span>🕑 ${min} min</span>` +
        `<span class="risk-badge risk-${level.key}" title="Combines reported hazards and recent crime near the route">Risk ${trip._riskScore}/100 · ${level.label}</span>` +
        (trip._lightingAvailable ? `<span class="light-badge" title="Estimated share of the route within walking distance of a mapped street light">💡 ${Math.round(trip._lightingCoverage * 100)}% lit</span>` : "") +
      `</div>` +
      buildSafetyBadgeHtml(trip);

    routesEl.appendChild(item);
  });

  if (fit && routeLines.length) {
    map.fitBounds(L.featureGroup(routeLines).getBounds(), { padding: [40, 40] });
  }

  // Be honest when there is no clean option
  let warning = "";
  const best = slots[0]?.trip;
  if (best && best._highRisk > 0) {
    warning = ` ⚠ No hazard-free route found: even the safest option passes ${best._highRisk} high-risk report${best._highRisk !== 1 ? "s" : ""}.`;
  }
  statusEl.textContent =
    `${slots.length} route${slots.length !== 1 ? "s" : ""} found.${routeNote}${warning} Press Reset to try again.`;
}

// 0–100 risk score → a word and a CSS key
function riskLevel(score) {
  if (score < 25) return { key: "low", label: "Low" };
  if (score < 55) return { key: "moderate", label: "Moderate" };
  return { key: "high", label: "High" };
}

// ---------- 9. Build safety badge HTML ----------
function buildSafetyBadgeHtml(trip) {
  if (!trip._nearbyIncidents.length && !trip._crimeCount) {
    return `<div class="route-safety-row"><span class="safety-chip safe">✅ No active reports on this route</span></div>`;
  }
  const chips = [];
  if (trip._highRisk)   chips.push(`<span class="safety-chip high">🔴 ${trip._highRisk} high-risk</span>`);
  if (trip._mediumRisk) chips.push(`<span class="safety-chip medium">🟠 ${trip._mediumRisk} medium-risk</span>`);
  if (trip._lowRisk)    chips.push(`<span class="safety-chip low">🟡 ${trip._lowRisk} low-risk</span>`);
  if (trip._crimeCount) chips.push(`<span class="safety-chip crime">🚨 ${trip._crimeCount} police report${trip._crimeCount !== 1 ? "s" : ""} nearby</span>`);
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
