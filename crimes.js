// crimes.js: loads crime reports from the Supabase "crimes" table, draws them as dots or as
// highlighted street blocks, lets a slider hide older ones, and gives every crime a risk
// "penalty" (severity x recency) that incidents.js uses when scoring routes.
// Loaded AFTER incidents.js, because it uses things defined earlier:
//   map, db, haversineMeters, distToPolylineMeters (incidents.js), lastTrips / rescoreRoutes (app.js)

// ---------- 1. Layer setup ----------
// A canvas renderer draws all the dots onto ONE <canvas> instead of thousands of
// separate page elements, which keeps the map smooth.
const crimeRenderer = L.canvas({ padding: 0.5 });
const crimeLayer = L.layerGroup().addTo(map); // the dots currently visible
const crimes = [];                            // every crime loaded so far: {id, date, reason, address, lat, lng}
const crimeMarkers = [];                      // every dot ever created: {marker, date}, whether visible or not
const loadedCrimeIds = new Set();             // ids we already created, so we never create one twice
const crimeAreasLoaded = [];                  // map areas (LatLngBounds) we have already fetched crimes for

const MIN_CRIME_ZOOM = 12;  // zoomed out further than this, don't load anything
let crimeRequestId = 0;     // numbers each view load, so slow old requests can be ignored

const crimeToggle = document.getElementById("crime-toggle");
const crimeStreetsToggle = document.getElementById("crime-streets-toggle");
const crimeInfo = document.getElementById("crime-info");
const crimeDaysInput = document.getElementById("crime-days");
const crimeDaysLabel = document.getElementById("crime-days-label");
let crimeDays = Number(crimeDaysInput.value);          // slider value: show crimes up to this many days old
const MAX_CRIME_DAYS = Number(crimeDaysInput.max) || 31; // we never load anything older than the slider's maximum

// ---------- 2. Crime severity and recency (used for street colours AND route scoring) ----------
// Your data is police calls and stops, and most of them are routine (vehicle stops, parking,
// welfare checks...). So every reason gets a severity from 0 to 10, and the FIRST pattern that
// matches wins (order matters: routine things are checked first, so "VEHICLE STOP" is not
// mistaken for a vehicle crime). Anything below MIN_COUNTED_SEVERITY is ignored completely:
// not drawn, not counted, not scored. Reasons nothing matches get DEFAULT_CRIME_SEVERITY.
// To change how a reason is treated, edit this list.
const CRIME_SEVERITY = [
  // Routine police activity or non-criminal calls: no threat to someone walking
  [/\bstop\b|animal|parking|welfare|civil|traffic|accident|collision|lost|found|alarm|fireworks|music|noise|escort|standby|follow.?up|paperwork|information/i, 0],
  // Serious violence
  [/homicide|murder|manslaughter|shoot|shots fired|stabb|rape|sexual assault|kidnap|robbery|carjack|armed|strong.?arm/i, 10],
  [/assault|battery|fight|brandish/i, 8],
  [/weapon|threat|stalk|harass/i, 6],
  [/burglary|break.?in|theft from person|purse|snatch|domestic/i, 4],
  [/indecent|exposure|drunk|intoxic|narcotic|drug|prowl|trespass/i, 3],
  [/theft|larceny|stolen|vandal|graffiti|mischief|resisting/i, 2],
  [/suspicious|mentally|disturb/i, 1],
];
const DEFAULT_CRIME_SEVERITY = 1;
const MIN_COUNTED_SEVERITY = 0.5;  // anything lower is routine and ignored everywhere
const CRIME_HALF_LIFE_DAYS = 21;   // a report counts half as much after this many days
const CRIME_SCALE = 0.25;          // scales crime points to be comparable with hazard points
let routineSkipped = 0;            // how many routine reports we loaded but ignored (shown in the panel)

function crimeSeverity(reason) {
  const text = reason || "";
  for (const [pattern, severity] of CRIME_SEVERITY) {
    if (pattern.test(text)) return severity;
  }
  return DEFAULT_CRIME_SEVERITY;
}

function crimeDanger(reason) {
  const severity = crimeSeverity(reason);
  if (severity < MIN_COUNTED_SEVERITY) return { key: "routine", label: "Routine / low concern", score: severity };
  if (severity < 2) return { key: "low", label: "Low", score: severity };
  if (severity < 4) return { key: "moderate", label: "Moderate", score: severity };
  if (severity < 7) return { key: "high", label: "High", score: severity };
  return { key: "severe", label: "Severe", score: severity };
}

function crimeDangerBadge(reason) {
  const danger = crimeDanger(reason);
  const badge = document.createElement("span");
  badge.className = `crime-danger crime-danger-${danger.key}`;
  badge.textContent = `Danger: ${danger.label}`;
  badge.title = `Classified severity score: ${danger.score}/10`;
  return badge;
}

// How much one crime adds to a street's colour / a route's risk: severity x recency
function crimePenalty(crime) {
  const age = crimeAgeDays(crime.date);
  if (!isFinite(age)) return 0;
  return crimeSeverity(crime.reason) * Math.pow(2, -Math.max(0, age) / CRIME_HALF_LIFE_DAYS) * CRIME_SCALE;
}

// ---------- 3. Dates and the recency slider ----------
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// How many days ago was this crime? `dateStr` looks like "2026-10-01".
function crimeAgeDays(dateStr) {
  if (!dateStr) return Infinity; // no date, so treat it as too old to show
  const [y, m, d] = String(dateStr).split(/[-/]/).map(Number); // accepts 2026-10-01 and 2026/10/1
  return Math.round((startOfToday() - new Date(y, m - 1, d)) / 86400000); // 86,400,000 ms in a day
}

// The oldest date allowed, as "YYYY-MM-DD", for database queries.
function crimeCutoffISO(days = crimeDays) {
  const cutoff = startOfToday();
  cutoff.setDate(cutoff.getDate() - days);
  const mm = String(cutoff.getMonth() + 1).padStart(2, "0");
  const dd = String(cutoff.getDate()).padStart(2, "0");
  return `${cutoff.getFullYear()}-${mm}-${dd}`;
}

// Show or hide each dot based on its age, and recolour the streets. Nothing is reloaded,
// so moving the slider is instant.
function applyCrimeFilter() {
  for (const { marker, date } of crimeMarkers) {
    if (crimeAgeDays(date) <= crimeDays) {
      if (!crimeLayer.hasLayer(marker)) crimeLayer.addLayer(marker);
    } else {
      crimeLayer.removeLayer(marker);
    }
  }
  redrawStreets();
}

function updateCrimeInfo() {
  if (!crimeToggle.checked) { crimeInfo.textContent = ""; return; }
  if (map.getZoom() < MIN_CRIME_ZOOM) { crimeInfo.textContent = "Zoom in to load crime reports."; return; }

  let text = `${crimeLayer.getLayers().length} of ${crimes.length} reports are within ${crimeDays} days`;
  if (routineSkipped) text += ` (${routineSkipped} routine stops and calls ignored)`;
  if (crimeStreetsEnabled()) {
    if (streetsRecentlyFailed()) text += " · street data unavailable, showing dots";
    else if (map.getZoom() < STREET_MIN_ZOOM) text += " · zoom in to highlight streets";
    else if (!chunks.length) text += " · no walkable street geometry loaded yet";
    else if (streetsActive()) text += ` · ${highlightedBlocks} street blocks highlighted`;
    else text += " · loading streets…";
  }
  crimeInfo.textContent = text;
}

// "input" fires continuously while dragging: update the dots, streets and label.
let rescoreTimer = null;
crimeDaysInput.addEventListener("input", () => {
  crimeDays = Number(crimeDaysInput.value);
  crimeDaysLabel.textContent = crimeDays;
  applyCrimeFilter();
  // The route scores and the "N reports nearby" counts use the same date range as the dots,
  // so re-score once the slider settles.
  clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(() => {
    if (typeof lastTrips !== "undefined" && lastTrips.length) rescoreRoutes();
  }, 150);
});

// ---------- 4. Load crimes from the database ----------
// Fetches every crime inside `bounds` from the last MAX_CRIME_DAYS days, 1000 rows at a time
// (Supabase's limit). Returns how many NEW crimes were added, or null if `shouldCancel()` says
// a newer load has taken over. Throws on a database error.
async function fetchCrimesInBounds(bounds, shouldCancel) {
  const PAGE_SIZE = 1000;
  const cutoff = crimeCutoffISO(MAX_CRIME_DAYS);
  let from = 0;
  let added = 0;

  while (true) {
    const { data, error } = await db
      .from("crimes")
      .select("id, occurred_on, reason, address, lat, lng")
      .gte("occurred_on", cutoff)
      .gte("lat", bounds.getSouth()).lte("lat", bounds.getNorth())   // between the bottom and top edge
      .gte("lng", bounds.getWest()).lte("lng", bounds.getEast())     // between the left and right edge
      .order("id", { ascending: true }) // stable order, so pages never overlap or skip rows
      .range(from, from + PAGE_SIZE - 1);

    if (shouldCancel && shouldCancel()) return null;
    if (error) throw error;

    for (const row of data) if (addCrime(row)) added++;
    if (data.length < PAGE_SIZE) break; // that was the last page
    from += PAGE_SIZE;
  }

  crimeAreasLoaded.push(bounds);
  return added;
}

function crimeAreaCovered(bounds) {
  return crimeAreasLoaded.some((area) => area.contains(bounds));
}

// Load what is on screen (padded by 30% so dots just off-screen are ready when you pan).
async function loadCrimesInView() {
  if (!crimeToggle.checked) return;
  if (map.getZoom() < MIN_CRIME_ZOOM) return;

  const myRequest = ++crimeRequestId;     // if the user pans again, a newer load takes over
  const bounds = map.getBounds().pad(0.3);

  try {
    if (!crimeAreaCovered(bounds)) {
      const added = await fetchCrimesInBounds(bounds, () => myRequest !== crimeRequestId);
      if (added === null) return;
      // New crimes may change the score of routes already on screen
      if (added > 0 && typeof lastTrips !== "undefined" && lastTrips.length) rescoreRoutes();
    }
  } catch (err) {
    console.error(err);
    crimeInfo.textContent = "Couldn't load crime data: " + err.message;
    return;
  }

  updateCrimeInfo();
  loadStreetsInView();
}

// Used by app.js: make sure crimes for a route area are loaded BEFORE the routes are scored.
// Works even when the crime layer is switched off.
async function loadCrimesForBounds(bounds) {
  if (crimeAreaCovered(bounds)) return 0;
  return fetchCrimesInBounds(bounds, null);
}

// ---------- 5. Create one crime dot ----------
// Returns true if this crime was new.
function addCrime(row) {
  if (loadedCrimeIds.has(row.id)) return false; // already created
  loadedCrimeIds.add(row.id);

  // Routine stops and non-criminal calls are not shown, counted or scored
  if (crimeSeverity(row.reason) < MIN_COUNTED_SEVERITY) {
    routineSkipped++;
    return false;
  }

  const crime = {
    id: row.id,
    date: row.occurred_on,
    reason: row.reason,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
  };
  crimes.push(crime);

  const marker = L.circleMarker([crime.lat, crime.lng], {
    renderer: crimeRenderer,
    radius: 4,
    color: "#7c2d12",
    weight: 1,
    fillColor: "#f97316",
    fillOpacity: 0.55,
  }).bindPopup(buildCrimePopup(crime));

  crimeMarkers.push({ marker, date: crime.date });
  if (crimeAgeDays(crime.date) <= crimeDays) marker.addTo(crimeLayer); // only show it if it's recent enough
  return true;
}

// Built with textContent (not innerHTML) so text from the data can't inject HTML.
function buildCrimePopup(crime) {
  const box = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = crime.reason || "Crime report";
  const danger = document.createElement("div");
  danger.appendChild(crimeDangerBadge(crime.reason));
  const address = document.createElement("div");
  address.textContent = crime.address || "";
  const date = document.createElement("div");
  date.textContent = crime.date || "";
  box.append(title, danger, address, date);
  return box;
}

// ---------- 6. Street highlighting ----------
// Crime locations are usually rounded to a block or intersection, so a dot is slightly misleading.
// Instead we download the street lines for the area from OpenStreetMap (Overpass), cut them into
// ~100 m blocks, attach each crime to the nearest block, and colour the blocks by their total
// crime points (severity x recency). If the street data can't load, dots are shown instead.
const STREET_MIN_ZOOM = 15;          // street data is only fetched at this zoom or closer
const STREET_VIEW_PAD = 0.05;        // small buffer around the current viewport
const STREET_RETRY_MS = 60 * 1000;   // after a failure, wait this long before trying again
const CHUNK_METERS = 100;            // length of one highlighted block
const MAX_SNAP_METERS = 60;          // a crime further than this from any street stays a dot
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";
// Streets people drive/walk along; skips alleys, driveways, footpaths and freeways
const ROAD_TYPES = "trunk|primary|secondary|tertiary|unclassified|residential|living_street|footway|pedestrian|path|cycleway|steps|trunk_link|primary_link|secondary_link|tertiary_link";

// Streets sit BELOW the route lines (overlay pane is 400) but above the map tiles.
map.createPane("crimeStreets");
map.getPane("crimeStreets").style.zIndex = 380;
const streetRenderer = L.canvas({ pane: "crimeStreets", padding: 0.5 });
const streetLayer = L.layerGroup().addTo(map);

const chunks = [];                  // every street block: {coords, bbox, nameNorm, crimes, line}
const hotChunks = new Set();        // blocks that have at least one crime attached
const loadedWayIds = new Set();
const roadAreasLoaded = [];         // {full, inner} bounds we already have street data for
let highlightedBlocks = 0;
let streetsFetching = false;
let streetsPending = false;
let streetsFailedAt = 0;

function streetsRecentlyFailed() {
  return streetsFailedAt > 0 && Date.now() - streetsFailedAt < STREET_RETRY_MS;
}

// Is street highlighting actually on screen right now?
function streetsActive() {
  return crimeStreetsEnabled() &&
    map.getZoom() >= STREET_MIN_ZOOM &&
    roadAreasLoaded.some((area) => area.full.intersects(map.getBounds()));
}

function setLayerVisible(layer, visible) {
  if (visible && !map.hasLayer(layer)) layer.addTo(map);
  if (!visible && map.hasLayer(layer)) layer.remove();
}

// Streets replace the dots while they are available; otherwise the dots stay.
function syncCrimeVisibility() {
  const on = crimeToggle.checked;
  const useStreets = on && streetsActive();
  setLayerVisible(crimeLayer, on && !useStreets);
  setLayerVisible(streetLayer, useStreets);
}

function crimeStreetsEnabled() {
  return crimeStreetsToggle.getAttribute("aria-pressed") === "true";
}

function updateCrimeViewButton() {
  crimeStreetsToggle.textContent = crimeStreetsEnabled()
    ? "━ Street lines (click for reports)"
    : "● Crime circles (click for reports)";
}

// "N 1st Street" and "NORTH 1ST ST" should look the same when we compare names.
const STREET_ABBREV = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", STREET: "ST", AVENUE: "AVE", BOULEVARD: "BLVD",
  ROAD: "RD", DRIVE: "DR", COURT: "CT", LANE: "LN", PLACE: "PL", PARKWAY: "PKWY", CIRCLE: "CIR",
  TERRACE: "TER", HIGHWAY: "HWY", EXPRESSWAY: "EXPY", SAINT: "ST",
  AV: "AVE", BL: "BLVD", WY: "WAY", PKY: "PKWY",
};
function normalizeStreet(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => STREET_ABBREV[word] || word)
    .join(" ");
}

// Download street lines inside `bounds` as an array of OSM ways: {id, tags, geometry:[{lat, lon}]}
async function fetchRoads(bounds) {
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  // Keep the request focused on named/usable walking streets. Smaller GET
  // requests are more reliable in browsers than the old large POST request.
  const query = `[out:json][timeout:20];way["highway"~"^(${ROAD_TYPES})$"](${bbox});out tags geom;`;
  let lastError;
  for (const endpoint of OVERPASS_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const url = `${endpoint}?data=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
      const json = await res.json();
      const ways = (json.elements || []).filter((el) => el.type === "way" && el.geometry);
      if (!ways.length) throw new Error("street service returned no roads for this San José area");
      return ways;
    } catch (err) {
      lastError = err;
      console.warn(`Street lookup failed at ${endpoint}:`, err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // Last-resort fallback: the standard OSM map endpoint returns XML for a small
  // bounding box and is often available when Overpass is rate-limited.
  try {
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
    const res = await fetch(`${OSM_MAP_URL}?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) throw new Error(`OSM map returned HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
    const nodeMap = new Map([...xml.querySelectorAll("node")].map((node) => [
      node.getAttribute("id"),
      { lat: Number(node.getAttribute("lat")), lon: Number(node.getAttribute("lon")) },
    ]));
    const ways = [...xml.querySelectorAll("way")].map((way) => {
      const tags = Object.fromEntries([...way.querySelectorAll(":scope > tag")].map((tag) => [
        tag.getAttribute("k"), tag.getAttribute("v"),
      ]));
      const geometry = [...way.querySelectorAll(":scope > nd")]
        .map((nd) => nodeMap.get(nd.getAttribute("ref")))
        .filter(Boolean);
      return { id: way.getAttribute("id"), tags, geometry };
    }).filter((way) => ROAD_TYPES.split("|").includes(way.tags.highway) && way.geometry.length > 1);
    if (!ways.length) throw new Error("OSM map returned no walkable roads for this area");
    return ways;
  } catch (err) {
    lastError = err;
    console.warn("OSM map fallback failed:", err.message);
  }
  throw lastError || new Error("No street-data service responded");
}

// Cut one street line [[lat, lng], ...] into pieces of about CHUNK_METERS each.
// A long straight block stays one piece, so a piece is roughly "one block".
function splitIntoChunks(coords) {
  const pieces = [];
  let current = [coords[0]];
  let length = 0;
  for (let i = 1; i < coords.length; i++) {
    length += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    current.push(coords[i]);
    if (length >= CHUNK_METERS && i < coords.length - 1) {
      pieces.push(current);
      current = [coords[i]];
      length = 0;
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

function makeChunk(coords, name) {
  const pad = 0.0008; // ~80 m, a little more than MAX_SNAP_METERS
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
  }
  return { coords, bbox: [s - pad, w - pad, n + pad, e + pad], nameNorm: normalizeStreet(name), crimes: [], line: null };
}

function addWays(ways) {
  for (const way of ways) {
    if (loadedWayIds.has(way.id)) continue;
    loadedWayIds.add(way.id);
    const coords = way.geometry.map((g) => [g.lat, g.lon]);
    if (coords.length < 2) continue;
    const name = way.tags?.name || "";
    for (const piece of splitIntoChunks(coords)) chunks.push(makeChunk(piece, name));
  }
}

// Is there street data around this point? (Points right at the edge of the downloaded area
// are skipped, because their true nearest street may not have been downloaded.)
function roadsCover(lat, lng) {
  return roadAreasLoaded.some((area) => area.inner.contains([lat, lng]));
}

// The street block(s) a crime belongs to.
//  • If the crime's address names streets (e.g. "E SANTA CLARA ST & N 1ST ST"), it belongs to the
//    nearest block of EACH named street that is close to it. A crime at a corner therefore
//    lights up both streets, sharing its weight between them.
//  • Otherwise it belongs to the single nearest block within MAX_SNAP_METERS (or none).
function nearestChunks(crime) {
  const address = " " + normalizeStreet(crime.address) + " ";
  let nearest = null;
  let nearestDist = Infinity;
  const namedBest = new Map();   // street name → {ch, d}: nearest block of each street named in the address

  for (const ch of chunks) {
    const [s, w, n, e] = ch.bbox;
    if (crime.lat < s || crime.lat > n || crime.lng < w || crime.lng > e) continue;
    const d = distToPolylineMeters(ch.coords, crime.lat, crime.lng);
    if (d > MAX_SNAP_METERS) continue;
    if (d < nearestDist) { nearestDist = d; nearest = ch; }
    if (ch.nameNorm && address.includes(" " + ch.nameNorm + " ")) {
      const prev = namedBest.get(ch.nameNorm);
      if (!prev || d < prev.d) namedBest.set(ch.nameNorm, { ch, d });
    }
  }

  if (namedBest.size) {
    const closest = Math.min(...[...namedBest.values()].map((v) => v.d));
    return [...namedBest.values()].filter((v) => v.d <= closest + 40).map((v) => v.ch);
  }
  return nearest ? [nearest] : [];
}

// Attach every crime that has street data around it (and isn't attached yet) to its block(s).
function snapPendingCrimes() {
  if (!chunks.length) return;
  for (const crime of crimes) {
    if (crime.chunks !== undefined) continue;     // already handled (a list of blocks, possibly empty)
    if (!roadsCover(crime.lat, crime.lng)) continue;
    crime.chunks = nearestChunks(crime);
    const share = 1 / (crime.chunks.length || 1);  // a corner crime splits its weight between its streets
    for (const ch of crime.chunks) {
      ch.crimes.push({ crime, share });
      hotChunks.add(ch);
    }
  }
}

// Total crime points of one block, counting only crimes inside the slider's date range.
function chunkScore(ch) {
  let total = 0;
  for (const { crime, share } of ch.crimes) {
    if (crimeAgeDays(crime.date) <= crimeDays) total += crimePenalty(crime) * share;
  }
  return total;
}

// Colour and thickness by total crime points. (A fresh robbery is worth about 2 points.)
function streetStyle(score) {
  if (score >= 8)   return { color: "#7f1d1d", weight: 7, opacity: 0.85 };
  if (score >= 4)   return { color: "#dc2626", weight: 6, opacity: 0.8 };
  if (score >= 1.5) return { color: "#f97316", weight: 5, opacity: 0.75 };
  return { color: "#facc15", weight: 5, opacity: 0.7 };
}

function chunkIntersectsView(ch, bounds) {
  const [south, west, north, east] = ch.bbox;
  return bounds.intersects(L.latLngBounds([south, west], [north, east]));
}

function redrawStreets() {
  let shown = 0;
  const visibleBounds = map.getBounds();
  for (const ch of hotChunks) {
    if (!chunkIntersectsView(ch, visibleBounds)) {
      if (ch.line) streetLayer.removeLayer(ch.line);
      continue;
    }
    const score = chunkScore(ch);
    if (score <= 0) {
      if (ch.line) streetLayer.removeLayer(ch.line);
      continue;
    }
    if (!ch.line) {
      ch.line = L.polyline(ch.coords, {
        renderer: streetRenderer,
        interactive: true,
        lineCap: "round",
        lineJoin: "round",
      }).on("click", () => {
        ch.line.bindPopup(buildStreetPopup(ch), { maxWidth: 280 }).openPopup();
      });
    }
    ch.line.setStyle(streetStyle(score));
    ch.line.bindPopup(buildStreetPopup(ch), { maxWidth: 280 });
    if (!streetLayer.hasLayer(ch.line)) streetLayer.addLayer(ch.line);
    shown++;
  }
  highlightedBlocks = shown;
  syncCrimeVisibility();
  updateCrimeInfo();
}

// One highlighted block may represent multiple police reports. Keep the popup
// tied to the block so clicking a line still reveals the underlying reports.
function buildStreetPopup(ch) {
  const box = document.createElement("div");
  box.className = "crime-street-popup";
  const heading = document.createElement("strong");
  heading.textContent = `${ch.nameNorm || "Street block"} · ${ch.crimes.length} report${ch.crimes.length === 1 ? "" : "s"}`;
  box.appendChild(heading);

  [...ch.crimes]
    .filter(({ crime }) => crimeAgeDays(crime.date) <= crimeDays)
    .sort((a, b) => String(b.crime.date).localeCompare(String(a.crime.date)))
    .forEach(({ crime }) => {
      const item = document.createElement("div");
      item.className = "crime-street-report";
      const title = document.createElement("strong");
      title.textContent = crime.reason || "Crime report";
      const danger = document.createElement("div");
      danger.appendChild(crimeDangerBadge(crime.reason));
      const details = document.createElement("div");
      details.textContent = [crime.date, crime.address].filter(Boolean).join(" · ");
      item.append(title, danger, details);
      box.appendChild(item);
    });
  return box;
}

async function loadStreetsInView() {
  if (!crimeToggle.checked || !crimeStreetsEnabled()) return;
  if (map.getZoom() < STREET_MIN_ZOOM) return;
  if (streetsRecentlyFailed()) return;

  // Only request a small buffer around the currently focused map area. Older
  // loaded areas remain cached, but their lines are hidden when off-screen.
  const bounds = map.getBounds().pad(STREET_VIEW_PAD);
  const covered = roadAreasLoaded.some((area) => area.full.contains(bounds));

  if (!covered) {
    if (streetsFetching) { streetsPending = true; return; }   // run again once the current download ends
    streetsFetching = true;
    try {
      addWays(await fetchRoads(bounds));
      roadAreasLoaded.push({ full: bounds, inner: bounds.pad(-0.05) });
      streetsFailedAt = 0;
    } catch (err) {
      console.warn("Street data unavailable, showing dots instead:", err);
      streetsFailedAt = Date.now();
    } finally {
      streetsFetching = false;
    }
  }

  snapPendingCrimes();
  redrawStreets();

  if (streetsPending) {
    streetsPending = false;
    loadStreetsInView();
  }
}

// ---------- 7. When to load ----------
// "moveend" fires once after every pan or zoom finishes (including the zoom that
// fitBounds does after routes are drawn).
map.on("moveend", () => {
  syncCrimeVisibility();
  updateCrimeInfo();
  loadCrimesInView();
});

crimeToggle.addEventListener("change", () => {
  syncCrimeVisibility();
  updateCrimeInfo();
  if (crimeToggle.checked) loadCrimesInView();
});

crimeStreetsToggle.addEventListener("click", () => {
  crimeStreetsToggle.setAttribute("aria-pressed", String(!crimeStreetsEnabled()));
  updateCrimeViewButton();
  streetsFailedAt = 0; // a manual retry should not wait for the automatic retry timer
  syncCrimeVisibility();
  updateCrimeInfo();
  if (crimeStreetsEnabled()) loadStreetsInView();
});

updateCrimeViewButton();
syncCrimeVisibility();
loadCrimesInView(); // first load for the starting view
