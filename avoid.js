// avoid.js: builds the list of reported hazards that Valhalla should route AROUND.
// Load order: config → vision → app → incidents → crimes → avoid
// It uses things defined in other files, at the time it is called:
//   incidents, INCIDENT_TYPES, incidentPenalty, haversineMeters  (incidents.js)
//   IS_NIGHT                                                      (app.js)

// ---------- Settings ----------
const MAX_AVOID_LOCATIONS = 40;          // cap how many hazards we send to Valhalla (public servers limit the total size)
const AVOID_SEARCH_PAD_DEG = 0.01;       // only consider incidents within ~1 km of the A-to-B box
const SKIP_AVOID_NEAR_ENDPOINTS_M = 45;  // don't avoid something right at A or B, or the trip becomes impossible
const AVOID_BOX_HALF_SIDE_M = 20;        // each hazard becomes a small square this far from its centre (so ~40 m wide)

// Should Valhalla avoid this incident? Same idea as before: high-risk types always, and
// medium-risk types when IS_NIGHT is on. Low-risk incidents are never avoided, only scored.
function isAvoidedIncident(inc) {
  if (inc.status === "resolved") return false;
  const level = INCIDENT_TYPES[inc.type]?.safetyLevel;
  return level === "high" || (IS_NIGHT && level === "medium");
}

// Returns [{lat, lon, high}, ...] for the hazards between A and B, strongest first.
// `high` is true for real high-risk types, so we can fall back to "high-risk only" later.
function buildAvoidLocations(a, b) {
  const south = Math.min(a.lat, b.lat) - AVOID_SEARCH_PAD_DEG;
  const north = Math.max(a.lat, b.lat) + AVOID_SEARCH_PAD_DEG;
  const west = Math.min(a.lng, b.lng) - AVOID_SEARCH_PAD_DEG;
  const east = Math.max(a.lng, b.lng) + AVOID_SEARCH_PAD_DEG;

  return incidents
    .filter((inc) =>
      isAvoidedIncident(inc) &&
      inc.lat >= south && inc.lat <= north && inc.lng >= west && inc.lng <= east &&
      haversineMeters(inc.lat, inc.lng, a.lat, a.lng) > SKIP_AVOID_NEAR_ENDPOINTS_M &&
      haversineMeters(inc.lat, inc.lng, b.lat, b.lng) > SKIP_AVOID_NEAR_ENDPOINTS_M
    )
    // Strongest first (severity x confidence x freshness), so the cap drops the weakest reports
    .sort((x, y) => incidentPenalty(y, IS_NIGHT) - incidentPenalty(x, IS_NIGHT))
    .slice(0, MAX_AVOID_LOCATIONS)
    .map((inc) => ({
      lat: inc.lat,
      lon: inc.lng,
      high: INCIDENT_TYPES[inc.type]?.safetyLevel === "high",
    }));
}

// If asking Valhalla to avoid EVERYTHING fails (no path exists), try smaller sets instead of
// giving up. Each tier is {points, as}: "polygons" blocks every road inside a small square
// around each hazard; "locations" is the older single-nearest-road method, kept as a last resort.
function avoidTiers(avoid) {
  const highOnly = avoid.filter((p) => p.high);
  const tiers = [{ points: avoid, as: "polygons" }];
  if (highOnly.length && highOnly.length < avoid.length) tiers.push({ points: highOnly, as: "polygons" });
  if (avoid.length > 8 && highOnly.length > 8) tiers.push({ points: avoid.slice(0, 8), as: "polygons" });
  if (highOnly.length) tiers.push({ points: highOnly, as: "locations" });
  return tiers;
}

// A closed square ring around a point, as [lon, lat] pairs (the order Valhalla wants).
function squareAround(lat, lon, halfSideM) {
  const dLat = halfSideM / 111320;
  const dLon = halfSideM / (111320 * Math.cos(lat * Math.PI / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

// The extra fields to add to a Valhalla request body for one tier.
function avoidRequestFields(tier) {
  if (tier.as === "locations") {
    return { exclude_locations: tier.points.map((p) => ({ lat: p.lat, lon: p.lon })) };
  }
  return { exclude_polygons: tier.points.map((p) => squareAround(p.lat, p.lon, AVOID_BOX_HALF_SIDE_M)) };
}

// A short text fingerprint of an avoid list, used to notice when it has changed.
// Sorted so the same set of points always gives the same text.
function avoidKey(avoid) {
  return avoid.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).sort().join(";");
}
