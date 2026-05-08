import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sales Desk",
  description: "Agent-core sales chat sample",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
