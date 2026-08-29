/**
 * The timezone list behind the continuous-close schedule picker.
 *
 * IANA names only. An offset ("UTC+5:30") is wrong twice a year everywhere that
 * observes daylight saving, and the whole point of the schedule is that 9am
 * stays 9am to the person reading the books.
 *
 * Curated, not exhaustive: the full IANA database is ~600 names, most of them
 * aliases or islands, and a 600-row select is a worse control than a text box.
 * These are the zones a firm actually keeps books in, grouped so the list can
 * be skimmed. Anything missing is still reachable — the browser's own zone is
 * always offered even when it isn't on this list, and the server accepts any
 * valid IANA name.
 */

export interface TzGroup {
  label: string
  zones: string[]
}

export const TZ_GROUPS: TzGroup[] = [
  {
    label: "United States & Canada",
    zones: [
      "America/New_York",
      "America/Detroit",
      "America/Chicago",
      "America/Denver",
      "America/Phoenix",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
      "America/Toronto",
      "America/Winnipeg",
      "America/Edmonton",
      "America/Vancouver",
      "America/Halifax",
      "America/St_Johns",
    ],
  },
  {
    label: "Latin America",
    zones: [
      "America/Mexico_City",
      "America/Monterrey",
      "America/Guatemala",
      "America/Panama",
      "America/Bogota",
      "America/Lima",
      "America/Santiago",
      "America/Buenos_Aires",
      "America/Sao_Paulo",
      "America/Montevideo",
      "America/Caracas",
      "America/Puerto_Rico",
    ],
  },
  {
    label: "Europe",
    zones: [
      "Europe/London",
      "Europe/Dublin",
      "Europe/Lisbon",
      "Europe/Madrid",
      "Europe/Paris",
      "Europe/Brussels",
      "Europe/Amsterdam",
      "Europe/Berlin",
      "Europe/Zurich",
      "Europe/Rome",
      "Europe/Vienna",
      "Europe/Prague",
      "Europe/Warsaw",
      "Europe/Stockholm",
      "Europe/Oslo",
      "Europe/Copenhagen",
      "Europe/Helsinki",
      "Europe/Athens",
      "Europe/Bucharest",
      "Europe/Kyiv",
      "Europe/Istanbul",
      "Europe/Moscow",
    ],
  },
  {
    label: "Middle East & Africa",
    zones: [
      "Asia/Jerusalem",
      "Asia/Dubai",
      "Asia/Riyadh",
      "Asia/Qatar",
      "Africa/Cairo",
      "Africa/Casablanca",
      "Africa/Lagos",
      "Africa/Accra",
      "Africa/Nairobi",
      "Africa/Johannesburg",
    ],
  },
  {
    label: "Asia",
    zones: [
      "Asia/Karachi",
      "Asia/Kolkata",
      "Asia/Colombo",
      "Asia/Kathmandu",
      "Asia/Dhaka",
      "Asia/Bangkok",
      "Asia/Jakarta",
      "Asia/Singapore",
      "Asia/Kuala_Lumpur",
      "Asia/Manila",
      "Asia/Hong_Kong",
      "Asia/Shanghai",
      "Asia/Taipei",
      "Asia/Seoul",
      "Asia/Tokyo",
    ],
  },
  {
    label: "Australia & Pacific",
    zones: [
      "Australia/Perth",
      "Australia/Adelaide",
      "Australia/Brisbane",
      "Australia/Sydney",
      "Australia/Melbourne",
      "Australia/Hobart",
      "Pacific/Auckland",
      "Pacific/Fiji",
    ],
  },
  { label: "Other", zones: ["UTC"] },
]

const ALL = new Set(TZ_GROUPS.flatMap((g) => g.zones))

/** Is this zone already offered by one of the groups? */
export function isListedZone(tz: string): boolean {
  return ALL.has(tz)
}

/** The browser's IANA zone, or UTC where it can't be resolved. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** "America/New_York" → "New York". The region prefix is already the group. */
export function zoneLabel(tz: string): string {
  const tail = tz.split("/").slice(1).join(" / ") || tz
  return tail.replace(/_/g, " ")
}

/** Wall-clock time right now in `tz`, e.g. "09:14" — or null if the zone is
 *  one this browser's ICU data doesn't carry. Answers the only question the
 *  picker really raises: is the hour I chose the hour I meant? */
export function timeInZone(tz: string, at: Date = new Date()): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(at)
  } catch {
    return null
  }
}
