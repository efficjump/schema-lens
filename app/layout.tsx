import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function safeOrigin(host: string | null, protocol: string | null): URL {
  const localHost = host ? /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host) : false;
  const safeProtocol = protocol === "http" || (!protocol && localHost) ? "http" : "https";
  if (host && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) {
    try {
      return new URL(`${safeProtocol}://${host}`);
    } catch {
      // Fall through to the non-routable metadata fallback.
    }
  }
  return new URL("https://schemalens.local");
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const origin = safeOrigin(
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    requestHeaders.get("x-forwarded-proto"),
  );
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: origin,
    title: {
      default: "Schema Lens",
      template: "%s · Schema Lens",
    },
    description:
      "코드와 쿼리의 실제 근거를 따라 DB 구조, 소스 흐름, 원문 코드를 함께 탐색합니다.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      title: "Schema Lens",
      description: "소스와 SQL에서 DB ERD·소스 관계·원문 근거를 복원합니다.",
      images: [{ url: socialImage, width: 1731, height: 909, alt: "Schema Lens source-grounded ERD" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Schema Lens",
      description: "소스와 SQL에서 DB ERD·소스 관계·원문 근거를 복원합니다.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
