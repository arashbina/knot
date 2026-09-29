// How both UIs show times: local, `YYYY-MM-DD HH:mm`.

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Update stamps are written in UTC (`YYYY-MM-DD HH:mm`); show them in local time like `updated`.
 * A note typed without a heading has no stamp at all.
 */
export function formatStamp(at: string): string {
  if (!at) return 'undated'
  return /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(at) ? formatDate(`${at.replace(' ', 'T')}:00Z`) : at
}
