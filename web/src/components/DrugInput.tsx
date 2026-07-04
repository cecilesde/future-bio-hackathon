"use client";

import { useEffect, useRef, useState } from "react";
import type { Drug } from "@/lib/types";

function phaseLabel(p: number | null): string {
  if (p == null) return "";
  if (p >= 4) return "Approved";
  if (p <= 0) return "Preclinical";
  return `Phase ${p % 1 === 0 ? p : p.toFixed(1)}`;
}
function phaseColor(p: number | null): string {
  if (p == null) return "var(--muted)";
  if (p >= 4) return "var(--green)";
  if (p >= 3) return "var(--accent)";
  return "var(--amber)";
}

export default function DrugInput({
  selected,
  onChange,
}: {
  selected: Drug[];
  onChange: (drugs: Drug[]) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Drug[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/drugs?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal });
        const data = await r.json();
        setResults(data.drugs ?? []);
        setOpen(true);
      } catch {
        /* aborted or failed */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selectedIds = new Set(selected.map((d) => d.chembl_id));

  function add(d: Drug) {
    if (!selectedIds.has(d.chembl_id)) onChange([...selected, d]);
    setQ("");
    setResults([]);
    setOpen(false);
  }
  function remove(id: string) {
    onChange(selected.filter((d) => d.chembl_id !== id));
  }

  return (
    <div ref={boxRef} className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((d) => (
            <span
              key={d.chembl_id}
              className="pill"
              style={{ borderColor: "var(--line-2)" }}
              title={`${d.molecule_type ?? ""} · ChEMBL ${d.chembl_id}`}
            >
              <i className="dot" style={{ background: phaseColor(d.max_phase) }} />
              <span className="capitalize">{d.name.toLowerCase()}</span>
              <button
                onClick={() => remove(d.chembl_id)}
                className="ml-1 t-muted hover:t-accent"
                aria-label={`Remove ${d.name}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        className="field"
        placeholder="Search a drug (approved or experimental), e.g. semaglutide, orforglipron…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
      />

      {open && q.trim().length >= 2 && (
        <div
          className="absolute z-20 left-0 right-0 mt-1 rounded-md overflow-hidden max-h-72 overflow-y-auto"
          style={{ background: "var(--panel-solid, #0d1122)", border: "1px solid var(--line-3)" }}
        >
          {loading && results.length === 0 ? (
            <div className="px-3 py-2 mono text-[12px] t-muted">searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 mono text-[12px] t-muted">
              no drug matches “{q.trim()}” in ChEMBL
            </div>
          ) : (
            results.map((d) => {
              const already = selectedIds.has(d.chembl_id);
              return (
                <button
                  key={d.chembl_id}
                  onClick={() => add(d)}
                  disabled={already}
                  className="w-full text-left px-3 py-2 flex items-center justify-between gap-3 transition-colors"
                  style={{ background: "transparent", opacity: already ? 0.4 : 1 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-dim)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span className="text-[13.5px] capitalize truncate">{d.name.toLowerCase()}</span>
                  <span className="mono text-[10px] flex-none" style={{ color: phaseColor(d.max_phase) }}>
                    {already ? "added" : phaseLabel(d.max_phase)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
