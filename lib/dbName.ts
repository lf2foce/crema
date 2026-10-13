// Names of hosted databases: one set of rules for the form (as people type) and the server (which
// decides). A new database gets a natural random name, Neon-style (young_art_a7k2): readable, unlikely
// to collide, and saying nothing about the project. People can pick another or type their own before
// creating it. It never changes afterwards; the display name ("ComicAI") is separate and can.
// Roles are `<db>_owner` and `<db>_crema`, so a name stays well under Postgres's 63-character limit.

export const DB_NAME_MAX = 38;
const RESERVED = new Set(["postgres", "template0", "template1", "crema", "public", "information_schema"]);

// short, plain, nature-ish words: names read well in a connection string and in a log
const words = (s: string) => [...new Set(s.split(/\s+/).filter(Boolean))];
const ADJECTIVES = words(`young quiet bold calm misty silent wispy lucky gentle bright still rapid round broad
  cool crisp deep fresh frosty green icy jolly little lively lone noisy polished proud purple red shiny
  small snowy spring summer sweet tiny twilight wandering white wild winter yellow ancient autumn blue
  cold cosmic curly damp golden hidden long patient plain royal steep sunny velvet amber silver`);
const NOUNS = words(`art river star moon sun cloud field forest glade hill lake leaf meadow mountain night ocean
  paper pine pond rain sea shadow sky smoke snow sound breeze brook bird cherry dew dream feather fire
  firefly flower fog frog frost grass haze heart morning poetry scene shape silence snowflake sunset surf
  thunder tree violet voice water wave wind wood butterfly cake island harbor canyon comet ember fern`);
const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomInts(n: number): number[] {
  const a = new Uint32Array(n);
  globalThis.crypto.getRandomValues(a); // browsers and Node alike
  return [...a];
}

/** A natural random name: young_art_a7k2. */
export function naturalDbName(): string {
  const [i, j, ...rest] = randomInts(6);
  const suffix = rest.map((r) => ALPHANUM[r % ALPHANUM.length]).join("");
  return `${ADJECTIVES[i % ADJECTIVES.length]}_${NOUNS[j % NOUNS.length]}_${suffix}`;
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
