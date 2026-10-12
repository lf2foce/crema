import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Creama",
  description: "Connect Postgres. AI proposes your business metrics with evidence. A person certifies what’s true.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {["newsreader", "geist", "jetbrains-mono"].map((f) => (
          <link key={f} rel="preload" href={`/fonts/${f}-latin.woff2`} as="font" type="font/woff2" crossOrigin="anonymous" />
        ))}
      </head>
      <body>{children}</body>
    </html>
  );
}
