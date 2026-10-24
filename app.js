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
// appMode decides what a map click means: "route" (pick A/B) or "report" (place an incident).
// incidents.js changes it when the user presses "Report incident".
let appMode = "route";

map.on("click", (e) => {
  if (appMode !== "route") return; // incident mode: incidents.js handles this click
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

// ---------- 7. Decode Valhalla's compressed path ----------
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
