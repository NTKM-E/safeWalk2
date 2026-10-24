import { useEffect, useRef, useState } from "react";
import type { LngLat } from "../api";
import { searchPlaces, type Place } from "../mapbox";

interface Props {
  label: string;
  marker: "A" | "B";
  value: string;
  onChange: (text: string) => void;
  onPick: (name: string, center: LngLat) => void;
}

/** Address input with Mapbox autocomplete, limited to San Jose. */
export default function SearchBox({ label, marker, value, onChange, onPick }: Props) {
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useRef(false);

  useEffect(() => {
    if (!typed.current || value.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(value, ctrl.signal)
        .then((r) => { setResults(r); setActive(0); setOpen(true); })
        .catch((err) => { if (err.name !== "AbortError") console.error(err); });
    }, 250);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [value]);

  const pick = (p: Place) => {
    typed.current = false;
    setOpen(false);
    setResults([]);
    onPick(p.name, p.center);
  };

  return (
    <div className="search">
      <span className={`search-marker marker-${marker.toLowerCase()}`}>{marker}</span>
      <input
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => { typed.current = true; onChange(e.target.value); }}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !results.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
          if (e.key === "Enter") { e.preventDefault(); pick(results[active]); }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={`${r.center.join(",")}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => { e.preventDefault(); pick(r); }}
            >
              <span className="result-name">{r.name}</span>
              <span className="result-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
