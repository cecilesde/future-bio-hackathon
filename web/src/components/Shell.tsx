"use client";

import { useState } from "react";
import Prognosis from "./Prognosis";
import TrialLandscape from "./TrialLandscape";
import type { Disease, Report, Paper } from "@/lib/types";
import type { TrialDistribution } from "@/lib/trials";

type Tab = "forecast" | "landscape";

export default function Shell({
  diseases,
  reports,
  literature,
  distribution,
}: {
  diseases: Disease[];
  reports: Record<string, Report>;
  literature: Record<string, Paper[]>;
  distribution: TrialDistribution;
}) {
  const [tab, setTab] = useState<Tab>("forecast");

  return (
    <>
      <div className="max-w-[1120px] mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between gap-4 pt-6">
          <div className="mono text-[13px] tracking-[0.35em] t-accent flex-none">PROGNOSIS</div>

          <nav
            className="flex items-center gap-1 p-1 rounded-full"
            style={{ border: "1px solid var(--line-2)", background: "var(--bg-2)" }}
          >
            <TabButton active={tab === "forecast"} onClick={() => setTab("forecast")}>
              Forecast
            </TabButton>
            <TabButton active={tab === "landscape"} onClick={() => setTab("landscape")}>
              Trial landscape
            </TabButton>
          </nav>

          {tab === "forecast" ? (
            <span
              className="pill flex-none"
              style={{ borderColor: "var(--line-2)" }}
              title="Reports are authored/illustrative; targets are live from Open Targets."
            >
              <i className="dot" style={{ background: "var(--amber)" }} /> illustrative forecasts
            </span>
          ) : (
            <span
              className="pill flex-none"
              style={{ borderColor: "var(--green-dim)", color: "var(--green)" }}
              title="Real records harvested from the AMASS trialcore API, served from Supabase."
            >
              <i className="dot" style={{ background: "var(--green)" }} />{" "}
              {distribution.meta.totalUniqueTrials.toLocaleString()} AMASS trials
            </span>
          )}
        </div>
      </div>

      {tab === "forecast" ? (
        <Prognosis diseases={diseases} reports={reports} literature={literature} />
      ) : (
        <TrialLandscape distribution={distribution} />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="mono text-[12px] px-3.5 py-1.5 rounded-full transition-colors"
      style={{
        background: active ? "var(--accent-dim)" : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
      }}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
