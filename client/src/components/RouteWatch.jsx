import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { useAction } from './ui.jsx';
import { HardHat, ShieldCheck, Siren, TriangleAlert } from 'lucide-react';
import { Button, Notice } from '../ds/index.js';

const distance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const clock = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

/** The ride's open trip alerts (off route, long stop), kept live over the socket. */
function useOpenAlerts(rideId) {
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    // `ride:update` payloads do not carry alerts, so ask once when the panel opens.
    api(`/rides/${rideId}`)
      .then(({ ride }) => setAlerts(ride.alerts ?? []))
      .catch(() => {});
  }, [rideId]);
  useSocketEvent(
    'ride:deviation',
    useCallback(
      (d) => {
        if (d.rideId !== rideId) return;
        setAlerts((list) => [...list.filter((a) => a.id !== d.id), ...(d.status === 'open' ? [d] : [])]);
      },
      [rideId],
    ),
  );
  return [alerts, setAlerts];
}

const TEXT = {
  off_route: {
    rider: (a) => ['Your driver has left the planned route', `About ${distance(a.maxDistanceM)} away from it since ${clock(a.startedAt)}. Hopin's safety team has been alerted.`],
    driver: (a) => [
      'You are off the planned route',
      `About ${distance(a.maxDistanceM)} away from it since ${clock(a.startedAt)}. The rider and Hopin's safety team have been alerted. Rejoin the route, or tell the rider why in chat.`,
    ],
  },
  long_stop: {
    rider: (a) => ['Your ride has stopped. Are you OK?', `The vehicle has not moved since ${clock(a.startedAt)}. Hopin's safety team has been alerted.`],
    driver: (a) => [
      'Long stop noticed',
      `You have not moved since ${clock(a.startedAt)}. The rider and Hopin's safety team have been asked to check. If you are stuck, tell the rider in chat.`,
    ],
  },
};

/**
 * Trip alert banners for a live ride. Riders can answer "I'm OK" or press SOS; drivers are
 * told who has been alerted. Also says plainly when the route is not being watched.
 */
export function RouteWatch({ ride, role, onSos }) {
  const [alerts, setAlerts] = useOpenAlerts(ride.id);
  const [busy, run] = useAction();

  return (
    <>
      {alerts.map((a) => {
        const [title, body] = TEXT[a.kind ?? 'off_route'][role === 'rider' ? 'rider' : 'driver'](a);
        return (
          <div key={a.id} role="alert" className="space-y-2 rounded-[var(--radius-lg)] bg-danger-soft p-4 text-small ring-1 ring-danger/40">
            <p className="flex items-center gap-2 font-bold text-danger">
              <TriangleAlert aria-hidden className="size-5 shrink-0" />
              {title}
            </p>
            <p>{body}</p>
            {role === 'rider' && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => setAlerts((await post(`/rides/${ride.id}/alerts/${a.id}/ok`)).alerts))}>
                  I’m OK
                </Button>
                {onSos && (
                  <Button size="sm" variant="danger" icon={Siren} onClick={onSos}>
                    I need help: SOS
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {alerts.length === 0 && ride.status === 'ongoing' && ride.routeWatched === false && (
        <p className="text-caption text-fg-2">Route alerts are off for this trip: no road route was available when it was booked.</p>
      )}
    </>
  );
}

/** Helmet or seatbelt reminder for the rider once the vehicle is at the pickup or moving. */
export function SafetyReminder({ ride }) {
  if (!['arrived', 'ongoing'].includes(ride.status)) return null;
  const text =
    ride.vehicleType === 'bike'
      ? 'Wear the helmet your driver gives you and fasten the strap before the bike moves.'
      : ride.vehicleType === 'car'
        ? 'Wear your seatbelt, in the back seat too.'
        : null;
  return text ? (
    <Notice icon={ride.vehicleType === 'bike' ? HardHat : ShieldCheck}>
      <p>{text}</p>
    </Notice>
  ) : null;
}

/** "Reached safely?" after a night ride, until the rider answers. */
export function SafetyCheckBanner() {
  const [check, setCheck] = useState(null);
  const [busy, run] = useAction();
  useEffect(() => {
    api('/rides/safety-check')
      .then((d) => setCheck(d.check))
      .catch(() => {});
  }, []);
  useSocketEvent('safety:check', useCallback((c) => setCheck(c), []));
  if (!check) return null;
  return (
    <div role="alert" className="mb-4 space-y-2 rounded-[var(--radius-lg)] bg-accent-soft p-4 text-small">
      <p className="flex items-center gap-2 font-bold">
        <ShieldCheck aria-hidden className="size-5 shrink-0" />
        Reached safely?
      </p>
      <p>
        {check.escalatedAt
          ? 'We did not hear from you, so we alerted our safety team and your emergency contacts. Let us know you are fine.'
          : `Tap below by ${clock(check.dueAt)}. If we don't hear from you, we'll text your emergency contacts.`}
      </p>
      <Button
        variant="primary"
        loading={busy}
        onClick={() =>
          run(async () => {
            await post(`/rides/${check.rideId}/safe`);
            setCheck(null);
          })
        }
      >
        I’m safe
      </Button>
    </div>
  );
}
