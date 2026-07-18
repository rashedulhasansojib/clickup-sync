import type { WorkspaceTunables } from "@ma/shared";

/**
 * v2 Phase 5 — form metadata for each `WorkspaceTunables` field. The Zod
 * schema in `@ma/shared/ml-config.ts` is the source of truth for min/max/step;
 * these values MUST stay in sync with the schema's constraints. When a new
 * tunable is added, extend this map + the Zod schema together.
 *
 * `consumed` marks fields the runtime already reads from `WorkspaceMlConfig`
 * (Phase 5 wired dup bands + gate values). Every other field is stored but
 * not yet consumed — the UI adds a caveat chip so an Owner isn't misled.
 */
export interface TunableMeta {
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  section: "duplicates" | "similarity" | "gate" | "novelty" | "kb";
  consumed: boolean;
}

export const TUNABLE_META: Record<keyof WorkspaceTunables, TunableMeta> = {
  dupFlag: {
    label: "Duplicate flag threshold",
    description: "≥ this cosine ⇒ hard duplicate. Empirically ~0.72 in this corpus.",
    min: 0,
    max: 1,
    step: 0.01,
    section: "duplicates",
    consumed: true,
  },
  dupSuggest: {
    label: "Duplicate suggest threshold",
    description: "≥ this (and < flag) ⇒ soft duplicate.",
    min: 0,
    max: 1,
    step: 0.01,
    section: "duplicates",
    consumed: true,
  },
  simFloor: {
    label: "Similarity floor",
    description: "Neighbours below this cosine are treated as noise.",
    min: 0,
    max: 1,
    step: 0.01,
    section: "similarity",
    consumed: false,
  },
  minQualifying: {
    label: "Min. qualifying neighbours",
    description: "Fewer than this ⇒ thin history ⇒ abstain.",
    min: 1,
    max: 20,
    step: 1,
    section: "similarity",
    consumed: false,
  },
  closedWeight: {
    label: "Closed-neighbour weight",
    description: "Closed vs open weighting in assignment ranking.",
    min: 0.1,
    max: 10,
    step: 0.1,
    section: "similarity",
    consumed: false,
  },
  minCorrections: {
    label: "Min. corrections to gate",
    description: "Organic corrections before the learning loop nudges.",
    min: 1,
    max: 20,
    step: 1,
    section: "gate",
    consumed: true,
  },
  minAgreement: {
    label: "Min. agreement rate",
    description: "Agreement ratio required over those corrections.",
    min: 0,
    max: 1,
    step: 0.05,
    section: "gate",
    consumed: true,
  },
  rrfK: {
    label: "RRF k",
    description: "Reciprocal-rank-fusion constant (standard is 60).",
    min: 1,
    max: 500,
    step: 1,
    section: "kb",
    consumed: false,
  },
  novelMaxSimCutoff: {
    label: "Novelty max-sim cutoff",
    description: "Doc chunks under this peak similarity count as novel.",
    min: 0,
    max: 1,
    step: 0.01,
    section: "novelty",
    consumed: false,
  },
  linkMinSim: {
    label: "Doc↔task link min sim",
    description: "Minimum cosine for the auto-discovered link.",
    min: 0,
    max: 1,
    step: 0.01,
    section: "novelty",
    consumed: false,
  },
  embedBatch: {
    label: "Embed batch size",
    description: "Chunks per embedding call (worker startup constant).",
    min: 1,
    max: 512,
    step: 1,
    section: "kb",
    consumed: false,
  },
};

export const SECTION_TITLES: Record<TunableMeta["section"], string> = {
  duplicates: "Duplicate detection",
  similarity: "Similarity & neighbours",
  gate: "Learning gate",
  novelty: "Novelty & doc linking",
  kb: "Knowledge base",
};

export const SECTIONS: Array<TunableMeta["section"]> = [
  "duplicates",
  "similarity",
  "gate",
  "novelty",
  "kb",
];
