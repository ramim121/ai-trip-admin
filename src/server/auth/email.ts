/**
 * Canonical form for email addresses.
 *
 * schema.prisma requires it: `users.email` and `admin_users.email` are plain
 * Postgres unique indexes, which compare byte-for-byte. Without one agreed
 * normal form, `Ada@Example.com` and `ada@example.com` would register as two
 * separate accounts, and whether a login succeeded would depend on how the
 * address happened to be typed. Every read and every write of an email column
 * goes through here.
 *
 * `toLowerCase()` rather than `toLocaleLowerCase()` on purpose: the locale-aware
 * variant maps `I` to a dotless `ı` under a Turkish locale, so the same address
 * would normalise differently depending on the server's locale.
 *
 * Only case and surrounding whitespace are touched. Dots and `+tags` in the
 * local part are deliberately left alone: collapsing them is a Gmail
 * convention, not a rule of SMTP, and applying it everywhere would silently
 * merge addresses belonging to different people on most other hosts.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
