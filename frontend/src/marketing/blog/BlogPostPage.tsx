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
  Link as LinkIcon, Check, ChevronRight,
} from "lucide-react"
import { findPostBySlug, POSTS } from "@/marketing/blog/posts/registry"
import { getCategoryMeta } from "@/marketing/blog/categories"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, articleSchema, breadcrumbSchema, faqSchema } from "@/marketing/seo/SEO"
import "@/marketing/blog/blog-prose.css"

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
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
  // Article + breadcrumb always; FAQ schema only when the post declares
  // visible FAQ pairs (Google requires the on-page text to match).
  const jsonLd: object[] = [article, crumbs]
  if (meta.faq && meta.faq.length > 0) jsonLd.push(faqSchema(meta.faq))

  return (
    <BlogLayout>
      <SEO
        title={meta.title}
        description={meta.description}
        path={`/blog/${meta.slug}`}
        ogType="article"
        jsonLd={jsonLd}
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

      {/* ── Masthead — pine editorial header (Fraunces title, mono meta).
          The category contributes a muted accent, not a wall of color. */}
      <section className="relative overflow-hidden" style={{ background: "#0C2620" }}>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{
          backgroundImage: "linear-gradient(rgba(244,241,233,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(244,241,233,0.07) 1px, transparent 1px)",
          backgroundSize: "64px 64px", opacity: 0.5,
          maskImage: "radial-gradient(120% 85% at 50% 0%, black, transparent 82%)",
          WebkitMaskImage: "radial-gradient(120% 85% at 50% 0%, black, transparent 82%)",
        }} />
        {/* Huge category icon as quiet cover art */}
        <CatIcon size={280} strokeWidth={0.7}
          className="absolute -right-14 -top-10 hidden md:block pointer-events-none"
          style={{ color: "rgba(244,241,233,0.07)" }} />

        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          <nav className="text-[10px] mb-6 flex items-center gap-2 uppercase tracking-[0.16em]"
            style={{ fontFamily: '"JetBrains Mono", monospace', color: "rgba(244,241,233,0.55)" }}>
            <Link to="/" className="hover:text-white transition-colors">Home</Link>
            <ChevronRight size={10} strokeWidth={2} className="opacity-50" />
            <Link to="/blog" className="hover:text-white transition-colors">Blog</Link>
            <ChevronRight size={10} strokeWidth={2} className="opacity-50" />
            <span style={{ color: cat.gradient[1] }}>{cat.label}</span>
          </nav>

          <h1 className="max-w-3xl" style={{
            fontFamily: '"Fraunces", Georgia, serif', fontWeight: 550,
            lineHeight: 1.08, letterSpacing: "-0.012em",
            fontSize: "clamp(28px, 4.6vw, 46px)", color: "#F4F1E9",
          }}>
            {meta.title}
          </h1>

          <p className="mt-5 text-[15px] sm:text-[16.5px] max-w-2xl leading-relaxed"
            style={{ color: "rgba(244,241,233,0.72)" }}>
            {meta.description}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] uppercase tracking-[0.1em]"
            style={{ fontFamily: '"JetBrains Mono", monospace', color: "rgba(244,241,233,0.62)" }}>
            <span className="inline-flex items-center gap-1.5">
              <Calendar size={11} strokeWidth={1.8} /> {formatDate(meta.date)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={11} strokeWidth={1.8} /> {meta.readingTime}
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
            <div className="h-12 w-12 rounded-full shrink-0 flex items-center justify-center"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
              <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-7 w-7 dark:hidden" loading="lazy" />
              <img src="/logo-mark-light.svg" alt="Nordavix" className="h-7 w-7 hidden dark:block" loading="lazy" />
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

          {/* Bottom CTA — pine band, matching the marketing system */}
          <div className="mt-12 rounded-2xl p-7 sm:p-10 text-center relative overflow-hidden"
            style={{ background: "#0C2620" }}>
            <div aria-hidden className="pointer-events-none absolute inset-0" style={{
              backgroundImage: "linear-gradient(rgba(244,241,233,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(244,241,233,0.06) 1px, transparent 1px)",
              backgroundSize: "56px 56px", opacity: 0.6,
            }} />
            <div className="relative">
              <p style={{
                fontFamily: '"Fraunces", Georgia, serif', fontWeight: 550,
                fontSize: "clamp(1.25rem, 2.6vw, 1.7rem)", lineHeight: 1.18, color: "#F4F1E9",
              }}>
                Stop closing the books <em style={{ fontStyle: "italic", color: "#9CC4AD" }}>in Excel</em>.
              </p>
              <p className="text-[13px] mt-2 mb-6" style={{ color: "rgba(244,241,233,0.68)" }}>
                Nordavix runs reconciliations, flux analysis, schedules, and the financial
                package on top of your QuickBooks. Free during beta.
              </p>
              <Link to="/sign-up"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-bold transition-transform hover:-translate-y-0.5"
                style={{ background: "#F4F1E9", color: "#0C2620" }}>
                Start free workspace <ArrowRight size={14} strokeWidth={2.4} />
              </Link>
            </div>
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
