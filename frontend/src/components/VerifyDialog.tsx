// "Is this hazard still here?" — asked when the user walks within range of a report.
import { useEffect, useRef } from "react";
import { photoSrc, type Report } from "../api";
import { REPORT_TYPES } from "../reportTypes";

interface Props {
  report: Report;
  onAnswer: (isPresent: boolean | null) => void;
}

export default function VerifyDialog({ report, onAnswer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const answered = useRef(false);
  const t = REPORT_TYPES[report.type];

  useEffect(() => { ref.current?.showModal(); }, []);

  const answer = (v: boolean | null) => {
    answered.current = true;
    ref.current?.close();
    onAnswer(v);
  };

  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  return (
    <dialog ref={ref} className="dialog" onClose={() => { if (!answered.current) onAnswer(null); }}>
      <h2>Is this hazard still here?</h2>
      <img className="photo-preview" src={photoSrc(report.photo_url)} alt={t.label} />
      <p>
        Someone reported {t.emoji} <strong>{t.label}</strong> near you.
        {report.notes && <> “{report.notes}”</>}
      </p>
      <p className="muted">✅ {people(report.confirm_count)} confirmed · ❌ {people(report.deny_count)} said it's gone</p>
      <div className="button-row end">
        <button type="button" className="btn" onClick={() => answer(null)}>Not sure</button>
        <button type="button" className="btn" onClick={() => answer(false)}>No, it's gone</button>
        <button type="button" className="btn btn-primary" onClick={() => answer(true)}>Yes, it's here</button>
      </div>
    </dialog>
  );
}
