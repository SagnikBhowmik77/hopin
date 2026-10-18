/**
 * Page scaffolding shared by every non-map screen: one width, one heading scale, one rhythm.
 * `width`: 'narrow' (forms, profile), 'default' (lists), 'wide' (admin tables).
 */
const WIDTH = { narrow: 'max-w-2xl', default: 'max-w-3xl', wide: 'max-w-7xl' };

/**
 * `aside`: a side panel beside the content on wide screens (sticky), below it on phones.
 * With an aside the page widens so large monitors aren't left with empty margins.
 */
export function Page({ title, description, action, eyebrow, width = 'default', aside, className = '', children }) {
  if (aside) {
    return (
      <div className={`mx-auto w-full max-w-7xl px-4 pb-10 pt-5 sm:px-6 sm:pt-8 ${className}`}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-8">
          <Page title={title} description={description} action={action} eyebrow={eyebrow} width="wide" className="!p-0">
            {children}
          </Page>
          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">{aside}</aside>
        </div>
      </div>
    );
  }
  return (
    <div className={`mx-auto w-full ${WIDTH[width]} px-4 pb-10 pt-5 sm:px-6 sm:pt-8 ${className}`}>
      {title && (
        <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            {eyebrow && <p className="mb-1 text-caption font-semibold uppercase tracking-[0.08em] text-fg-2">{eyebrow}</p>}
            <h1 className="font-display text-title font-bold sm:text-[2rem] sm:leading-tight">{title}</h1>
            {description && <p className="mt-1 max-w-prose text-small text-fg-2">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
        </header>
      )}
      <div className="space-y-5">{children}</div>
    </div>
  );
}

/** A titled block on a page. Flat surface with a hairline, no shadow. */
export function Section({ title, description, action, icon: Icon, className = '', bodyClassName = 'space-y-3', id, children }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {Icon && <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-2" />}
            <div className="min-w-0">
              {title && (
                <h2 id={id ? `${id}-title` : undefined} className="font-display text-heading font-bold">
                  {title}
                </h2>
              )}
              {description && <p className="text-small text-fg-2">{description}</p>}
            </div>
          </div>
          {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Label/value rows (receipts, settings summaries). */
export function KeyValue({ rows, className = '' }) {
  return (
    <dl className={`divide-y divide-line text-small ${className}`}>
      {rows.filter(Boolean).map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-fg-2">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A big number with a label, for dashboards. */
export function Stat({ label, value, hint, tone = 'neutral' }) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg';
  return (
    <div className="rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line">
      <p className="text-caption font-semibold text-fg-2">{label}</p>
      <p className={`mt-1 font-display text-title font-bold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-caption text-fg-2">{hint}</p>}
    </div>
  );
}

/** Rows of skeletons shaped like a list, inside a status region. */
export function ListSkeleton({ rows = 3, label = 'Loading' }) {
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3" aria-hidden>
          <span className="ds-skeleton size-10 shrink-0 rounded-[var(--radius-sm)]" />
          <span className="flex-1 space-y-2">
            <span className="ds-skeleton block h-3.5 w-1/2" />
            <span className="ds-skeleton block h-3 w-3/4" />
          </span>
        </div>
      ))}
    </div>
  );
}
