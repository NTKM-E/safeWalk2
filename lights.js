// lights.js — San José street-light infrastructure and night-route coverage.
// The source is the City's ArcGIS Street Light Fixture layer. Mapped fixtures
// are used as an estimate of illumination; they are not a guarantee that a lamp
// is currently working or that every walkway is lit.

const LIGHTS_URL = "https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/425/query";
const LIGHT_MIN_ZOOM = 13;
const LIGHT_DOT_MIN_ZOOM = 16;
const lightToggle = document.getElementById("light-toggle");
const LIGHT_RADIUS_METERS = 70;
const LIGHT_SAMPLE_METERS = 40;
const LIGHT_CELL_DEG = 0.001;
const LIGHT_PAGE_SIZE = 2000;
const LIGHT_MAX_PAGES = 20;

const lights = [];
const lightIds = new Set();
const lightAreasLoaded = [];
const lightGrid = new Map();
let lightsRequestId = 0;
let lightsFetching = false;
let lightsPending = false;

map.createPane("lights");
map.getPane("lights").style.zIndex = 360;
const lightRenderer = L.canvas({ pane: "lights", padding: 0.5 });
const lightLayer = L.layerGroup();

function lightCellKey(lat, lng) {
  return `${Math.floor(lat / LIGHT_CELL_DEG)},${Math.floor(lng / LIGHT_CELL_DEG)}`;
}

function addLight(feature) {
  const id = feature.id ?? feature.properties?.OBJECTID;
  const [lng, lat] = feature.geometry?.coordinates || [];
  if (id == null || !isFinite(lat) || !isFinite(lng) || lightIds.has(id)) return false;
  lightIds.add(id);

  const properties = feature.properties || {};
  const light = {
    id,
    lat,
    lng,
    badge: properties.BADGEID || "",
    status: properties.LIGHTSTATUS || "",
    fixture: properties.LIGHTFIXTURETYPE || "",
    led: properties.LEDSTATUS,
  };
  lights.push(light);
  const key = lightCellKey(lat, lng);
  if (!lightGrid.has(key)) lightGrid.set(key, []);
  lightGrid.get(key).push(light);

  light.marker = L.circleMarker([lat, lng], {
    renderer: lightRenderer,
    radius: 3,
    color: "#a16207",
    weight: 1,
    fillColor: "#fde047",
    fillOpacity: 0.9,
  }).bindPopup(buildLightPopup(light));
  return true;
}

function buildLightPopup(light) {
  const box = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "💡 Street light";
  const details = document.createElement("div");
  details.textContent = [
    light.badge && `Pole: ${light.badge}`,
    light.fixture && `Fixture: ${light.fixture}`,
    light.status && `Status: ${light.status}`,
    light.led !== null && light.led !== undefined && `LED: ${light.led ? "Yes" : "No"}`,
  ].filter(Boolean).join(" · ");
  box.append(title, details);
  return box;
}

function syncLightVisibility() {
  const showDots = lightToggle.checked && map.getZoom() >= LIGHT_DOT_MIN_ZOOM;
  if (showDots && !map.hasLayer(lightLayer)) lightLayer.addTo(map);
  if (!showDots && map.hasLayer(lightLayer)) lightLayer.remove();
  if (!showDots) return;

  const visibleBounds = map.getBounds();
  for (const light of lights) {
    const visible = visibleBounds.contains([light.lat, light.lng]);
    if (visible && !lightLayer.hasLayer(light.marker)) lightLayer.addLayer(light.marker);
    if (!visible && lightLayer.hasLayer(light.marker)) lightLayer.removeLayer(light.marker);
  }
}

async function fetchLightsInBounds(bounds, requestId) {
  let offset = 0;
  let added = 0;

  for (let page = 0; page < LIGHT_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      where: "LIGHTSTATUS <> 'REMOVED'",
      outFields: "OBJECTID,BADGEID,LIGHTSTATUS,LIGHTFIXTURETYPE,LEDSTATUS",
      returnGeometry: "true",
      outSR: "4326",
      resultRecordCount: String(LIGHT_PAGE_SIZE),
      resultOffset: String(offset),
      f: "geojson",
    });
    const res = await fetch(`${LIGHTS_URL}?${params}`);
    if (!res.ok) throw new Error(`street-light service returned HTTP ${res.status}`);
    const data = await res.json();
    if (requestId !== lightsRequestId) return null;
    for (const feature of data.features || []) if (addLight(feature)) added++;
    if (!data.exceededTransferLimit || !(data.features || []).length) break;
    offset += data.features.length;
  }

  lightAreasLoaded.push(bounds);
  return added;
}

function lightsAreaCovered(bounds) {
  return lightAreasLoaded.some((area) => area.contains(bounds));
}

async function loadLightsForBounds(bounds) {
  if (lightsAreaCovered(bounds)) return 0;
  const requestId = ++lightsRequestId;
  try {
    const added = await fetchLightsInBounds(bounds, requestId);
    if (added === null) return null;
    syncLightVisibility();
    return added;
  } catch (err) {
    console.warn("Street-light data unavailable:", err);
    return null;
  }
}

async function loadLightsInView() {
  if (map.getZoom() < LIGHT_DOT_MIN_ZOOM) return;
  const bounds = map.getBounds().pad(0.3);
  if (lightsAreaCovered(bounds)) {
    return;
  }
  if (lightsFetching) {
    lightsPending = true;
    return;
  }
  lightsFetching = true;
  try {
    const added = await loadLightsForBounds(bounds);
    if (added > 0 && typeof lastTrips !== "undefined" && lastTrips.length && typeof rescoreRoutes === "function") {
      rescoreRoutes();
    }
  } finally {
    lightsFetching = false;
  }
  if (lightsPending) {
    lightsPending = false;
    loadLightsInView();
  }
}

async function loadLightsAlong(allCoords) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const coords of allCoords) {
    for (const [lat, lng] of coords) {
      s = Math.min(s, lat); n = Math.max(n, lat);
      w = Math.min(w, lng); e = Math.max(e, lng);
    }
  }
  if (!isFinite(s)) return;
  const pad = 0.001;
  await loadLightsForBounds(L.latLngBounds([s - pad, w - pad], [n + pad, e + pad]));
}

function sampleRoute(coords) {
  const samples = [];
  for (let i = 1; i < coords.length; i++) {
    const [aLat, aLng] = coords[i - 1];
    const [bLat, bLng] = coords[i];
    const distance = haversineMeters(aLat, aLng, bLat, bLng);
    const steps = Math.max(1, Math.ceil(distance / LIGHT_SAMPLE_METERS));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      samples.push([aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t]);
    }
  }
  if (coords.length) samples.push(coords[coords.length - 1]);
  return samples;
}

function nearestLightDistance(lat, lng) {
  const row = Math.floor(lat / LIGHT_CELL_DEG);
  const col = Math.floor(lng / LIGHT_CELL_DEG);
  let best = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const candidates = lightGrid.get(`${row + dr},${col + dc}`) || [];
      for (const light of candidates) {
        const d = haversineMeters(lat, lng, light.lat, light.lng);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function routeLightBounds(coords, padM = LIGHT_RADIUS_METERS) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lng] of coords) {
    s = Math.min(s, lat); n = Math.max(n, lat);
    w = Math.min(w, lng); e = Math.max(e, lng);
  }
  const midLat = ((s + n) / 2) * Math.PI / 180;
  return L.latLngBounds([
    s - padM / 111320,
    w - padM / (111320 * Math.cos(midLat)),
  ], [
    n + padM / 111320,
    e + padM / (111320 * Math.cos(midLat)),
  ]);
}

function lightCoverageForRoute(coords) {
  const bounds = routeLightBounds(coords);
  if (!lightsAreaCovered(bounds)) return { available: false, coverage: 0, fixtures: 0 };
  const samples = sampleRoute(coords);
  if (!samples.length) return { available: true, coverage: 0, fixtures: 0 };
  const lit = samples.filter(([lat, lng]) => nearestLightDistance(lat, lng) <= LIGHT_RADIUS_METERS).length;
  const fixtures = lights.filter((light) => bounds.contains([light.lat, light.lng])).length;
  return { available: true, coverage: lit / samples.length, fixtures };
}

function darkenHex(hex, amount = 0.45) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `#${[r, g, b].map((x) => Math.round(x * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

function segmentLightingCoverage(a, b) {
  const samples = [0, 0.5, 1].map((t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ]);
  return samples.filter(([lat, lng]) => nearestLightDistance(lat, lng) <= LIGHT_RADIUS_METERS).length / samples.length;
}

// Draw each route as short segments. Dark segments indicate weak mapped-light
// coverage; bright segments retain the normal route colour.
function drawRouteWithLighting(coords, color, options) {
  const coverage = lightCoverageForRoute(coords);
  if (!coverage.available || !lightToggle.checked) return [L.polyline(coords, options).addTo(map)];
  const lines = [];
  for (let i = 1; i < coords.length; i++) {
    const segmentCoverage = segmentLightingCoverage(coords[i - 1], coords[i]);
    const line = L.polyline([coords[i - 1], coords[i]], {
      ...options,
      color: segmentCoverage >= 0.67 ? color : darkenHex(color, segmentCoverage === 0 ? 0.55 : 0.35),
    }).addTo(map);
    lines.push(line);
  }
  return lines;
}

lightToggle.addEventListener("change", () => {
  syncLightVisibility();
  if (typeof lastTrips !== "undefined" && lastTrips.length && typeof drawRoutes === "function") {
    drawRoutes(lastTrips, lastCoords, false);
  }
});

map.on("moveend", () => {
  syncLightVisibility();
  loadLightsInView();
});

syncLightVisibility();
