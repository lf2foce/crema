import { SourceGate } from "@/components/screens";

// The pages that look inside one database (its metrics, schema, tables, SQL): it must exist and be ready.
export default function SourceLayout({ children }: { children: React.ReactNode }) {
  return <SourceGate>{children}</SourceGate>;
}
