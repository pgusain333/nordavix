/**
 * BlogIndex — /blog landing page.
 *
 * Layout:
 *   - Hero header with title + lead
 *   - Featured post (the newest one) as a wide gradient hero card
 *   - Category filter chips (with counts) + search input
 *   - Two-column responsive grid of remaining posts
 *   - CTA strip at bottom
 *
 * Design language matches the rest of the marketing site (surface/
 * border/text-2 tokens), with per-category accent colors threaded
 * through chips, card top-borders, and the hero gradient. The visual
 * differentiation per category is what gives the index its texture
 * without needing stock photos.
 */
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowRight, Calendar, Clock, Search, Sparkles, X } from "lucide-react"
import { POSTS } from "@/marketing/blog/posts/registry"
import { CATEGORIES, getCategoryMeta } from "@/marketing/blog/categories"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, breadcrumbSchema } from "@/marketing/seo/SEO"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  })
}

export function BlogIndex() {
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  // Featured = newest post (POSTS is already sorted desc by registry).
  const featured  = POSTS[0]
  const rest      = POSTS.slice(1)

  // Build per-category counts for the filter chips. Always show every
  // category that has at least one post — otherwise the bar grows as
  // posts arrive.
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of POSTS) counts[p.meta.category] = (counts[p.meta.category] ?? 0) + 1
    return counts
  }, [])

  const activeCategoryList = useMemo(
    () => CATEGORIES.filter((c) => (categoryCounts[c.label] ?? 0) > 0),
    [categoryCounts],
  )

  // Apply category + search filters together. We always show the
  // featured card too, so when a filter narrows the grid the featured
  // hero stays as visual anchor.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rest.filter((p) => {
      if (activeCategory && p.meta.category !== activeCategory) return false
      if (!q) return true
      return (
        p.meta.title.toLowerCase().includes(q)
        || p.meta.excerpt.toLowerCase().includes(q)
        || p.meta.category.toLowerCase().includes(q)
      )
    })
  }, [rest, activeCategory, search])

  return (
    <BlogLayout>
      <SEO
        title="Blog — guides, opinions, and deep-dives for CPAs and controllers"
        description="Practical writing on the month-end close, intercompany consolidation, AI in accounting, QuickBooks workflows, and everything Nordavix is building. Written by CPAs."
        path="/blog"
        jsonLd={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
        ])}
      />

      {/* ── Hero header ───────────────────────────────────────────── */}
      <section className="px-4 sm:px-6 lg:px-8 pt-14 pb-10 sm:pt-20 sm:pb-12"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <div className="max-w-5xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: "var(--green)" }}>
              <Sparkles size={11} strokeWidth={2} /> The Nordavix blog
            </p>
            <h1 className="font-bold leading-[1.1] tracking-tight text-theme"
              style={{ fontSize: "clamp(34px, 6vw, 56px)" }}>
              Working notes on the close.
            </h1>
            <p className="mt-4 text-base sm:text-lg max-w-2xl leading-relaxed"
              style={{ color: "var(--text-2)" }}>
              Guides, opinions, and deep-dives — written by CPAs for the people who
              actually do the close work. No fluff, no LinkedIn-influencer takes.
            </p>
          </motion.div>
        </div>
      </section>

      {/* ── Featured post hero ───────────────────────────────────── */}
      {featured && (
        <section className="px-4 sm:px-6 lg:px-8 -mt-1 pt-12">
          <div className="max-w-5xl mx-auto">
            <FeaturedCard post={featured} />
          </div>
        </section>
      )}

      {/* ── Filter strip ─────────────────────────────────────────── */}
      <section className="px-4 sm:px-6 lg:px-8 mt-12">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 flex-wrap mb-6">
            <button
              onClick={() => setActiveCategory(null)}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3.5 py-1.5 transition-all"
              style={{
                background:   activeCategory === null ? "var(--text)" : "var(--surface-2)",
                color:        activeCategory === null ? "var(--bg)" : "var(--text-2)",
                border:       "1px solid transparent",
              }}>
              All
              <span className="text-[10px] opacity-70">{POSTS.length}</span>
            </button>
            {activeCategoryList.map((c) => {
              const Icon = c.icon
              const active = activeCategory === c.label
              return (
                <button key={c.label}
                  onClick={() => setActiveCategory(active ? null : c.label)}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3.5 py-1.5 transition-all"
                  style={{
                    background: active ? c.color   : c.bg,
                    color:      active ? "#FFFFFF" : c.color,
                    border:     `1px solid ${active ? c.color : "transparent"}`,
                  }}>
                  <Icon size={11} strokeWidth={2} />
                  {c.label}
                  <span className="text-[10px] opacity-70">{categoryCounts[c.label]}</span>
                </button>
              )
            })}
            <div className="relative ml-auto w-full sm:w-64">
              <Search size={13} strokeWidth={1.8}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: "var(--text-muted)" }} />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search posts…"
                className="w-full rounded-full pl-9 pr-9 py-1.5 text-sm outline-none"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }} />
              {search && (
                <button onClick={() => setSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full flex items-center justify-center"
                  style={{ color: "var(--text-muted)" }}>
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Post grid ────────────────────────────────────────────── */}
      <section className="px-4 sm:px-6 lg:px-8 pb-16">
        <div className="max-w-5xl mx-auto">
          {filtered.length === 0 ? (
            <div className="rounded-2xl p-12 text-center"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <p className="text-sm" style={{ color: "var(--text-2)" }}>
                No posts match those filters. Try clearing them or searching for something else.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
              {filtered.map((post, i) => (
                <PostCard key={post.meta.slug} post={post} index={i} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Bottom CTA strip ─────────────────────────────────────── */}
      <section className="px-4 sm:px-6 lg:px-8 pb-20">
        <div className="max-w-5xl mx-auto rounded-2xl px-6 sm:px-10 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <div>
            <h3 className="text-xl font-bold text-theme mb-1">Try Nordavix free during beta</h3>
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              The close-process platform that does what you&apos;ve been reading about.
            </p>
          </div>
          <Link to="/sign-up"
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-md text-sm font-semibold text-white transition-all hover:opacity-90 shrink-0"
            style={{ background: "var(--green)", boxShadow: "0 4px 12px rgba(62,143,102,0.20)" }}>
            Start free workspace <ArrowRight size={13} strokeWidth={2} />
          </Link>
        </div>
      </section>
    </BlogLayout>
  )
}

// ── FeaturedCard ───────────────────────────────────────────────────
//
// The newest post gets a 2-column "hero" treatment — gradient cover
// on the left with the category badge, content + CTA on the right.
// This is the visual anchor of the blog index; everything else is a
// secondary card.

function FeaturedCard({ post }: { post: { meta: { slug: string; title: string; description: string; date: string; excerpt: string; readingTime: string; category: string; author?: string } } }) {
  const cat = getCategoryMeta(post.meta.category)
  const Icon = cat.icon
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Link to={`/blog/${post.meta.slug}`} className="block group">
        <div className="rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-5 transition-all hover:shadow-lg"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "var(--card-shadow)",
          }}>
          {/* Cover panel — gradient + faint geometric overlay */}
          <div className="md:col-span-2 relative min-h-[180px] md:min-h-[280px] overflow-hidden"
            style={{
              background: `linear-gradient(135deg, ${cat.gradient[0]} 0%, ${cat.gradient[1]} 100%)`,
            }}>
            {/* Decorative SVG mesh */}
            <svg className="absolute inset-0 w-full h-full opacity-25" preserveAspectRatio="none"
              viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <pattern id={`grid-${post.meta.slug}`} width="32" height="32" patternUnits="userSpaceOnUse">
                  <path d="M 32 0 L 0 0 0 32" fill="none" stroke="white" strokeWidth="0.6" />
                </pattern>
              </defs>
              <rect width="400" height="400" fill={`url(#grid-${post.meta.slug})`} />
            </svg>
            {/* Category badge */}
            <div className="absolute top-4 left-4 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/95 text-[10px] font-bold uppercase tracking-wider"
              style={{ color: cat.color }}>
              <Icon size={10} strokeWidth={2} /> Featured · {cat.label}
            </div>
            {/* Big category glyph */}
            <Icon size={140} strokeWidth={1}
              className="absolute -bottom-8 -right-8 text-white/30" />
          </div>
          {/* Content */}
          <div className="md:col-span-3 p-6 sm:p-8 flex flex-col">
            <div className="flex items-center gap-3 text-[11px] mb-3"
              style={{ color: "var(--text-muted)" }}>
              <span className="inline-flex items-center gap-1"><Calendar size={11} strokeWidth={1.8} /> {formatDate(post.meta.date)}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1"><Clock size={11} strokeWidth={1.8} /> {post.meta.readingTime}</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-theme leading-tight tracking-tight mb-3 group-hover:opacity-80 transition-opacity">
              {post.meta.title}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed mb-5 flex-1"
              style={{ color: "var(--text-2)" }}>
              {post.meta.excerpt}
            </p>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold self-start"
              style={{ color: cat.color }}>
              Read the post <ArrowRight size={13} strokeWidth={2} />
            </span>
          </div>
        </div>
      </Link>
    </motion.article>
  )
}

// ── PostCard ──────────────────────────────────────────────────────
//
// Standard card for non-featured posts. Top accent stripe carries the
// category color; the icon + label sit in the meta row. Hover lifts
// the whole card with a softer shadow.

function PostCard({ post, index }: {
  post: { meta: { slug: string; title: string; excerpt: string; date: string; readingTime: string; category: string } }
  index: number
}) {
  const cat = getCategoryMeta(post.meta.category)
  const Icon = cat.icon
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.04 + index * 0.04 }}
      className="rounded-2xl overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-md"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--card-shadow)",
      }}>
      <Link to={`/blog/${post.meta.slug}`} className="block group h-full flex flex-col">
        {/* Top accent stripe — category color */}
        <div className="h-1" style={{ background: `linear-gradient(90deg, ${cat.gradient[0]}, ${cat.gradient[1]})` }} />

        <div className="p-5 sm:p-6 flex-1 flex flex-col">
          <div className="flex items-center gap-3 text-[11px] mb-3"
            style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider text-[10px]"
              style={{ background: cat.bg, color: cat.color }}>
              <Icon size={10} strokeWidth={2} /> {cat.label}
            </span>
            <span className="inline-flex items-center gap-1"><Calendar size={11} strokeWidth={1.8} /> {formatDate(post.meta.date)}</span>
            <span className="inline-flex items-center gap-1"><Clock size={11} strokeWidth={1.8} /> {post.meta.readingTime}</span>
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-theme leading-snug tracking-tight mb-2 group-hover:opacity-80 transition-opacity">
            {post.meta.title}
          </h2>
          <p className="text-sm leading-relaxed mb-4 flex-1"
            style={{ color: "var(--text-2)" }}>
            {post.meta.excerpt}
          </p>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold self-start"
            style={{ color: cat.color }}>
            Read post <ArrowRight size={11} strokeWidth={2} />
          </span>
        </div>
      </Link>
    </motion.article>
  )
}
