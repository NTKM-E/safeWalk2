import type { ScoredRoute } from "../api";
import { scoreColor } from "../config";

export type SlotLabel = "Safest" | "Balanced" | "Fastest" | "Safest & fastest" | "Alternative";

export interface DisplayRoute extends ScoredRoute {
  label: SlotLabel;
}

interface Props {
  routes: DisplayRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function RouteCards({ routes, selectedId, onSelect }: Props) {
  return (
    <ol className="route-cards">
      {routes.map((r) => {
        const selected = r.id === selectedId;
        return (
          <li key={r.id}>
            <button
              className={`route-card ${selected ? "selected" : ""}`}
              onClick={() => onSelect(r.id)}
              aria-pressed={selected}
            >
              <div className="route-head">
                <span className="score" style={{ background: scoreColor(r.score) }} title="Safety score out of 100">
                  {r.score}
                </span>
                <span className="route-title">
                  <span className={`slot slot-${r.label.split(" ")[0].toLowerCase()}`}>{r.label}</span>
                  <span className="route-meta">
                    {Math.round(r.duration_s / 60)} min · {(r.distance_m / 1609.34).toFixed(2)} mi
                  </span>
                </span>
              </div>
              <div className="factors">
                <Factor label="Police calls" risk={r.crime.risk} value={`${r.crime.count}`} />
                <Factor
                  label="Lit"
                  risk={r.lighting.risk}
                  value={r.lighting.coverage === null ? "n/a" : `${Math.round(r.lighting.coverage * 100)}%`}
                />
                <Factor label="Reports" risk={r.reports.risk} value={`${r.reports.count}`} />
              </div>
              {selected && (
                <ul className="reasons">
                  {[...r.reasons.crime, ...r.reasons.lighting, ...r.reasons.reports].map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Factor({ label, risk, value }: { label: string; risk: number; value: string }) {
  const level = risk < 0.25 ? "low" : risk < 0.55 ? "mid" : "high";
  return (
    <span className={`factor factor-${level}`}>
      <span className="factor-value">{value}</span>
      <span className="factor-label">{label}</span>
    </span>
  );
}
