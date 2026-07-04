// Types + shared display constants for the trial-landscape tab. The data itself
// is loaded from Supabase in server-data.ts (getDistribution).

export interface DiseaseStrat {
  disease: string;
  trials: number;
  phases: { P1: number; P2: number; P3: number; P4: number; NA: number };
  status: { completed: number; ongoing: number; stopped: number; other: number };
  enrollment: number;
  topInterventions?: { name: string; n: number }[];
}

export interface AreaStrat {
  area: string;
  trials: number;
  diseases: DiseaseStrat[];
}

export interface TrialDistribution {
  meta: {
    source: string;
    totalUniqueTrials: number;
    mappedTrials: number;
    excludedNonDisease: number;
    unmappedConditionMentions: number;
    areas: number;
    note: string;
  };
  areas: AreaStrat[];
}

export const PHASE_LABELS: Record<keyof DiseaseStrat["phases"], string> = {
  P1: "Phase 1",
  P2: "Phase 2",
  P3: "Phase 3",
  P4: "Phase 4",
  NA: "N/A",
};

// later-phase = more saturated accent; NA muted
export const PHASE_COLORS: Record<keyof DiseaseStrat["phases"], string> = {
  P1: "#2f5d4e",
  P2: "#3f8770",
  P3: "#57b394",
  P4: "#8adcbb",
  NA: "#2b3733",
};
