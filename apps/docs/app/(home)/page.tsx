import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 text-center">
      <span className="mb-4 rounded-full border px-3 py-1 text-sm text-fd-muted-foreground">
        Visual regression testing
      </span>
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
        Catch UI regressions before your users do.
      </h1>
      <p className="mt-4 max-w-xl text-fd-muted-foreground">
        Varys records, schedules, and reviews visual-regression tests — including tests
        authored by Claude over MCP. This is the documentation.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
        >
          Read the docs
        </Link>
        <Link href="/docs/getting-started" className="rounded-lg border px-5 py-2.5 font-medium">
          Getting started
        </Link>
      </div>
    </main>
  );
}
