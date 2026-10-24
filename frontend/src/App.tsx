import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CandidateRoute, type Health, type LngLat, type Report, type ScoreResult, type ScoredRoute } from "./api";
import MapView from "./components/MapView";
import ReportDialog, { type PendingReport } from "./components/ReportDialog";
import RouteCards, { type DisplayRoute } from "./components/RouteCards";
import SearchBox from "./components/SearchBox";
import VerifyDialog from "./components/VerifyDialog";
import { MAPBOX_TOKEN, isNightInSanJose, scoreColor } from "./config";
import { DEVICE_ID, loadAskedIds, saveAskedIds } from "./device";
import { candidateRoutes, distanceM } from "./mapbox";
import { MAX_GPS_ERROR_M, toPosition, type Position } from "./media";

const VERIFY_RADIUS_M = 40;
const REFRESH_MS = 60_000;
const DEMO_MODE = new URLSearchParams(window.location.search).has("demo");
const DAY_MS = 86_400_000;

interface Endpoint {
  text: string;
  point: LngLat | null;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [start, setStart] = useState<Endpoint>({ text: "", point: null });
  const [end, setEnd] = useState<Endpoint>({ text: "", point: null });
  // Day vs night follows the clock in San Jose; the server applies the same rule when scoring.
  const [night, setNight] = useState(isNightInSanJose());
  const [candidates, setCandidates] = useState<CandidateRoute[]>([]);
  const [result, setResult] = useState<ScoreResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Search for a start and destination, or click the map to drop pins.");
  const [busy, setBusy] = useState(false);

  const [reports, setReports] = useState<Report[]>([]);
  const [reporting, setReporting] = useState(false);
  const [placing, setPlacing] = useState<PendingReport | null>(null);
  const [focus, setFocus] = useState<{ center: LngLat; key: number } | null>(null);
  const [user, setUser] = useState<Position | null>(null);
  const [simulated, setSimulated] = useState<Position | null>(null);
  const [verifyQueue, setVerifyQueue] = useState<Report[]>([]);
  const askedIds = useRef(loadAskedIds());

  // Map layer controls. These only change what's drawn, not how routes are scored.
  const [crimeFromDay, setCrimeFromDay] = useState<number | null>(null);  // null = show all
  const [showStreetlights, setShowStreetlights] = useState(true);

  // ---------- Startup ----------
  useEffect(() => {
    api.health().then(setHealth).catch((err) => setStatus(`Can't reach the SafeWalk server: ${err.message}`));
    const load = () => api.listReports().then(setReports).catch(console.error);
    load();
    const timer = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setNight(isNightInSanJose()), 60_000);
    return () => { clearInterval(timer); clearInterval(clock); };
  }, []);

  // ---------- Routing + scoring ----------
  const scoreCandidates = useCallback(async (routes: CandidateRoute[]) => {
    if (!routes.length) return;
    setBusy(true);
    setStatus("Checking police calls, streetlights and reports along each route…");
    try {
      const scored = await api.score(routes);
      setResult(scored);
      setSelectedId((current) =>
        current && scored.routes.some((r) => r.id === current) ? current : pickSlots(scored.routes)[0]?.id ?? null,
      );
      setStatus(`${scored.routes.length} route${scored.routes.length === 1 ? "" : "s"} compared. Tap one to see why it scored that way.`);
    } catch (err) {
      setStatus(`Couldn't score routes: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!start.point || !end.point) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setStatus("Finding walking routes…");
      setResult(null);
      setSelectedId(null);
      try {
        const routes = await candidateRoutes(start.point!, end.point!);
        if (cancelled) return;
        setCandidates(routes);
        await scoreCandidates(routes);
      } catch (err) {
        if (!cancelled) setStatus(`Couldn't get routes: ${(err as Error).message}`);
        setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [start.point, end.point, scoreCandidates]);

  // Re-score (without re-routing) when day turns to night or community reports change.
  const reportsKey = reports.map((r) => `${r.id}:${r.status}:${r.confirm_count}:${r.deny_count}`).join("|");
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (candidates.length) scoreCandidates(candidates);
  }, [night, reportsKey]);

  // Police call markers, bucketed by the San Jose-local day the call was made.
  const crimeDays = useMemo(() => {
    const markers = result?.crime_markers ?? [];
    const days = markers.map((c) => localDay(c.offense_at));
    return { markers, days, min: Math.min(...days), max: Math.max(...days) };
  }, [result]);
  const fromDay = crimeFromDay === null ? crimeDays.min : Math.min(Math.max(crimeFromDay, crimeDays.min), crimeDays.max);
  const visibleCrimes = useMemo(
    () => crimeDays.markers.filter((_, i) => crimeDays.days[i] >= fromDay),
    [crimeDays, fromDay],
  );

  const displayRoutes = useMemo(() => pickSlots(result?.routes ?? []), [result]);
  const selected = displayRoutes.find((r) => r.id === selectedId) ?? null;
  const mapRoutes = useMemo(
    () => displayRoutes.map((r) => ({
      id: r.id,
      color: scoreColor(r.score),
      coordinates: candidates.find((c) => c.id === r.id)?.coordinates ?? [],
    })),
    [displayRoutes, candidates],
  );

  function clearRoute() {
    setStart({ text: "", point: null });
    setEnd({ text: "", point: null });
    setCandidates([]);
    setResult(null);
    setSelectedId(null);
    setStatus("Search for a start and destination, or click the map to drop pins.");
  }

  function swap() {
    setStart(end);
    setEnd(start);
  }

  // ---------- Map clicks ----------
  async function onMapClick(p: LngLat) {
    if (placing) {
      const pending = placing;
      setStatus("Saving report…");
      try {
        const report = await api.createReport({ ...pending, lat: p[1], lng: p[0], deviceId: DEVICE_ID });
        setPlacing(null);
        addReport(report);
      } catch (err) {
        setStatus(`Couldn't save: ${(err as Error).message}. Click the map to try again.`);
      }
      return;
    }
    if (!start.point) setStart({ text: "Dropped pin", point: p });
    else if (!end.point) setEnd({ text: "Dropped pin", point: p });
  }

  function onContextMenu(p: LngLat) {
    if (!DEMO_MODE) return;
    setSimulated({ lat: p[1], lng: p[0], accuracy: 5, timestamp: Date.now() });
  }

  // ---------- Reports ----------
  function addReport(report: Report) {
    setReports((rs) => [...rs.filter((r) => r.id !== report.id), report]);
    setStatus("Report saved. Thanks! Routes nearby have been re-scored.");
  }

  function startPlacing(pending: PendingReport) {
    setPlacing(pending);
    if (pending.near) setFocus({ center: pending.near, key: Date.now() });
    setStatus(pending.near ? "Tap the exact spot where you took the photo." : "Click the map where the photo was taken.");
  }

  async function deleteReport(id: string) {
    try {
      await api.deleteReport(id, DEVICE_ID);
      setReports((rs) => rs.filter((r) => r.id !== id));
    } catch (err) {
      alert(`Couldn't remove: ${(err as Error).message}`);
    }
  }

  // ---------- Location + "is this still here?" ----------
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setUser(toPosition(p)),
      (err) => console.warn("Location unavailable:", err.message),
      { enableHighAccuracy: true, maximumAge: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  const here = simulated ?? user;

  useEffect(() => {
    if (!here || here.accuracy > MAX_GPS_ERROR_M) return;
    const nearby = reports.filter((r) =>
      r.reporter_id !== DEVICE_ID &&
      !askedIds.current.has(r.id) &&
      distanceM([here.lng, here.lat], [r.lng, r.lat]) <= VERIFY_RADIUS_M,
    );
    if (nearby.length) {
      setVerifyQueue((q) => [...q, ...nearby.filter((r) => !q.some((x) => x.id === r.id))]);
    }
  }, [here, reports]);

  async function answerVerify(report: Report, isPresent: boolean | null) {
    askedIds.current.add(report.id);
    saveAskedIds(askedIds.current);
    setVerifyQueue((q) => q.filter((r) => r.id !== report.id));
    if (isPresent === null) return;
    try {
      const updated = await api.verify(report.id, DEVICE_ID, isPresent);
      setReports((rs) =>
        updated.status === "resolved"
          ? rs.filter((r) => r.id !== updated.id)
          : rs.map((r) => (r.id === updated.id ? updated : r)),
      );
    } catch (err) {
      setStatus(`Couldn't save your answer: ${(err as Error).message}`);
    }
  }

  // Don't pop a verification over the report flow.
  const verifying = !reporting && !placing ? verifyQueue[0] : undefined;
  const verifiedCount = reports.filter((r) => r.status === "verified").length;

  if (!MAPBOX_TOKEN) {
    return (
      <div className="setup">
        <h1>SafeWalk</h1>
        <p>Add your Mapbox token to <code>frontend/.env</code>:</p>
        <pre>VITE_MAPBOX_TOKEN=pk.…</pre>
        <p>Then restart <code>npm run dev</code>.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <MapView
        routes={mapRoutes}
        selectedId={selectedId}
        darkSegments={result?.night ? selected?.lighting.dark_segments ?? [] : []}
        streetlights={showStreetlights ? result?.streetlights ?? [] : []}
        crimes={visibleCrimes}
        reports={reports}
        start={start.point}
        end={end.point}
        user={here}
        crosshair={Boolean(placing)}
        focus={focus}
        onSelectRoute={setSelectedId}
        onMapClick={onMapClick}
        onContextMenu={onContextMenu}
        onDeleteReport={deleteReport}
      />

      <aside className="panel">
        <header className="panel-header">
          <h1>SafeWalk <span className="city">San Jose</span></h1>
          <span className="time-badge" title={night
            ? "It's night in San Jose: lighting counts fully and calls that happened at night weigh more"
            : "It's daytime in San Jose: lighting counts less and calls that happened by day weigh more"}>
            {night ? "🌙 Night" : "☀️ Day"}
          </span>
        </header>

        <div className="searches">
          <SearchBox label="Start" marker="A" value={start.text}
            onChange={(text) => setStart({ text, point: null })}
            onPick={(text, point) => setStart({ text, point })} />
          <SearchBox label="Destination" marker="B" value={end.text}
            onChange={(text) => setEnd({ text, point: null })}
            onPick={(text, point) => setEnd({ text, point })} />
          <div className="search-actions">
            <button className="btn btn-small" onClick={swap} disabled={busy}>⇅ Swap</button>
            <button className="btn btn-small" onClick={clearRoute} disabled={busy}>Clear</button>
          </div>
        </div>

        <p className={`status ${busy ? "busy" : ""}`} role="status">{status}</p>

        {health && health.police_calls === 0 && (
          <p className="warning">No police call data loaded yet. Run <code>python -m ingest.police_calls</code> in <code>backend/</code>.</p>
        )}

        <RouteCards routes={displayRoutes} selectedId={selectedId} onSelect={setSelectedId} />

        {result && (
          <div className="layers">
            {crimeDays.markers.length > 0 && (
              <label className="layer-slider">
                <span className="layer-label">
                  Police calls since <strong>{formatDay(fromDay)}</strong>
                  <span className="muted"> · {visibleCrimes.length} of {crimeDays.markers.length}</span>
                </span>
                <input
                  type="range"
                  min={crimeDays.min}
                  max={crimeDays.max}
                  step={DAY_MS}
                  value={fromDay}
                  disabled={crimeDays.min === crimeDays.max}
                  onChange={(e) => setCrimeFromDay(Number(e.target.value))}
                  aria-label="Show police calls reported on or after this date"
                />
                <span className="range-ends muted">
                  <span>{formatDay(crimeDays.min)}</span>
                  <span>{formatDay(crimeDays.max)}</span>
                </span>
              </label>
            )}
            <label className="layer-toggle">
              <input type="checkbox" checked={showStreetlights} onChange={(e) => setShowStreetlights(e.target.checked)} />
              Show streetlights
            </label>
          </div>
        )}

        {result && (
          <div className="legend">
            <span><i className="dot violent" /> Violent</span>
            <span><i className="dot weapons" /> Weapons</span>
            <span><i className="dot disorder" /> Disorder</span>
            <span><i className="dot property" /> Property</span>
            <span><i className="dot light" /> Streetlight</span>
            {result.night && <span><i className="dash" /> Dark stretch</span>}
          </div>
        )}

        <div className="panel-footer">
          {placing ? (
            <button className="btn" onClick={() => { setPlacing(null); setStatus("Reporting cancelled."); }}>Cancel reporting</button>
          ) : (
            <button className="btn btn-primary" onClick={() => setReporting(true)}>📍 Report a hazard</button>
          )}
          <span className="muted small">
            {reports.length} active report{reports.length === 1 ? "" : "s"} · {verifiedCount} verified
            {DEMO_MODE && " · Demo: right-click the map to set your position"}
          </span>
          <p className="muted small fineprint">
            Police data: San Jose PD calls for service (block-level, not confirmed crimes)
            {result?.crime_data_since && `, since ${new Date(result.crime_data_since).toLocaleDateString()}`}.
            Streetlights: San Jose DOT GIS.
          </p>
        </div>
      </aside>

      {reporting && (
        <ReportDialog
          visionEnabled={Boolean(health?.vision)}
          currentPosition={here}
          onClose={() => setReporting(false)}
          onSaved={addReport}
          onPlaceOnMap={startPlacing}
        />
      )}
      {verifying && <VerifyDialog key={verifying.id} report={verifying} onAnswer={(v) => answerVerify(verifying, v)} />}
    </div>
  );
}

/** Midnight (as a UTC timestamp) of the San Jose calendar day an ISO time falls on. */
function localDay(iso: string): number {
  const ymd = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return Date.parse(`${ymd}T00:00:00Z`);
}

function formatDay(day: number): string {
  return new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Up to three routes to show: the safest, the fastest, and the best trade-off in between. */
function pickSlots(routes: ScoredRoute[]): DisplayRoute[] {
  if (!routes.length) return [];
  const fastest = routes.reduce((a, b) => (b.duration_s < a.duration_s ? b : a));
  const safest = routes.reduce((a, b) =>
    b.score > a.score || (b.score === a.score && b.duration_s < a.duration_s) ? b : a);
  const rest = routes.filter((r) => r !== safest && r !== fastest);
  // Trade-off: each extra minute over the fastest route costs 1.5 safety points.
  const tradeoff = (r: ScoredRoute) => r.score - (1.5 * (r.duration_s - fastest.duration_s)) / 60;
  const middle = rest.length ? rest.reduce((a, b) => (tradeoff(b) > tradeoff(a) ? b : a)) : null;

  if (safest === fastest) {
    return [
      { ...safest, label: "Safest & fastest" },
      ...(middle ? [{ ...middle, label: "Alternative" as const }] : []),
    ];
  }
  return [
    { ...safest, label: "Safest" },
    ...(middle ? [{ ...middle, label: "Balanced" as const }] : []),
    { ...fastest, label: "Fastest" },
  ];
}
