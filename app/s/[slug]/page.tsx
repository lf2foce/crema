import { App } from "@/components/App";

// One database: its metrics, proposals, schema, tables and SQL editor.
export default async function SourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <App sourceSlug={decodeURIComponent(slug)} />;
}
