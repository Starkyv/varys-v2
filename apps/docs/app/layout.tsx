import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { appName } from '@/lib/shared';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  // TODO: set to the deployed docs origin in production (drives absolute OG URLs).
  metadataBase: new URL('http://localhost:3000'),
  title: {
    template: `%s · ${appName} Docs`,
    default: `${appName} — Visual regression testing, authored by AI`,
  },
  description:
    'Documentation for Varys: record, schedule, and review visual-regression tests — including Claude-authored tests via MCP.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
