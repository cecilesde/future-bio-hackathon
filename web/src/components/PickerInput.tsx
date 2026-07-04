"use client";

import { useEffect, useRef, useState } from "react";

export interface PickItem {
  id: string;
  label: string;
  sub?: string;
}

export default function PickerInput({
  value,
  onSelect,
  endpoint,
  placeholder,
  allowFreeText = false,
}: {
  value: PickItem | null;
  onSelect: (item: PickItem | null) => void;
  endpoint: string;
  placeholder: string;
  allowFreeText?: boolean;
}) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState<PickItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // keep the field text in sync when the selection changes from outside
  useEffect(() => {
    setQuery(value?.label ?? "");
  }, [value?.label]);

  useEffect(() => {
    if (query.trim().length < 2 || query.trim() === value?.label) {
      setResults([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`${endpoint}?q=${encodeURIComponent(query.trim())}`, { signal: ctl.signal });
        const data = await r.json();
        setResults(data.items ?? []);
        setOpen(true);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, endpoint, value?.label]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(it: PickItem) {
    onSelect(it);
    setQuery(it.label);
    setResults([]);
    setOpen(false);
  }
  function clear() {
    onSelect(null);
    setQuery("");
    setResults([]);
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <input
          className="field"
          style={{ paddingRight: value ? 30 : 12 }}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && allowFreeText && query.trim() && !results.length) {
              pick({ id: query.trim(), label: query.trim() });
            }
          }}
        />
        {value && (
          <button
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 t-muted hover:t-accent mono text-[12px]"
            aria-label="Clear"
          >
            ✕
          </button>
        )}
      </div>

      {open && query.trim().length >= 2 && query.trim() !== value?.label && (
        <div
          className="absolute z-30 left-0 right-0 mt-1 rounded-md overflow-hidden max-h-72 overflow-y-auto"
          style={{ background: "var(--panel-solid, #0d1122)", border: "1px solid var(--line-3)" }}
        >
          {loading && results.length === 0 ? (
            <div className="px-3 py-2 mono text-[12px] t-muted">searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 mono text-[12px] t-muted">
              {allowFreeText ? `press Enter to use “${query.trim()}”` : `no match for “${query.trim()}”`}
            </div>
          ) : (
            results.map((it) => (
              <button
                key={it.id}
                onClick={() => pick(it)}
                className="w-full text-left px-3 py-2 flex items-center justify-between gap-3"
                style={{ background: "transparent" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-dim)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="text-[13.5px] truncate">{it.label}</span>
                {it.sub && <span className="mono text-[10px] t-muted flex-none">{it.sub}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
