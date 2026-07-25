import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ProcureOS — The Agentic Purchasing Department",
    template: "%s · ProcureOS",
  },
  description:
    "Agentic purchasing that sources, verifies, prices, and enforces spend authority before an order is ready.",
  metadataBase: new URL("https://procure-os-demo.sites.openai.com"),
  openGraph: {
    title: "ProcureOS — From request to ready",
    description:
      "An agentic purchasing department with evidence and enforced authority at every step.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ProcureOS demo" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ProcureOS — From request to ready",
    description:
      "An agentic purchasing department with evidence and enforced authority at every step.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
