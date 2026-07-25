import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const imageUrl = `${origin}/og.png`;

  return {
    title: {
      default: "ProcureOS — The Agentic Purchasing Department",
      template: "%s · ProcureOS",
    },
    description:
      "Agentic purchasing that sources, verifies, prices, and enforces spend authority before an order is ready.",
    metadataBase: new URL(origin),
    openGraph: {
      title: "ProcureOS — From request to ready",
      description:
        "An agentic purchasing department with evidence and enforced authority at every step.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "ProcureOS demo" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ProcureOS — From request to ready",
      description:
        "An agentic purchasing department with evidence and enforced authority at every step.",
      images: [imageUrl],
    },
  };
}

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
