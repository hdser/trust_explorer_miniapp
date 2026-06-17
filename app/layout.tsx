import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { WalletProvider } from "@/components/wallet/WalletProvider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Trust Explorer",
  description: "Explore the Circles trust network — send & convert tokens, replay flows, color by group.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-background">
        {/* Proven cosmos.gl build (window.cosmosgl) shared with the graph_analyzer web_viewer. */}
        <Script src="/cosmos-gl-browser.min.js" strategy="beforeInteractive" />
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
