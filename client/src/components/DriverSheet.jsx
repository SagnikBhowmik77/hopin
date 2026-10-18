import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { api } from '../api.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { ListSkeleton } from '../ds/index.js';
import { when } from '../util.js';
import { Avatar, ErrorNote, Modal } from './ui.jsx';

function StarRow({ value }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden className={`size-3.5 ${n <= value ? 'fill-[var(--accent)] text-[var(--accent-press)]' : 'text-line-strong'}`} />
      ))}
    </span>
  );
}

/** Driver profile: overall rating, most-mentioned tags and recent reviews. */
export default function DriverSheet({ driverId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!driverId) return;
    setData(null);
    api(`/profile/drivers/${driverId}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [driverId]);

  const d = data?.driver;
  const VIcon = VEHICLE_ICON[d?.vehicle?.type] ?? VEHICLE_ICON.car;
  return (
    <Modal open={Boolean(driverId)} onClose={onClose} title="Driver profile">
      <ErrorNote>{error}</ErrorNote>
      {!data && !error && <ListSkeleton rows={3} label="Loading driver profile" />}
      {d && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar src={d.avatar} name={d.name} size={64} />
            <div className="min-w-0">
              <p className="font-display text-title font-bold">{d.name}</p>
              <p className="flex items-center gap-1.5 text-small text-fg-2">
                <VIcon aria-hidden className="size-4" /> {d.vehicle?.model} · {d.vehicle?.plate}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              [Number(d.rating ?? 5).toFixed(1), `${d.ratingCount} ratings`],
              [d.trips, 'trips'],
              [new Date(d.since).getFullYear(), 'driving since'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-[var(--radius-md)] bg-raised py-3">
                <p className="font-display text-heading font-bold tabular-nums">{v}</p>
                <p className="text-caption text-fg-2">{l}</p>
              </div>
            ))}
          </div>
          {data.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.tags.map(([tag, n]) => (
                <span key={tag} className="ds-badge">
                  {tag} <span className="text-fg-2">×{n}</span>
                </span>
              ))}
            </div>
          )}
          <div>
            <p className="mb-2 font-semibold">Recent reviews</p>
            {data.reviews.length === 0 && <p className="text-small text-fg-2">No reviews yet.</p>}
            <ul className="divide-y divide-line">
              {data.reviews.map((r, i) => (
                <li key={i} className="py-3">
                  <div className="flex items-center justify-between gap-2 text-small">
                    <StarRow value={r.stars} />
                    <span className="text-caption text-fg-2">
                      {r.riderName} · {when(r.createdAt)}
                    </span>
                  </div>
                  {r.comment && <p className="mt-1 text-small">{r.comment}</p>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
