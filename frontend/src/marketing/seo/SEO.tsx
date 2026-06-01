/**
 * SEO — per-route meta tag manager for the marketing site.
 *
 * Wraps react-helmet-async with sensible defaults for Nordavix. Every
 * public marketing page renders one <SEO ... /> at the top so search
 * engines see a unique title, description, canonical, and social-share
 * preview per route — not the static defaults from index.html.
 *
 * What it sets:
 *   - <title> (with " | Nordavix" suffix unless `bareTitle` is true)
 *   - <meta name="description">
 *   - <link rel="canonical">             ← per-route, the right fix
 *   - <meta name="robots">                ← optional noindex,nofollow
 *   - Full Open Graph set (og:title/description/url/image/type)
 *   - Full Twitter Card set
 *   - Optional <script type="application/ld+json"> structured data
 *
 * Usage:
 *   <SEO
 *     title="Solutions — every step of the close on one platform"
 *     description="Reconciliations, flux analysis, schedules, intercompany..."
 *     path="/solutions"
 *   />
 *
 * For pages we don't want indexed (Terms, Privacy):
 *   <SEO title="..." description="..." path="/terms" noindex />
 *
 * For blog posts (Article schema):
 *   <SEO
 *     title="..." description="..." path={`/blog/${slug}`}
 *     ogType="article"
 *     jsonLd={articleSchema}
 *   />
 */
import { Helmet } from "react-helmet-async"

const SITE = "https://nordavix.com"
const DEFAULT_OG_IMAGE = `${SITE}/og-image.png`
const SITE_NAME = "Nordavix"

interface SEOProps {
  /** The bare page title — we append " | Nordavix" unless bareTitle=true. */
  title:        string
  /** 140–160 characters describing the page. Shows in Google results. */
  description:  string
  /** Path without origin, e.g. "/solutions" or "/blog/month-end-checklist". */
  path:         string
  /** Override the default 1200×630 OG image (e.g. per blog post). */
  ogImage?:     string
  /** "website" (default) or "article" for blog posts. */
  ogType?:      "website" | "article"
  /** Don't add " | Nordavix" suffix — used for the homepage where the
   *  brand is already in the title. */
  bareTitle?:   boolean
  /** Tell search engines NOT to index this page. Used on Terms, Privacy
   *  and other legal pages we don't want competing for ranking. */
  noindex?:     boolean
  /** Inject one or more JSON-LD structured-data blocks. Each entry is a
   *  plain object; we stringify it and emit a <script type="application/ld+json">. */
  jsonLd?:      object | object[]
  /** Optional language override (defaults to en). */
  lang?:        string
}

export function SEO({
  title,
  description,
  path,
  ogImage = DEFAULT_OG_IMAGE,
  ogType = "website",
  bareTitle = false,
  noindex = false,
  jsonLd,
  lang = "en",
}: SEOProps) {
  // Normalize path: ensure leading slash, no trailing slash unless root
  const cleanPath = path.startsWith("/") ? path : `/${path}`
  const canonical = cleanPath === "/" ? `${SITE}/` : `${SITE}${cleanPath.replace(/\/$/, "")}`
  const fullTitle = bareTitle ? title : `${title} | ${SITE_NAME}`

  const jsonLdArray = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []

  return (
    <Helmet htmlAttributes={{ lang }}>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />

      {/* Crawler directives. Default is "index,follow" implicitly; we
          only emit the meta when noindex is set so we don't shadow it. */}
      {noindex && <meta name="robots" content="noindex,nofollow" />}

      {/* Open Graph — overrides index.html defaults for this route */}
      <meta property="og:type" content={ogType} />
      <meta property="og:url" content={canonical} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:locale" content="en_US" />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={fullTitle} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
      <meta name="twitter:image:alt" content={fullTitle} />

      {/* JSON-LD structured data blocks. Each becomes its own <script>
          tag so Google can pick out individual schemas independently. */}
      {jsonLdArray.map((obj, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(obj)}
        </script>
      ))}
    </Helmet>
  )
}

// ── Reusable schema builders ────────────────────────────────────────────
//
// Google validates these via the Rich Results Test:
//   https://search.google.com/test/rich-results

export const ORGANIZATION_SCHEMA = {
  "@context": "https://schema.org",
  "@type":    "Organization",
  name:       SITE_NAME,
  url:        SITE,
  logo:       `${SITE}/logo-mark-dark.svg`,
  description:
    "AI-native month-end close platform for CPA firms and corporate controllers. " +
    "AI-prepared reconciliations, flux analysis, intercompany consolidation, " +
    "schedules, and the executive financial package.",
  sameAs: [
    "https://www.linkedin.com/company/nordavix/",
  ],
}

export const SOFTWARE_APP_SCHEMA = {
  "@context":         "https://schema.org",
  "@type":            "SoftwareApplication",
  name:               SITE_NAME,
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Accounting Software",
  operatingSystem:    "Web",
  url:                SITE,
  description:
    "AI-prepared month-end close software: reconciliations, flux analysis, " +
    "intercompany consolidation, schedules, and the executive financial package. " +
    "Connects to QuickBooks Online. Built by CPAs for CPAs.",
  offers: {
    "@type":         "Offer",
    price:           "0",
    priceCurrency:   "USD",
    description:     "Free during beta",
  },
  // NOTE: no aggregateRating here on purpose. Emitting a fabricated rating
  // (we have no real, verifiable user reviews yet during beta) violates
  // Google's structured-data guidelines and can trigger a manual action that
  // suppresses ALL rich results for the domain. Re-add a real AggregateRating
  // only once it reflects genuine, on-page reviews.
}

/**
 * Build a BreadcrumbList schema for a page. Pass an ordered list of
 * { name, path } pairs starting with the root.
 *
 * Example:
 *   breadcrumbSchema([
 *     { name: "Home",  path: "/" },
 *     { name: "Blog",  path: "/blog" },
 *     { name: "Month-end close checklist", path: "/blog/month-end-close-checklist" },
 *   ])
 */
export function breadcrumbSchema(crumbs: { name: string; path: string }[]) {
  return {
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    itemListElement:   crumbs.map((c, i) => ({
      "@type":   "ListItem",
      position:  i + 1,
      name:      c.name,
      item:      c.path.startsWith("http") ? c.path : `${SITE}${c.path}`,
    })),
  }
}

/**
 * Build a FAQPage schema from an array of Q&A pairs. Drop this on any
 * page that has a visible FAQ accordion; Google may surface the answers
 * directly in search results.
 */
export function faqSchema(qa: { question: string; answer: string }[]) {
  return {
    "@context":   "https://schema.org",
    "@type":      "FAQPage",
    mainEntity:   qa.map((item) => ({
      "@type": "Question",
      name:    item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text:    item.answer,
      },
    })),
  }
}

/**
 * Build an Article schema for a blog post.
 */
export function articleSchema(args: {
  title:        string
  description:  string
  slug:         string
  datePublished: string
  dateModified?: string
  author?:      string
  image?:       string
}) {
  const url = `${SITE}/blog/${args.slug}`
  return {
    "@context":     "https://schema.org",
    "@type":        "Article",
    headline:       args.title,
    description:    args.description,
    image:          args.image || DEFAULT_OG_IMAGE,
    datePublished:  args.datePublished,
    dateModified:   args.dateModified || args.datePublished,
    author: {
      "@type": "Person",
      name:    args.author || "The Founder CPA",
    },
    publisher: {
      "@type": "Organization",
      name:    SITE_NAME,
      logo: {
        "@type": "ImageObject",
        url:     `${SITE}/logo-mark-dark.svg`,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id":   url,
    },
    url,
  }
}
