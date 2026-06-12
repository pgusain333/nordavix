/**
 * BlogIndex — /blog
 *
 * "Finance editorial" design matching the marketing site: a deep-pine
 * masthead with a Fraunces serif title, the newest post as a large
 * FEATURED story, mono category filter chips, and a paper-card grid for
 * the archive. Color appears only where it carries meaning (the category
 * accents from categories.ts — all muted, on-brand tones).
 *
 * SEO: list page emits Breadcrumb JSON-LD; per-post schema lives on the
 * post pages themselves.
 */
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowRight, Clock } from "lucide-react"
import { POSTS } from "@/marketing/blog/posts/registry"
import { CATEGORIES, getCategoryMeta } from "@/marketing/blog/categories"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, breadcrumbSchema } from "@/marketing/seo/SEO"

const SERIF = '"Fraunces", Georgia, serif'
const MONO  = '"JetBrains Mono", ui-monospace, monospace'
const PINE  = "#0C2620"

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  })
}

export function BlogIndex() {
  const [activeCat, setActiveCat] = useState<string | null>(null)

  const filtered = useMemo(
    () => (activeCat ? POSTS.filter((p) => p.meta.category === activeCat) : POSTS),
    [activeCat],
  )
  // Featured = newest post overall (only when unfiltered, so a category
  // view reads as a clean archive list).
  const featured = !activeCat ? filtered[0] : undefined
  const rest     = featured ? filtered.slice(1) : filtered

  return (
    <BlogLayout>
      <SEO
        title="Blog — close guides for CPAs & controllers"
        description="Practical writing on the month-end close, intercompany consolidation, AI in accounting, QuickBooks workflows, and everything Nordavix is building. Written by CPAs."
        path="/blog"
        jsonLd={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
        ])}
      />

      {/* ── Masthead — pine editorial band ──────────────────────────── */}
      <section className="relative overflow-hidden" style={{ background: PINE }}>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{
          backgroundImage: "linear-gradient(rgba(244,241,233,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(244,241,233,0.07) 1px, transparent 1px)",
          backgroundSize: "64px 64px", opacity: 0.5,
          maskImage: "radial-gradient(120% 80% at 50% 0%, black, transparent 80%)",
          WebkitMaskImage: "radial-gradient(120% 80% at 50% 0%, black, transparent 80%)",
        }} />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-14 pb-12 sm:pt-20 sm:pb-16">
          <div className="flex items-center gap-2.5 text-[11px] font-medium tracking-[0.22em] uppercase"
            style={{ fontFamily: MONO, color: "#9CC4AD" }}>
            <span className="h-[5px] w-[5px] rounded-[1px]" style={{ background: "#9CC4AD" }} />
            The Nordavix journal
          </div>
          <h1 className="mt-5 max-w-2xl" style={{
            fontFamily: SERIF, fontWeight: 550, lineHeight: 1.05,
            fontSize: "clamp(2.2rem, 5vw, 3.6rem)", color: "#F4F1E9", letterSpacing: "-0.01em",
          }}>
            Field notes for people who <em style={{ fontStyle: "italic", color: "#9CC4AD" }}>close the books</em>.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed" style={{ color: "rgba(244,241,233,0.68)" }}>
            Reconciliation technique, close-process design, controls that survive small
            teams, and what AI actually changes — written by CPAs, with worked numbers.
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">

        {/* ── Category chips ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap py-6" role="tablist" aria-label="Filter posts by category">
          {[null, ...CATEGORIES.map((c) => c.label)].map((label) => {
            const on = activeCat === label
            return (
              <button key={label ?? "all"} role="tab" aria-selected={on}
                onClick={() => setActiveCat(label)}
                className="rounded-full px-3.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] transition-all"
                style={{
                  fontFamily: MONO,
                  background: on ? PINE : "var(--surface)",
                  color: on ? "#F4F1E9" : "var(--text-2)",
                  border: `1px solid ${on ? PINE : "var(--border-strong)"}`,
                }}>
                {label ?? "All posts"}
              </button>
            )
          })}
        </div>

        {/* ── Featured story ─────────────────────────────────────────── */}
        {featured && (() => {
          const m = featured.meta
          const cat = getCategoryMeta(m.category)
          const CatIcon = cat.icon
          return (
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
              <Link to={`/blog/${m.slug}`}
                className="group block rounded-2xl overflow-hidden mb-10 transition-all hover:-translate-y-0.5"
                style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", boxShadow: "var(--card-shadow-hover)" }}>
                <div className="h-[5px]" style={{ background: `linear-gradient(90deg, ${cat.gradient[0]}, ${cat.gradient[1]})` }} />
                <div className="grid md:grid-cols-[1fr_280px] gap-6 p-6 sm:p-9">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.12em]"
                        style={{ fontFamily: MONO, background: cat.bg, color: cat.color }}>
                        <CatIcon size={10} strokeWidth={2.2} /> {cat.label}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ fontFamily: MONO, color: "var(--text-muted)" }}>
                        Latest
                      </span>
                    </div>
                    <h2 className="mt-4 transition-opacity group-hover:opacity-85" style={{
                      fontFamily: SERIF, fontWeight: 560, lineHeight: 1.14,
                      fontSize: "clamp(1.5rem, 3vw, 2.1rem)", color: "var(--text)", letterSpacing: "-0.01em",
                    }}>
                      {m.title}
                    </h2>
                    <p className="mt-3 text-[14.5px] leading-relaxed max-w-2xl" style={{ color: "var(--text-2)" }}>
                      {m.excerpt}
                    </p>
                    <div className="mt-5 flex items-center gap-4 text-[11px]" style={{ fontFamily: MONO, color: "var(--text-muted)" }}>
                      <span>{formatDate(m.date)}</span>
                      <span className="inline-flex items-center gap-1"><Clock size={11} strokeWidth={2} /> {m.readingTime}</span>
                      <span className="ml-auto hidden sm:inline-flex items-center gap-1.5 font-bold" style={{ color: "var(--green)" }}>
                        READ <ArrowRight size={12} strokeWidth={2.4} className="transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </div>
                  {/* Editorial monogram panel — the category icon as cover art. */}
                  <div className="hidden md:flex items-center justify-center rounded-xl"
                    style={{ background: `linear-gradient(150deg, ${cat.gradient[0]}, ${cat.gradient[1]})` }}>
                    <CatIcon size={88} strokeWidth={1} style={{ color: "rgba(244,241,233,0.85)" }} />
                  </div>
                </div>
              </Link>
            </motion.div>
          )
        })()}

        {/* ── Archive grid ───────────────────────────────────────────── */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {rest.map((p, i) => {
            const m = p.meta
            const cat = getCategoryMeta(m.category)
            const CatIcon = cat.icon
            return (
              <motion.div key={m.slug}
                initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: Math.min(i * 0.04, 0.3) }}>
                <Link to={`/blog/${m.slug}`}
                  className="group flex flex-col h-full rounded-xl overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-lg"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                  <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${cat.gradient[0]}, ${cat.gradient[1]})` }} />
                  <div className="flex flex-col flex-1 p-5">
                    <span className="self-start inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
                      style={{ fontFamily: MONO, background: cat.bg, color: cat.color }}>
                      <CatIcon size={9} strokeWidth={2.2} /> {cat.label}
                    </span>
                    <h3 className="mt-3 transition-opacity group-hover:opacity-85" style={{
                      fontFamily: SERIF, fontWeight: 580, lineHeight: 1.22,
                      fontSize: 19, color: "var(--text)", letterSpacing: "-0.005em",
                    }}>
                      {m.title}
                    </h3>
                    <p className="mt-2 text-[12.5px] leading-relaxed flex-1" style={{
                      color: "var(--text-2)",
                      display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {m.excerpt}
                    </p>
                    <div className="mt-4 pt-3 flex items-center gap-3 text-[10px]"
                      style={{ fontFamily: MONO, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                      <span>{formatDate(m.date)}</span>
                      <span className="inline-flex items-center gap-1"><Clock size={10} strokeWidth={2} /> {m.readingTime}</span>
                      <ArrowRight size={12} strokeWidth={2.4} className="ml-auto transition-transform group-hover:translate-x-0.5"
                        style={{ color: "var(--green)" }} />
                    </div>
                  </div>
                </Link>
              </motion.div>
            )
          })}
        </div>

        {filtered.length === 0 && (
          <p className="py-16 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            Nothing in this category yet — check back soon.
          </p>
        )}

        {/* ── Bottom CTA — pine band ─────────────────────────────────── */}
        <div className="mt-16 rounded-2xl overflow-hidden relative" style={{ background: PINE }}>
          <div aria-hidden className="pointer-events-none absolute inset-0" style={{
            backgroundImage: "linear-gradient(rgba(244,241,233,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(244,241,233,0.06) 1px, transparent 1px)",
            backgroundSize: "56px 56px", opacity: 0.6,
          }} />
          <div className="relative px-7 py-10 sm:px-12 sm:py-12 flex flex-col sm:flex-row items-start sm:items-center gap-6 justify-between">
            <div>
              <p style={{ fontFamily: SERIF, fontWeight: 550, fontSize: "clamp(1.3rem, 2.6vw, 1.8rem)", lineHeight: 1.15, color: "#F4F1E9" }}>
                Reading about the close is good.<br />
                <em style={{ fontStyle: "italic", color: "#9CC4AD" }}>Finishing it early</em> is better.
              </p>
              <p className="mt-2 text-[13px]" style={{ color: "rgba(244,241,233,0.66)" }}>
                Nordavix runs reconciliations, flux, schedules, and the reporting package on top of QuickBooks. Free during beta.
              </p>
            </div>
            <Link to="/sign-up"
              className="shrink-0 inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-bold transition-transform hover:-translate-y-0.5"
              style={{ background: "#F4F1E9", color: PINE }}>
              Start free <ArrowRight size={14} strokeWidth={2.4} />
            </Link>
          </div>
        </div>
      </div>
    </BlogLayout>
  )
}
