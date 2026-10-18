import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiUrl } from '../api.js';
import { Link2Off, MapPin } from 'lucide-react';
import MapView from '../components/MapView.jsx';
import { Logo } from '../components/Shell.jsx';
import { Empty, Pill } from '../components/ui.jsx';
import { Skeleton } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { STATUS_TEXT } from '../util.js';

/** Public, live view of a shared trip. No login: the unguessable token is the access. */
export default function Track() {
  const { token } = useParams();
  const [trip, setTrip] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(apiUrl(`/track/${encodeURIComponent(token)}`));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!stop) {
          setTrip(data);
          setError('');
        }
      } catch (e) {
        if (!stop) setError(e.message || 'Could not load this trip');
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [token]);

  if (error && !trip) {
    return (
      <div className="grid h-full place-items-center bg-ground px-4">
        <Empty icon={Link2Off} title={error}>
          Ask the sender for a fresh link.
        </Empty>
      </div>
    );
  }

  const ended = trip && ['completed', 'cancelled'].includes(trip.status);
  const VIcon = VEHICLE_ICON[trip?.driver?.vehicle.type] ?? VEHICLE_ICON.car;
  return (
    <div className="flex h-full flex-col bg-ground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <Logo />
        {trip ? <Pill tone={trip.status}>{STATUS_TEXT[trip.status]}</Pill> : <Skeleton width={96} height={24} />}
      </header>
      <div className="relative flex-1">
        {trip && (
          <MapView
            pickup={trip.pickup}
            stops={trip.stops}
            dropoff={trip.dropoff}
            route={trip.route}
            vehicle={trip.driverLocation}
            vehicleType={trip.driver?.vehicle.type}
            fitPoints={trip.driverLocation && trip.status === 'accepted' ? [trip.driverLocation, trip.pickup] : [trip.pickup, ...trip.stops, trip.dropoff]}
            fitKey={trip.status}
            padBottom={180}
          />
        )}
        <div
          className="absolute inset-x-3 bottom-3 rounded-[var(--radius-lg)] bg-surface p-4 sm:left-4 sm:right-auto sm:w-96"
          style={{ zIndex: 600, boxShadow: 'var(--shadow-sheet)' }}
          aria-live="polite"
        >
          {!trip ? (
            <div role="status" aria-busy="true" className="space-y-2">
              <span className="sr-only">Loading trip</span>
              <Skeleton width="70%" height={20} />
              <Skeleton width="90%" height={14} />
            </div>
          ) : (
            <>
              <p className="font-display text-heading font-bold">
                {trip.riderName} is {ended ? (trip.status === 'completed' ? 'safely dropped off' : 'no longer on this ride') : 'sharing a live trip'}
              </p>
              {trip.driver && (
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-small text-fg-2">
                  <VIcon aria-hidden className="size-4" />
                  {trip.driver.name} · {trip.driver.vehicle.model}
                  <span className="rounded-[var(--radius-xs)] border-2 border-ink bg-taxi px-1.5 font-mono text-caption font-bold text-ink">{trip.driver.vehicle.plate}</span>
                </p>
              )}
              {trip.dropoff?.address && (
                <p className="mt-2 flex items-start gap-1.5 text-small">
                  <MapPin aria-hidden className="mt-0.5 size-4 shrink-0" /> {trip.dropoff.address}
                </p>
              )}
              <p className="mt-2 text-caption text-fg-2">{ended ? 'Tracking has ended.' : trip.driverLocation ? 'Location updates every few seconds.' : 'Waiting for the driver’s location…'}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
