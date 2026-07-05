"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Drug, Note } from "@/lib/types";
import { MAX_NOTE_BODY } from "@/lib/types";

const AUTHOR_LS_KEY = "attritio_note_author";

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16);
}

// Shared, per-(disease, drug) researcher notes. Prior notes on top, freeform markdown
// input below. Keyed server-side by (efoId-or-diseaseName, chembl_id-or-name); target
// is intentionally ignored, so the same drug in the same indication shares notes.
export default function NotesPanel({
  diseaseId,
  diseaseName,
  drug,
}: {
  diseaseId: string | null;
  diseaseName: string;
  drug: Drug;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [author, setAuthor] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const params = new URLSearchParams({
    diseaseId: diseaseId ?? "",
    diseaseName,
    drugChembl: drug.chembl_id ?? "",
    drugName: drug.name ?? "",
  }).toString();

  // remember the author's name across queries (no login)
  useEffect(() => {
    try {
      setAuthor(localStorage.getItem(AUTHOR_LS_KEY) ?? "");
    } catch {
      /* ignore */
    }
  }, []);

  // load prior notes for this (disease, drug)
  useEffect(() => {
    let live = true;
    setNotes(null);
    setLoadError("");
    fetch(`/api/notes?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d.error) setLoadError(d.error);
        else setNotes((d.notes ?? []) as Note[]);
      })
      .catch((e) => {
        if (live) setLoadError(String(e));
      });
    return () => {
      live = false;
    };
  }, [params]);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          diseaseId: diseaseId ?? "",
          diseaseName,
          drugChembl: drug.chembl_id ?? "",
          drugName: drug.name ?? "",
          author: author.trim(),
          body: trimmed,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "save failed");
      try {
        localStorage.setItem(AUTHOR_LS_KEY, author.trim());
      } catch {
        /* ignore */
      }
      setNotes((prev) => [d.note as Note, ...(prev ?? [])]);
      setText("");
    } catch (e) {
      setSaveError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  const drugLabel = drug.name.toLowerCase();

  return (
    <section className="rise">
      <div className="mb-4 flex gap-4">
        <span className="mono text-[13px] t-accent pt-1 select-none">✎</span>
        <div>
          <h3 className="serif text-[22px] leading-tight">Researcher notes</h3>
          <p className="text-[13.5px] t-muted mt-1 max-w-[70ch] leading-snug">
            Shared notes from anyone who ran <span className="t-dim">{drugLabel}</span> in{" "}
            <span className="t-dim">{diseaseName}</span>. Visible to the next person who runs the same
            drug in the same indication. Markdown supported.
          </p>
        </div>
      </div>

      <div className="panel p-4 sm:p-5">
        {notes === null && !loadError && <p className="text-[13px] t-muted">Loading notes…</p>}
        {loadError && (
          <p className="text-[13px]" style={{ color: "var(--red)" }}>
            Could not load notes: {loadError}
          </p>
        )}
        {notes && notes.length === 0 && (
          <p className="text-[13px] t-muted">
            No notes yet for {drugLabel} in {diseaseName}. Add the first one below.
          </p>
        )}
        {notes && notes.length > 0 && (
          <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-1 mb-4">
            {notes.map((n, i) => (
              <div
                key={i}
                className="rounded-md p-3"
                style={{ background: "var(--bg-2)", border: "1px solid var(--line)" }}
              >
                <div className="note-md text-[13px] t-dim leading-snug">
                  <ReactMarkdown>{n.body}</ReactMarkdown>
                </div>
                <div className="mono text-[10.5px] t-muted mt-2">
                  — {n.author || "Anonymous"} · {fmtDate(n.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t pt-4" style={{ borderColor: "var(--line)" }}>
          <textarea
            className="field"
            style={{ minHeight: 90, resize: "vertical" }}
            placeholder="Add a note for this drug + indication…  (markdown: **bold**, - lists, # headings)"
            value={text}
            maxLength={MAX_NOTE_BODY}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3 mt-2">
            <input
              className="field"
              style={{ maxWidth: 220 }}
              placeholder="Your name (optional)"
              value={author}
              maxLength={80}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <button
              onClick={save}
              disabled={saving || !text.trim()}
              className="mono text-[13px] px-5 py-2 rounded-md disabled:opacity-50"
              style={{ background: "var(--accent-dim)", border: "1px solid var(--accent)", color: "var(--accent)" }}
            >
              {saving ? "Saving…" : "Save note"}
            </button>
            <span className="mono text-[10.5px] t-muted">
              {text.length}/{MAX_NOTE_BODY}
            </span>
            {saveError && (
              <span className="text-[12px]" style={{ color: "var(--red)" }}>
                {saveError}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
