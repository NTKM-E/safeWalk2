import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import type { CrimeMarker, LngLat, Report } from "../api";
import { photoSrc } from "../api";
import { MAPBOX_TOKEN, SAN_JOSE } from "../config";
import { DEVICE_ID } from "../device";
import type { Position } from "../media";
import { REPORT_TYPES } from "../reportTypes";

mapboxgl.accessToken = MAPBOX_TOKEN;

export interface MapRoute {
  id: string;
  coordinates: LngLat[];
  color: string;
}

interface Props {
  routes: MapRoute[];
  selectedId: string | null;
  darkSegments: LngLat[][];
  streetlights: { lat: number; lng: number }[];
  crimes: CrimeMarker[];
  reports: Report[];
  start: LngLat | null;
  end: LngLat | null;
  user: Position | null;
  crosshair: boolean;
  focus: { center: LngLat; key: number } | null;  // fly here when key changes
  onSelectRoute: (id: string) => void;
  onMapClick: (p: LngLat) => void;
  onContextMenu: (p: LngLat) => void;
  onDeleteReport: (id: string) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  violent: "#b91c1c",
  weapons: "#7e22ce",
  disorder: "#ea580c",
  property: "#64748b",
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function MapView(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Latest callbacks, so map event handlers bound once always call the current ones.
  const cb = useRef(props);
  cb.current = props;

  // ---------- Create the map once ----------
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: "mapbox://styles/mapbox/streets-v12",
      center: SAN_JOSE,
      zoom: 13.5,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("routes", { type: "geojson", data: EMPTY });
      map.addSource("dark", { type: "geojson", data: EMPTY });
      map.addSource("lights", { type: "geojson", data: EMPTY });
      map.addSource("crimes", { type: "geojson", data: EMPTY });

      map.addLayer({
        id: "routes-other", type: "line", source: "routes",
        filter: ["!", ["get", "selected"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.45 },
      });
      map.addLayer({
        id: "routes-selected-casing", type: "line", source: "routes",
        filter: ["get", "selected"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 11 },
      });
      map.addLayer({
        id: "routes-selected", type: "line", source: "routes",
        filter: ["get", "selected"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 7 },
      });
      map.addLayer({
        id: "dark", type: "line", source: "dark",
        layout: { "line-cap": "round" },
        paint: { "line-color": "#111827", "line-width": 3, "line-dasharray": [1.5, 1.5] },
      });
      map.addLayer({
        id: "lights", type: "circle", source: "lights",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 17, 4],
          "circle-color": "#facc15",
          "circle-stroke-color": "#a16207",
          "circle-stroke-width": 0.5,
        },
      });
      map.addLayer({
        id: "crimes", type: "circle", source: "crimes",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 7],
          "circle-color": ["match", ["get", "category"],
            ...Object.entries(CATEGORY_COLORS).flat(), "#64748b"],
          "circle-opacity": 0.8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      for (const layer of ["routes-other", "routes-selected"]) {
        map.on("click", layer, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) cb.current.onSelectRoute(id);
        });
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = cb.current.crosshair ? "crosshair" : ""));
      }
      map.on("click", "crimes", (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const when = new Date(p.offense_at);
        new mapboxgl.Popup({ offset: 8 })
          .setLngLat(e.lngLat)
          .setDOMContent(textBox([
            ["strong", titleCase(p.call_type)],
            ["div", `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`],
            ["div", p.address ? `Near ${titleCase(p.address)}` : ""],
            ["small", "San Jose PD call for service (block-level location)"],
          ]))
          .addTo(map);
      });

      setLoaded(true);
    });

    map.on("click", (e) => {
      // Report markers and popups are HTML on top of the map; their clicks also reach
      // the map. They take priority: never drop a navigation pin or place a report from them.
      const target = e.originalEvent.target as HTMLElement | null;
      if (target?.closest(".report-marker, .mapboxgl-popup")) return;
      // Clicks on routes / crime dots are handled by their layers.
      const hits = map.queryRenderedFeatures(e.point, { layers: ["routes-other", "routes-selected", "crimes"] });
      if (hits.length && !cb.current.crosshair) return;
      cb.current.onMapClick([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("contextmenu", (e) => cb.current.onContextMenu([e.lngLat.lng, e.lngLat.lat]));

    return () => map.remove();
  }, []);

  // ---------- Routes ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    // Draw the selected route last so it sits on top.
    const ordered = [...props.routes].sort((a, b) => Number(a.id === props.selectedId) - Number(b.id === props.selectedId));
    setData(map, "routes", ordered.map((r) => ({
      type: "Feature",
      properties: { id: r.id, color: r.color, selected: r.id === props.selectedId },
      geometry: { type: "LineString", coordinates: r.coordinates },
    })));
  }, [loaded, props.routes, props.selectedId]);

  // Fit the view when a new set of routes arrives.
  const routeKey = props.routes.map((r) => r.id + r.coordinates.length).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !props.routes.length) return;
    const bounds = new mapboxgl.LngLatBounds();
    props.routes.forEach((r) => r.coordinates.forEach((c) => bounds.extend(c)));
    const mobile = window.innerWidth < 760;
    map.fitBounds(bounds, {
      padding: mobile ? { top: 40, bottom: window.innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 },
      maxZoom: 17,
    });
  }, [loaded, routeKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    setData(map, "dark", props.darkSegments.map((coords) => ({
      type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords },
    })));
  }, [loaded, props.darkSegments]);

  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    setData(map, "lights", props.streetlights.map((l) => ({
      type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [l.lng, l.lat] },
    })));
  }, [loaded, props.streetlights]);

  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    setData(map, "crimes", props.crimes.map((c) => ({
      type: "Feature",
      properties: { ...c },
      geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    })));
  }, [loaded, props.crimes]);

  // ---------- Start / end pins and the user's position ----------
  usePin(mapRef, loaded, props.start, "pin pin-a", "A");
  usePin(mapRef, loaded, props.end, "pin pin-b", "B");
  usePin(mapRef, loaded, props.user ? [props.user.lng, props.user.lat] : null, "user-dot", "");

  // ---------- Community report markers ----------
  const reportMarkers = useRef(new Map<string, { marker: mapboxgl.Marker; key: string }>());
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const seen = new Set<string>();
    for (const r of props.reports) {
      seen.add(r.id);
      const key = `${r.status}:${r.confirm_count}:${r.deny_count}`;
      const existing = reportMarkers.current.get(r.id);
      if (existing?.key === key) continue;
      existing?.marker.remove();
      const el = document.createElement("div");
      el.className = `report-marker ${r.status}`;
      el.textContent = REPORT_TYPES[r.type]?.emoji ?? "❓";
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([r.lng, r.lat])
        .setPopup(new mapboxgl.Popup({ offset: 18, maxWidth: "260px" }).setDOMContent(
          reportPopup(r, () => cb.current.onDeleteReport(r.id)),
        ))
        .addTo(map);
      reportMarkers.current.set(r.id, { marker, key });
    }
    for (const [id, { marker }] of reportMarkers.current) {
      if (!seen.has(id)) {
        marker.remove();
        reportMarkers.current.delete(id);
      }
    }
  }, [loaded, props.reports]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = props.crosshair ? "crosshair" : "";
  }, [props.crosshair]);

  useEffect(() => {
    const map = mapRef.current;
    if (loaded && map && props.focus) map.flyTo({ center: props.focus.center, zoom: 18 });
  }, [loaded, props.focus?.key]);

  return <div ref={containerRef} className="map" />;
}

function usePin(
  mapRef: React.MutableRefObject<mapboxgl.Map | null>,
  loaded: boolean,
  at: LngLat | null,
  className: string,
  label: string,
) {
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    if (!at) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.className = className;
      if (label) el.appendChild(document.createElement("span")).textContent = label;
      markerRef.current = new mapboxgl.Marker({ element: el }).setLngLat(at).addTo(map);
    } else {
      markerRef.current.setLngLat(at);
    }
  }, [loaded, at?.[0], at?.[1]]);
}

function setData(map: mapboxgl.Map, source: string, features: GeoJSON.Feature[]) {
  (map.getSource(source) as mapboxgl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
}

function textBox(lines: [string, string][]): HTMLElement {
  const box = document.createElement("div");
  box.className = "popup";
  for (const [tag, text] of lines) {
    if (!text) continue;
    const el = document.createElement(tag);
    el.textContent = text;
    box.appendChild(el);
  }
  return box;
}

function reportPopup(r: Report, onDelete: () => void): HTMLElement {
  const t = REPORT_TYPES[r.type];
  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  const box = textBox([
    ["small", `✅ ${people(r.confirm_count)} confirmed · ❌ ${people(r.deny_count)} said it's gone`],
    ["div", r.notes],
    ["small", r.ai_description ? `AI: ${r.ai_description}` : ""],
    ["small", `${new Date(r.created_at).toLocaleString()} · ${r.live_photo ? "📷 live photo" : "🖼️ uploaded"}`],
  ]);

  // Header: small photo thumbnail (opens the full photo) next to the type and status.
  const head = document.createElement("div");
  head.className = "popup-head";
  if (r.photo_url) {
    const link = document.createElement("a");
    link.className = "popup-thumb";
    link.href = photoSrc(r.photo_url);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open full photo";
    const img = document.createElement("img");
    img.src = photoSrc(r.photo_url);
    img.alt = `Photo of ${t.label.toLowerCase()}`;
    img.loading = "lazy";
    img.addEventListener("error", () => link.remove());
    link.appendChild(img);
    head.appendChild(link);
  }
  head.appendChild(textBox([
    ["strong", `${t.emoji} ${t.label}`],
    ["div", r.status === "verified" ? "✔ Verified by the community" : "Unverified"],
  ]));
  box.prepend(head);

  if (r.reporter_id === DEVICE_ID) {
    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.textContent = "Remove my report";
    btn.addEventListener("click", onDelete);
    box.appendChild(btn);
  }
  return box;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
