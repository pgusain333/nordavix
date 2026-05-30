/**
 * BlogPostPage — /blog/:slug
 *
 * Sections (top → bottom):
 *   - Reading-progress bar pinned to top of viewport
 *   - Category-gradient hero with title + meta
 *   - Two-col body on desktop: post on the left, sticky TOC + share
 *     panel on the right. Single-col on mobile (no TOC).
 *   - Author bio card
 *   - Related posts (up to 3, same category preferred)
 *   - Prev / next post navigation
 *   - CTA card
 *
 * SEO: emits per-post Article + BreadcrumbList JSON-LD. Title +
 * description + canonical come from `meta` via the <SEO> component.
 */
import { useEffect, useMemo, useState } from "react"
import { Link, useParams, Navigate } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import {
  ArrowLeft, ArrowRight, Calendar, Clock, Share2, Linkedin, Twitter,
  Link as LinkIcon, Check, ChevronRight, Sparkles,
} from "lucide-react"
import { findPostBySlug, POSTS } from "@/marketing/blog/posts/registry"
import { getCategoryMeta } from "@/marketing/blog/categories"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, articleSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import "@/marketing/blog/blog-prose.css"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  })
}

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>()
  const post = slug ? findPostBySlug(slug) : undefined
  const [progress, setProgress] = useState(0)

  // Scroll to top on slug change so the next post starts at the title.
  useEffect(() => {
    if (post) window.scrollTo({ top: 0 })
  }, [post])

  // Reading-progress bar — listens to scroll and computes percentage
  // through the document. Throttled via requestAnimationFrame so it
  // doesn't fight the scroll thread.
  useEffect(() => {
    let raf = 0
    const handler = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const scrollTop = document.documentElement.scrollTop || document.body.scrollTop
        const height    = (document.documentElement.scrollHeight || 1) - window.innerHeight
        const pct       = height > 0 ? (scrollTop / height) * 100 : 0
        setProgress(Math.max(0, Math.min(100, pct)))
      })
    }
    window.addEventListener("scroll", handler, { passive: true })
    handler()
    return () => {
      window.removeEventListener("scroll", handler)
      cancelAnimationFrame(raf)
    }
  }, [slug])

  // Prev / next sibling in the (sorted-desc) POSTS list. Used in the
  // bottom navigator below the article.
  const { prev, next } = useMemo(() => {
    if (!post) return { prev: undefined, next: undefined }
    const idx = POSTS.findIndex((p) => p.meta.slug === post.meta.slug)
    return {
      prev: idx > 0 ? POSTS[idx - 1] : undefined,
      next: idx < POSTS.length - 1 ? POSTS[idx + 1] : undefined,
    }
  }, [post])

  // Related — up to 2 other posts from the same category, fall back to
  // most recent if the category only has one.
  const related = useMemo(() => {
    if (!post) return []
    const sameCat = POSTS.filter(
      (p) => p.meta.slug !== post.meta.slug && p.meta.category === post.meta.category,
    )
    const others = POSTS.filter(
      (p) => p.meta.slug !== post.meta.slug && p.meta.category !== post.meta.category,
    )
    return [...sameCat, ...others].slice(0, 2)
  }, [post])

  if (!post) {
    return <Navigate to="/blog" replace />
  }
  const { meta, Body } = post
  const cat            = getCategoryMeta(meta.category)
  const CatIcon        = cat.icon

  const article = articleSchema({
    title:         meta.title,
    description:   meta.description,
    slug:          meta.slug,
    datePublished: meta.date,
    dateModified:  meta.lastModified,
    author:        meta.author,
  })
  const crumbs = breadcrumbSchema([
    { name: "Home",  path: "/" },
    { name: "Blog",  path: "/blog" },
    { name: meta.title, path: `/blog/${meta.slug}` },
  ])

  return (
    <BlogLayout>
      <SEO
        title={meta.title}
        description={meta.description}
        path={`/blog/${meta.slug}`}
        ogType="article"
        jsonLd={[article, crumbs]}
      />

      {/* Reading-progress bar pinned just below the marketing nav. */}
      <div className="fixed top-14 inset-x-0 z-40 h-[3px]" style={{ background: "transparent" }}>
        <motion.div
          className="h-full origin-left"
          style={{
            background: `linear-gradient(90deg, ${cat.gradient[0]}, ${cat.gradient[1]})`,
            width: `${progress}%`,
            transition: "width 0.08s linear",
          }} />
      </div>

      {/* ── Hero — gradient header with title + meta ────────────── */}
      <section className="relative overflow-hidden"
        style={{
          background: `linear-gradient(135deg, ${cat.gradient[0]} 0%, ${cat.gradient[1]} 100%)`,
        }}>
        {/* Geometric overlay so the hero never feels flat */}
        <svg className="absolute inset-0 w-full h-full opacity-15 pointer-events-none"
          preserveAspectRatio="none" viewBox="0 0 1200 400" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="hero-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.6" />
            </pattern>
          </defs>
          <rect width="1200" height="400" fill="url(#hero-grid)" />
        </svg>
        {/* Huge category icon as decoration */}
        <CatIcon size={260} strokeWidth={0.8}
          className="absolute -right-12 -top-12 text-white/15 hidden md:block" />

        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          <nav className="text-[11px] mb-5 flex items-center gap-1.5 text-white/85">
            <Link to="/" className="hover:text-white">Home</Link>
            <ChevronRight size={11} strokeWidth={2} className="opacity-60" />
            <Link to="/blog" className="hover:text-white">Blog</Link>
            <ChevronRight size={11} strokeWidth={2} className="opacity-60" />
            <span className="text-white/70">{cat.label}</span>
          </nav>

          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/95 text-[10px] font-bold uppercase tracking-wider mb-4"
            style={{ color: cat.color }}>
            <CatIcon size={10} strokeWidth={2} /> {cat.label}
          </div>

          <h1 className="font-bold leading-[1.1] tracking-tight text-white max-w-3xl"
            style={{ fontSize: "clamp(28px, 5vw, 46px)" }}>
            {meta.title}
          </h1>

          <p className="mt-4 text-base sm:text-lg text-white/85 max-w-2xl leading-relaxed">
            {meta.description}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-white/85">
            <span className="inline-flex items-center gap-1.5">
              <Calendar size={12} strokeWidth={1.8} /> {formatDate(meta.date)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={12} strokeWidth={1.8} /> {meta.readingTime}
            </span>
            <span>By {meta.author ?? "The Founder CPA"}</span>
          </div>
        </div>
      </section>

      {/* ── Article body + sticky side panel ────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14
                      grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-10">
        <article className="min-w-0">
          <Link to="/blog"
            className="inline-flex items-center gap-1 text-xs font-medium mb-6 transition-opacity hover:opacity-70"
            style={{ color: "var(--text-muted)" }}>
            <ArrowLeft size={12} strokeWidth={2} /> All posts
          </Link>

          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}
            className="blog-prose">
            <Body />
          </motion.div>

          {/* Author bio card — pseudonymous byline; avatar uses the
              Nordavix mark so it reads as "from the team" rather than
              foregrounding any specific person. */}
          <div className="mt-12 rounded-2xl p-5 sm:p-6 flex items-start gap-4"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <div className="h-12 w-12 rounded-full shrink-0 flex items-center justify-center text-white"
              style={{ background: `linear-gradient(135deg, ${cat.gradient[0]}, ${cat.gradient[1]})` }}>
              <Sparkles size={20} strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-theme">{meta.author ?? "The Founder CPA"}</p>
              <p className="text-[12px] mt-0.5" style={{ color: "var(--text-2)" }}>
                Founder of Nordavix, the AI-native month-end close platform. CPA with
                deep experience in controllership, audit, and consolidation across
                multi-entity groups.
              </p>
            </div>
          </div>

          {/* Related posts */}
          {related.length > 0 && (
            <section className="mt-12">
              <h2 className="text-base font-bold text-theme mb-4">Keep reading</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {related.map((p) => {
                  const rcat = getCategoryMeta(p.meta.category)
                  const RIcon = rcat.icon
                  return (
                    <Link key={p.meta.slug} to={`/blog/${p.meta.slug}`}
                      className="rounded-xl p-4 group transition-all hover:-translate-y-0.5 hover:shadow-md"
                      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mb-2"
                        style={{ background: rcat.bg, color: rcat.color }}>
                        <RIcon size={9} strokeWidth={2} /> {rcat.label}
                      </span>
                      <p className="text-sm font-semibold text-theme leading-snug group-hover:opacity-80 transition-opacity">
                        {p.meta.title}
                      </p>
                    </Link>
                  )
                })}
              </div>
            </section>
          )}

          {/* Prev / next navigator */}
          {(prev || next) && (
            <nav className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {prev ? (
                <Link to={`/blog/${prev.meta.slug}`}
                  className="rounded-xl p-4 transition-all hover:-translate-y-0.5 hover:shadow-md group"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1"
                    style={{ color: "var(--text-muted)" }}>
                    ← Previous
                  </p>
                  <p className="text-sm font-semibold text-theme group-hover:opacity-80 transition-opacity">
                    {prev.meta.title}
                  </p>
                </Link>
              ) : <div />}
              {next ? (
                <Link to={`/blog/${next.meta.slug}`}
                  className="rounded-xl p-4 transition-all hover:-translate-y-0.5 hover:shadow-md group text-right"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1"
                    style={{ color: "var(--text-muted)" }}>
                    Next →
                  </p>
                  <p className="text-sm font-semibold text-theme group-hover:opacity-80 transition-opacity">
                    {next.meta.title}
                  </p>
                </Link>
              ) : <div />}
            </nav>
          )}

          {/* Bottom CTA */}
          <div className="mt-12 rounded-2xl p-6 sm:p-8 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
            <p className="text-base sm:text-lg font-bold text-theme">
              Stop closing the books in Excel.
            </p>
            <p className="text-sm mt-1 mb-5" style={{ color: "var(--text-2)" }}>
              Nordavix runs reconciliations, flux analysis, intercompany, and the financial
              package on top of your QuickBooks. Free during beta.
            </p>
            <Link to="/sign-up"
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-md text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ background: "var(--green)", boxShadow: "0 4px 12px rgba(62,143,102,0.20)" }}>
              Start free workspace <ArrowRight size={13} strokeWidth={2} />
            </Link>
          </div>
        </article>

        {/* ── Sticky side panel (desktop only) ─────────────────── */}
        <aside className="hidden lg:block">
          <div className="sticky top-24 space-y-4">
            <SharePanel post={meta} />
          </div>
        </aside>
      </div>
    </BlogLayout>
  )
}

// ── SharePanel ───────────────────────────────────────────────────
//
// LinkedIn / X share + copy-link button. Used in the sticky desktop
// sidebar. The copy button briefly turns green + shows a checkmark
// on success.

function SharePanel({ post }: { post: { slug: string; title: string } }) {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== "undefined"
    ? `${window.location.origin}/blog/${post.slug}`
    : `https://nordavix.com/blog/${post.slug}`

  const linkedInHref = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`
  const twitterHref  = `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(post.title)}`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API blocked — silently no-op. Users can copy the
      // URL from the address bar.
    }
  }

  return (
    <div className="rounded-xl p-4"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5"
        style={{ color: "var(--text-muted)" }}>
        <Share2 size={10} strokeWidth={2} /> Share
      </p>
      <div className="space-y-2">
        <a href={linkedInHref} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 w-full text-xs font-medium rounded-md px-3 py-2 transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-2)" }}>
          <Linkedin size={13} strokeWidth={1.8} /> LinkedIn
        </a>
        <a href={twitterHref} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 w-full text-xs font-medium rounded-md px-3 py-2 transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-2)" }}>
          <Twitter size={13} strokeWidth={1.8} /> X / Twitter
        </a>
        <button onClick={handleCopy}
          className="flex items-center gap-2 w-full text-xs font-medium rounded-md px-3 py-2 transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: copied ? "var(--green)" : "var(--text-2)" }}>
          <AnimatePresence mode="wait">
            {copied ? (
              <motion.span key="check" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} className="inline-flex items-center gap-2">
                <Check size={13} strokeWidth={2} /> Copied!
              </motion.span>
            ) : (
              <motion.span key="copy" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} className="inline-flex items-center gap-2">
                <LinkIcon size={13} strokeWidth={1.8} /> Copy link
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
    </div>
  )
}
