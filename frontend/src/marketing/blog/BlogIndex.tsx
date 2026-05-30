/**
 * BlogIndex — /blog landing page.
 *
 * Lists all posts (newest first) as cards. Each card links to the
 * individual post page. SEO-wise, this is the &quot;hub&quot; page —
 * it lists the available content so Google can crawl and discover
 * individual posts.
 */
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowRight, Calendar, Clock } from "lucide-react"
import { POSTS } from "@/marketing/blog/posts/registry"
import { BlogLayout } from "@/marketing/blog/BlogLayout"
import { SEO, breadcrumbSchema } from "@/marketing/seo/SEO"

export function BlogIndex() {
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

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <p className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: "var(--green)" }}>
            The Nordavix blog
          </p>
          <h1 className="font-bold leading-tight text-theme"
            style={{ fontSize: "clamp(32px, 5vw, 48px)" }}>
            Working notes on the close.
          </h1>
          <p className="mt-3 text-base sm:text-lg" style={{ color: "var(--text-2)" }}>
            Guides, opinions, and deep-dives — written by CPAs for the people who actually
            do the close work.
          </p>
        </motion.div>

        <div className="mt-12 space-y-6">
          {POSTS.map((post, i) => (
            <motion.article
              key={post.meta.slug}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.05 + i * 0.04 }}
              className="rounded-2xl p-6 sm:p-7 transition-all hover:shadow-md"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "var(--card-shadow)",
              }}>
              <Link to={`/blog/${post.meta.slug}`} className="block group">
                <div className="flex items-center gap-3 text-[11px] mb-3"
                  style={{ color: "var(--text-muted)" }}>
                  <span className="font-semibold uppercase tracking-wider"
                    style={{ color: "var(--green)" }}>
                    {post.meta.category}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={11} strokeWidth={1.8} />
                    {new Date(post.meta.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} strokeWidth={1.8} /> {post.meta.readingTime}
                  </span>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-theme leading-tight mb-2 group-hover:opacity-80 transition-opacity">
                  {post.meta.title}
                </h2>
                <p className="text-sm sm:text-base leading-relaxed mb-4"
                  style={{ color: "var(--text-2)" }}>
                  {post.meta.excerpt}
                </p>
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold"
                  style={{ color: "var(--green)" }}>
                  Read post <ArrowRight size={13} strokeWidth={2} />
                </span>
              </Link>
            </motion.article>
          ))}
        </div>
      </div>
    </BlogLayout>
  )
}
