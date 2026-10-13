// Deploys run a migration while the previous version is still serving (and, during a rollout, next to
// the new one). So a migration must leave the schema usable by the version before it: add, don't take
// away (expand). Removing or renaming what an earlier version used is a separate, later migration
// (contract), shipped once no running version needs it, and says so with a `-- contract: <why>` line.

/** Statements the previous version may not survive, as short descriptions. Comments are ignored. */
export function breakingChanges(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
  const found: string[] = [];
  const rules: [RegExp, string][] = [
    [/\bDROP\s+(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TYPE|SCHEMA)\b/i, "drops a $1"],
    [/\bDROP\s+COLUMN\b/i, "drops a column"],
    [/\bRENAME\b/i, "renames something"],
    [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "changes a column's type"],
    [/\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, "makes a column NOT NULL"],
  ];
  for (const [re, what] of rules) {
    const m = code.match(re);
    if (m) found.push(what.replace("$1", (m[1] ?? "").toLowerCase()));
  }
  // a new NOT NULL column without a default: the previous version's INSERTs don't set it
  for (const m of code.matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+([^,;]*)/gi)) {
    const def = m[2];
    if (/\bNOT\s+NULL\b/i.test(def) && !/\b(DEFAULT|GENERATED)\b/i.test(def)) found.push(`adds NOT NULL column ${m[1]} without a default`);
  }
  return found;
}

/** The reason a migration gives for contracting, or null when it doesn't. */
export const contractReason = (sql: string) => sql.match(/--\s*contract:\s*(.+)/i)?.[1].trim() || null;
