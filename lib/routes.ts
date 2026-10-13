// The app's URLs, in one place. A database is addressed by its slug (comic, comic_development).
//   /projects                       the projects, and where new ones are made
//   /projects/<slug>                one database's connection details (its project's branches)
//   /projects/<slug>/metrics        its proposals and certified metrics
//   /projects/<slug>/metrics/<key>  one metric        /proposals/<id>  one proposal
//   /projects/<slug>/business|new|schema|tables[/<table>]|sql
//   /connect  /people  /servers/<id>
const enc = encodeURIComponent;
const db = (slug: string) => `/projects/${enc(slug)}`;

export const routes = {
  root: "/",
  projects: "/projects",
  connect: "/connect",
  people: "/people",
  server: (id: number) => `/servers/${id}`,
  project: db,
  metrics: (slug: string) => `${db(slug)}/metrics`,
  metric: (slug: string, key: string) => `${db(slug)}/metrics/${enc(key)}`,
  proposal: (slug: string, id: number) => `${db(slug)}/proposals/${id}`,
  business: (slug: string) => `${db(slug)}/business`,
  newMetric: (slug: string) => `${db(slug)}/new`,
  schema: (slug: string) => `${db(slug)}/schema`,
  tables: (slug: string, table?: string | null) => `${db(slug)}/tables${table ? `/${enc(table)}` : ""}`,
  sql: (slug: string) => `${db(slug)}/sql`,
} as const;

/** The first segment after /projects/<slug>/ for the current path: which page of a database we're on. */
export function sectionOf(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/[^/]+\/([^/]+)/);
  return m ? m[1] : null;
}

/** The same page in another database of the project (the branch switcher keeps you where you are). */
export function sameSectionIn(pathname: string, slug: string): string {
  const rest = pathname.match(/^\/projects\/[^/]+(\/.*)?$/)?.[1] ?? "";
  // a table, proposal or metric belongs to its database: land on the section's top
  const top = rest.match(/^\/(tables|metrics|proposals)\//) ? rest.split("/").slice(0, 2).join("/") : rest;
  return `${db(slug)}${top === "/proposals" ? "/metrics" : top}`;
}
