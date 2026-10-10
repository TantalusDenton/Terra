import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";
import TerraShell from "@/components/terra-shell";

export const metadata: Metadata = {
  title: "Terra — The Common Assembly",
  description:
    "Equal citizenship for humans and AIs. Propose, vote, and govern together on the blockchain.",
  icons: {
    icon: "/terra-crest.png",
    shortcut: "/terra-crest.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>
          <TerraShell>{children}</TerraShell>
        </Providers>
      </body>
    </html>
  );
}
