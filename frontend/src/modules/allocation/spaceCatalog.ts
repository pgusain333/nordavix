/**
 * The standard cannabis facility layout.
 *
 * A licensed operator's floor plan is largely the same everywhere, so the
 * preparer shouldn't be inventing room names — they should be ticking off the
 * ones this client has and entering the square footage.
 *
 * Each entry carries a SUGGESTED function only. Square footage is always
 * entered by hand (nobody can guess it), and the function stays editable,
 * because the same room name means different things at different operators —
 * "Vault/Inventory storage" is finished-goods storage at one client and a
 * production staging area at another.
 *
 * `productionPct` is the starting point for the occupancy driver:
 *   100 — unambiguously production space
 *     0 — unambiguously not
 *  other — a genuinely mixed room, pre-set to a defensible split the preparer
 *          confirms or overrides
 */
export interface CatalogSpace {
  name: string
  function: string
  /** Suggested production %, shown and editable before anything is saved. */
  productionPct: number
  note?: string
}

export const SPACE_CATALOG: CatalogSpace[] = [
  // ── Production ──────────────────────────────────────────────────────────
  { name: "Cultivation/Grow rooms",           function: "cultivation", productionPct: 100 },
  { name: "Veg/Propagation/Clone room",       function: "cultivation", productionPct: 100 },
  { name: "Drying/Curing room",               function: "curing",      productionPct: 100 },
  { name: "Trim/Processing room",             function: "processing",  productionPct: 100 },
  { name: "Extraction/Manufacturing lab",     function: "processing",  productionPct: 100 },
  { name: "Packaging/Pre-sale area",          function: "packaging",   productionPct: 100 },

  // ── Mixed — pre-set to a split the preparer confirms ────────────────────
  {
    name: "Receiving/Intake/QA", function: "shared", productionPct: 50,
    note: "Handles both inbound production inputs and retail stock — split it.",
  },
  {
    name: "Vault/Inventory storage", function: "storage", productionPct: 50,
    note: "Production inventory vs finished retail stock — set the split you can support.",
  },
  {
    name: "Security/Compliance office", function: "shared", productionPct: 50,
    note: "Serves the whole site; seat-of-the-pants 50/50 unless you have better evidence.",
  },
  {
    name: "Break room/Restrooms/Common areas", function: "shared", productionPct: 0,
    note: "Commonly split on headcount — override if you allocate these.",
  },
  { name: "Hallways/Corridors",            function: "shared",  productionPct: 0 },
  { name: "Mechanical/Utility room",       function: "shared",  productionPct: 0 },

  // ── Non-production ──────────────────────────────────────────────────────
  { name: "Retail sales floor",            function: "retail",  productionPct: 0 },
  { name: "Point of sale/Checkout stations", function: "retail", productionPct: 0 },
  { name: "Reception/Waiting/ID check",    function: "retail",  productionPct: 0 },
  { name: "Admin office/Management",       function: "office",  productionPct: 0 },
  { name: "Delivery/Dispatch area",        function: "retail",  productionPct: 0 },
]

export const SPACE_FUNCTIONS = [
  "cultivation", "processing", "curing", "packaging",
  "retail", "office", "storage", "shared",
]

/** Kept in step with PRODUCTION_SPACE_FUNCTIONS in the engine. */
export const PRODUCTION_SPACE_FUNCTIONS = new Set([
  "cultivation", "processing", "curing", "packaging",
])
