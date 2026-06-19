/**
 * Tiny, theme-aware Markdown renderer for assistant answers.
 *
 * Deliberately small (no dependency) and scoped to what the assistant produces:
 * **bold**, `code`, *italics*, #/##/### headings, bullet + numbered lists, and
 * GitHub-style pipe tables. Everything is styled with the app's CSS variables so
 * tables and lists look native in light + dark — instead of raw "| --- |" text.
 */
import { Fragment, type ReactNode } from "react"

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("**")) {
      out.push(
        <strong key={`${keyBase}b${k++}`} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={`${keyBase}c${k++}`}
          className="rounded px-1 py-0.5 text-[0.85em]"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          {tok.slice(1, -1)}
        </code>,
      )
    } else {
      out.push(<em key={`${keyBase}i${k++}`}>{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function splitRow(row: string): string[] {
  let s = row.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|")) s = s.slice(0, -1)
  return s.split("|").map((c) => c.trim())
}

const isSep = (s: string) => /^[\s|:-]+$/.test(s) && s.includes("-") && s.includes("|")

export function Markdown({ text }: { text: string }) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n")
  const blocks: ReactNode[] = []
  let i = 0
  let bk = 0

  const tableAhead = (idx: number) =>
    lines[idx].includes("|") && idx + 1 < lines.length && isSep(lines[idx + 1])

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }

    // ── Pipe table ──
    if (tableAhead(i)) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <div
          key={`t${bk++}`}
          className="my-2 overflow-x-auto rounded-lg"
          style={{ border: "1px solid var(--border)" }}
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr style={{ background: "var(--surface-2)" }}>
                {header.map((h, hi) => (
                  <th
                    key={hi}
                    className="px-3 py-1.5 text-left font-semibold"
                    style={{ color: "var(--text)", borderBottom: "1px solid var(--border)" }}
                  >
                    {renderInline(h, `th${bk}_${hi}_`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td
                      key={ci}
                      className="px-3 py-1.5 align-top"
                      style={{
                        color: "var(--text)",
                        borderTop: ri ? "1px solid var(--border)" : undefined,
                      }}
                    >
                      {renderInline(r[ci] ?? "", `td${bk}_${ri}_${ci}_`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // ── Heading ──
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const lvl = h[1].length
      blocks.push(
        <p
          key={`h${bk++}`}
          className="mt-2 mb-0.5 font-semibold"
          style={{ color: "var(--text)", fontSize: lvl <= 2 ? "1.05em" : "1em" }}
        >
          {renderInline(h[2], `h${bk}_`)}
        </p>,
      )
      i++
      continue
    }

    // ── Unordered list ──
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""))
        i++
      }
      blocks.push(
        <ul key={`u${bk++}`} className="my-1.5 ml-1 space-y-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2">
              <span aria-hidden style={{ color: "var(--green)" }}>
                •
              </span>
              <span className="flex-1">{renderInline(it, `u${bk}_${ii}_`)}</span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    // ── Ordered list ──
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""))
        i++
      }
      blocks.push(
        <ol key={`o${bk++}`} className="my-1.5 ml-1 space-y-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2">
              <span className="tabular-nums font-semibold" style={{ color: "var(--green)" }}>
                {ii + 1}.
              </span>
              <span className="flex-1">{renderInline(it, `o${bk}_${ii}_`)}</span>
            </li>
          ))}
        </ol>,
      )
      continue
    }

    // ── Paragraph (consecutive plain lines; single breaks preserved) ──
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !tableAhead(i)
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p${bk++}`} className="leading-relaxed" style={{ whiteSpace: "pre-wrap" }}>
        {para.map((ln, li) => (
          <Fragment key={li}>
            {li > 0 && "\n"}
            {renderInline(ln, `p${bk}_${li}_`)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return <div className="space-y-1.5">{blocks}</div>
}
