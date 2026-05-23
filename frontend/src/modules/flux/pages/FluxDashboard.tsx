/**
 * Phase 1 placeholder for the Flux Analysis dashboard.
 * Full implementation in Phase 2 (upload) and Phase 5 (variance review table).
 */
export function FluxDashboard() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Flux Analysis</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            AI-powered month-end variance commentary
          </p>
        </div>
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          disabled
        >
          Upload Trial Balance
        </button>
      </div>

      {/* Empty state — shown until first TB is uploaded */}
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
            <svg
              className="h-6 w-6 text-blue-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
          </div>
          <h2 className="text-sm font-semibold text-slate-900 mb-1">
            No trial balances yet
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            Upload a trial balance (Excel or CSV) with current and prior period
            columns to generate AI-powered flux commentary.
          </p>
          <p className="text-xs text-slate-400 mt-4">
            Upload functionality coming in Phase 2.
          </p>
        </div>
      </div>
    </div>
  )
}
