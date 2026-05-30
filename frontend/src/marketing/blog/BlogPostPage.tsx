/**
 * BlogPostPage — /blog/:slug
 *
 * Looks up the post in the registry by slug and renders it. If the slug
 * doesn't match, redirects back to /blog (rather than throwing or
 * showing a 404 — the index is the natural next step). Each post
 * gets full SEO including Article + BreadcrumbList JSON-LD schemas.
 */
import { useEffect } from "react"
import { Link, useParams, Navigate } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowLeft, Calendar, Clock } from "lucide-react"
import { findPostBySlug } from "@/marketing/blog/posts/registry"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, articleSchema, breadcrumbSchema } from "@/marketing/seo/SEO"
import "@/marketing/blog/blog-prose.css"

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>()
  const post = slug ? findPostBySlug(slug) : undefined

  // Scroll to top on slug change so the next post starts at the title,
  // not where the previous post ended.
  useEffect(() => {
    if (post) window.scrollTo({ top: 0 })
  }, [post])

  if (!post) {
    return <Navigate to="/blog" replace />
  }
  const { meta, Body } = post
  const displayDate = new Date(meta.date).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  })

  const article = articleSchema({
    title:        meta.title,
    description:  meta.description,
    slug:         meta.slug,
    datePublished: meta.date,
    dateModified:  meta.lastModified,
    author:       meta.author,
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

      <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <Link to="/blog"
          className="inline-flex items-center gap-1 text-xs font-medium mb-6 transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}>
          <ArrowLeft size={12} strokeWidth={2} /> All posts
        </Link>

        <motion.header
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: "var(--green)" }}>
            {meta.category}
          </p>
          <h1 className="font-bold leading-tight text-theme"
            style={{ fontSize: "clamp(28px, 4.5vw, 42px)" }}>
            {meta.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-[12px]"
            style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1">
              <Calendar size={12} strokeWidth={1.8} /> {displayDate}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock size={12} strokeWidth={1.8} /> {meta.readingTime}
            </span>
            <span>By {meta.author ?? "Pankaj Gusain, CPA"}</span>
          </div>
        </motion.header>

        <hr className="my-8" style={{ borderColor: "var(--border)" }} />

        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.05 }}
          className="blog-prose"
          style={{ color: "var(--text)" }}>
          <Body />
        </motion.div>

        <hr className="my-10" style={{ borderColor: "var(--border)" }} />

        <div className="rounded-xl p-6 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }}>
          <p className="text-base font-semibold text-theme">
            Stop closing the books in Excel.
          </p>
          <p className="text-sm mt-1 mb-4" style={{ color: "var(--text-2)" }}>
            Nordavix runs reconciliations, flux analysis, intercompany, and the financial
            package on top of your QuickBooks. Free during beta.
          </p>
          <Link to="/sign-up"
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-md text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ background: "var(--green)" }}>
            Start free workspace
          </Link>
        </div>
      </article>
    </BlogLayout>
  )
}
