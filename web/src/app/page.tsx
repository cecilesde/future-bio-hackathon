import Shell from "@/components/Shell";

export default function Page() {
  return (
    <main>
      <Shell />
      <footer className="max-w-[1120px] mx-auto px-4 sm:px-6 py-8 hairline">
        <div className="flex flex-wrap items-center justify-between gap-3 mono text-[11px] t-muted">
          <span>
            PROGNOSIS · reference-class attrition forecasting · demo build
          </span>
          <span className="t-faint">
            Cohort outcomes and scores are illustrative, not verified clinical fact.
          </span>
        </div>
      </footer>
    </main>
  );
}
