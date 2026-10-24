// Keep the keys identical to REPORT_TYPES in backend/app/report_types.py.
export const REPORT_TYPES = {
  obstruction:             { label: "Obstruction",             emoji: "⛔" },
  pedestrian_signal_issue: { label: "Pedestrian signal issue", emoji: "🚦" },
  construction:            { label: "Construction",            emoji: "🚧" },
  lighting:                { label: "Lighting issue",          emoji: "💡" },
  damaged_sidewalk:        { label: "Damaged sidewalk",        emoji: "🧱" },
  unpaved_surface:         { label: "Unpaved surface",         emoji: "🪨" },
  trash:                   { label: "Trash / debris",          emoji: "🗑️" },
  other:                   { label: "Other",                   emoji: "❓" },
} as const;

export type ReportType = keyof typeof REPORT_TYPES;

export function isReportType(t: string): t is ReportType {
  return t in REPORT_TYPES;
}
