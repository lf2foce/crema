// Names of hosted databases: one set of rules for the form (as people type) and the server (which
// decides). People give a display name; the database name is suggested from it and can be edited
// before creation, Neon-style, with no forced prefix. It never changes afterwards; the display name can.
// Roles are `<db>_owner` and `<db>_crema`, so a name stays well under Postgres's 63-character limit.

export const DB_NAME_MAX = 38;
const RESERVED = new Set(["postgres", "template0", "template1", "crema", "public", "information_schema"]);

/** "ComicAI" → "comicai", "Đặt lịch 2026" → "dat_lich_2026", "99 problems" → "db_99_problems". */
export function suggestDbName(display: string): string {
  let s = display.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = `db_${s}`;
  s = s.slice(0, DB_NAME_MAX).replace(/_+$/, "");
  return dbNameProblem(s) ? "" : s;
}

/** Why this can't be a database name, or null when it can. */
export function dbNameProblem(name: string): string | null {
  if (!name) return "Give the database a name.";
  if (name.length > DB_NAME_MAX) return `At most ${DB_NAME_MAX} characters.`;
  if (!/^[a-z]/.test(name)) return "Start with a letter.";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return "Use lowercase letters, digits and underscores.";
  if (name.length < 2) return "At least 2 characters.";
  if (RESERVED.has(name) || name.startsWith("pg_") || name.startsWith("crema_")) return `“${name}” is reserved.`;
  return null;
}
