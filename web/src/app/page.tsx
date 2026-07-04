import Shell from "@/components/Shell";
import { getDiseases, getReports, getDistribution } from "@/lib/server-data";

// Fetch from Supabase per request (no build-time prerender coupling).
export const dynamic = "force-dynamic";

export default async function Page() {
  const [diseases, reports, distribution] = await Promise.all([
    getDiseases(),
    getReports(),
    getDistribution(),
  ]);

  return (
    <main>
      <Shell diseases={diseases} reports={reports} distribution={distribution} />
      <footer className="max-w-[1120px] mx-auto px-4 sm:px-6 py-8 hairline">
        <div className="flex flex-wrap items-center justify-between gap-3 mono text-[11px] t-muted">
          <span>PROGNOSIS · reference-class attrition forecasting</span>
          <span className="t-faint">
            Targets from Open Targets · trials from AMASS · forecasts illustrative.
          </span>
        </div>
      </footer>
    </main>
  );
}
