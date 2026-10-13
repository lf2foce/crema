import { AppShell } from "@/components/AppShell";

// Everything behind sign-in: the status bar, and the workspace and database the URL names.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
