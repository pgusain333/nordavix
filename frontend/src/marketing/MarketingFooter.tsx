/**
 * Shared marketing footer.
 *
 * Single source of truth used by HomePage, SolutionsPage, and
 * PublicHelpPage so the bottom of the public site stays consistent.
 *
 * Dark slate background, four-column grid (brand + Product + Company),
 * then a divider row with copyright, theme toggle, and tagline.
 * Anchor links use the absolute "/#section" form so they work
 * from any page (not just the homepage).
 */
import { Link } from "react-router-dom"
import { ThemeToggle } from "@/core/theme/ThemeToggle"
import { openCookiePreferences } from "@/core/consent/useCookieConsent"

export function MarketingFooter() {
  return (
    <footer className="bg-slate-900 py-12 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <img src="/logo-mark-dark.svg" alt="Nordavix" className="h-7 w-7" loading="lazy" />
              <span className="font-bold text-white">
                nordavix<span style={{ color: "var(--green)" }}>.</span>
              </span>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed max-w-xs">
              The AI-native close platform for controllers and CPA firms.
            </p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Product</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              <li><Link to="/solutions" className="hover:text-slate-300 transition-colors">Solutions</Link></li>
              <li><a href="/#features"  className="hover:text-slate-300 transition-colors">Features</a></li>
              <li><a href="/#pricing"   className="hover:text-slate-300 transition-colors">Pricing</a></li>
              <li><Link to="/blog"      className="hover:text-slate-300 transition-colors">Blog</Link></li>
              <li><a href="/#faq"       className="hover:text-slate-300 transition-colors">FAQ</a></li>
              <li><Link to="/help"      className="hover:text-slate-300 transition-colors">Help</Link></li>
              <li><Link to="/sign-up"   className="hover:text-slate-300 transition-colors">Get started</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Company</h4>
            <ul className="space-y-2 text-sm text-slate-500">
              <li><a href="mailto:hello@nordavix.com" className="hover:text-slate-300 transition-colors">About</a></li>
              <li><Link to="/privacy" className="hover:text-slate-300 transition-colors">Privacy Policy</Link></li>
              <li><Link to="/terms"   className="hover:text-slate-300 transition-colors">Terms of Service</Link></li>
              <li>
                <button onClick={openCookiePreferences}
                  className="hover:text-slate-300 transition-colors text-left">
                  Cookie preferences
                </button>
              </li>
              <li><a href="mailto:security@nordavix.com" className="hover:text-slate-300 transition-colors">Security</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-slate-800 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-slate-600">© {new Date().getFullYear()} Nordavix. All rights reserved.</p>
          <div className="dark"><ThemeToggle /></div>
          <p className="text-xs text-slate-700">Built for accountants, by accountants.</p>
        </div>
      </div>
    </footer>
  )
}
