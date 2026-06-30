import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Topstep Guardrail",
  description: "Live Topstep Combine risk monitor and trading playbook.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
