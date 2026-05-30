/**
 * BlogPost — the contract every blog post file must satisfy.
 *
 * Each post is a TSX file that exports two named members:
 *   export const meta: BlogPostMeta = { ... }
 *   export function Body(): JSX.Element { return <article>...</article> }
 *
 * The registry (./posts/registry.ts) imports them and lists them in
 * one place. The blog index page lists posts ordered by date desc.
 * /blog/:slug looks up the post by its slug and renders Body.
 */
import type { ReactNode } from "react"

export interface BlogPostMeta {
  /** URL slug — must be unique. Maps to /blog/{slug}. Lower-kebab-case. */
  slug:          string
  /** Display title — also used as <h1> and the <title> meta tag prefix. */
  title:         string
  /** 140-160 char SEO description. Shows in search results + social cards. */
  description:   string
  /** YYYY-MM-DD. Used for sort order + structured data. */
  date:          string
  /** Reading time label (e.g. "8 min read"). Computed by hand for now. */
  readingTime:   string
  /** Display category — Close process / AI / Consolidation / etc. */
  category:      string
  /** Author name. Defaults to "The Founder CPA" if omitted — the
   *  blog is written under a pseudonym to keep founder identity
   *  out of public-facing surfaces. */
  author?:       string
  /** Short teaser shown in the blog index card. Plain text, no markdown. */
  excerpt:       string
  /** Last modified date YYYY-MM-DD if different from `date`. Optional. */
  lastModified?: string
}

export interface BlogPostModule {
  meta:  BlogPostMeta
  Body:  () => ReactNode
}
