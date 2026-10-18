import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowRight, Banknote, CalendarClock, CircleCheck, Hourglass, KeyRound, LocateOff, MapPinCheck, Navigation, Power, Radar, ShieldAlert, TrainFront, X, Zap } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import MapView from '../components/MapView.jsx';
import { TripRoute } from '../components/RideBits.jsx';
import { ChatButton } from '../components/RideChat.jsx';
import { RouteWatch } from '../components/RouteWatch.jsx';
import { TripRecorder } from '../components/TripRecorder.jsx';
import { ReportWaterlogButton } from '../components/Waterlog.jsx';
import { DriverPayouts } from '../components/Payouts.jsx';
import { useT } from '../i18n/index.js';
import HelmetSelfie from '../components/HelmetSelfie.jsx';
import { DriverRideExtras, MessageCards } from '../components/BookingModes.jsx';
import { FatigueNote, HeadingHome, PassCard, StationQueue } from '../components/DriverTools.jsx';
import { Avatar, Modal, Stars, toast, useAction } from '../components/ui.jsx';
import { Badge, BottomSheet, Button, Card, Notice, Skeleton, useMedia } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { PAID_VIA, ago, navigationUrl, rupees, shortPlace } from '../util.js';

const ONLINE_KEY = 'hopin.driverOnline';
const readOnline = () => {
  try {
    return sessionStorage.getItem(ONLINE_KEY) === '1';
  } catch {
    return false;
  }
};
const writeOnline = (v) => {
  try {
    sessionStorage.setItem(ONLINE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
};

// Sheet heights per stage (fractions of the screen under the header).
const SNAPS = { loading: [0.4], home: [0.46, 0.92], ride: [0.4, 0.62, 0.92], done: [0.9] };

function useElementHeight() {
  const ref = useRef(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

/** Indian commercial plates are yellow; show the driver's own the same way. */
function Plate({ plate }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[var(--radius-xs)] border-2 border-ink bg-taxi px-2 py-0.5 font-mono text-small font-bold tracking-wider text-ink" aria-label={`Number plate ${plate}`}>
      {plate}
    </span>
  );
}

export default function Drive() {
  const t = useT();
  const { user, socket, connected } = useSession();
  const [online, setOnline] = useState(false);
  const [me, setMe] = useState(null);
  const [gps, setGps] = useState(false);
  const [offers, setOffers] = useState([]);
  const [focusOffer, setFocusOffer] = useState(null);
  const [ride, setRide] = useState(undefined);
  const [approach, setApproach] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [gpsError, setGpsError] = useState('');
  const meRef = useRef(null);
  const lastSent = useRef(0);
  // Effects and socket handlers read the latest position from the ref; keep it in step with state.
  meRef.current = me;

  const loadEarnings = useCallback(() => api('/rides/earnings').then(setEarnings).catch(() => {}), []);
  // Whether this driver's documents are all approved (the server enforces it; this is for the banner).
  const [verification, setVerification] = useState(null);
  useEffect(() => {
    api('/driver/verification').then(setVerification).catch(() => {});
  }, []);

  useEffect(() => {
    api('/rides/active')
      .then(({ ride }) => setRide(ride))
      .catch(() => setRide(null));
    loadEarnings();
  }, [loadEarnings]);

  /** Moves the driver and streams the position, at most once a second. */
  const moveTo = useCallback(
    (p, force = false) => {
      meRef.current = p;
      setMe(p);
      const now = Date.now();
      if (socket && (force || now - lastSent.current > 900)) {
        lastSent.current = now;
        socket.emit('driver:location', p);
      }
    },
    [socket],
  );

  // The driver's position comes only from the device's real location. There is no
  // manual or default position: a driver without location cannot go online.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError('This browser cannot share your location, so you cannot go online.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGps(true);
        setGpsError('');
        // Accuracy (metres) lets the server ignore poor fixes for route alerts.
        moveTo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      (err) => {
        setGps(false);
        setGpsError(
          err.code === err.PERMISSION_DENIED ? 'Location access is blocked. Allow location for this site to go online.' : 'Waiting for your location… make sure location is turned on.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [moveTo]);

  const goOnline = useCallback(
    async (silent = false) => {
      if (!socket) return;
      if (!meRef.current) return !silent && toast('Turn on location first — Hopin needs your real position to send you nearby rides.', 'error');
      const ack = await socket
        .timeout(4000)
        .emitWithAck('driver:online', meRef.current)
        .catch(() => ({ ok: false, error: 'No connection' }));
      if (!ack.ok) return !silent && toast(ack.error, 'error');
      setOnline(true);
      writeOnline(true);
      const { rides } = await api('/rides/open').catch(() => ({ rides: [] }));
      setOffers(rides);
    },
    [socket, me],
  );

  const goOffline = () => {
    socket?.emit('driver:offline', null, () => {});
    setOnline(false);
    setOffers([]);
    writeOnline(false);
  };

  // Come back online after a reload or reconnect if we were online before.
  useEffect(() => {
    if (connected && me && readOnline()) goOnline(true);
  }, [connected, Boolean(me)]); // eslint-disable-line react-hooks/exhaustive-deps

  useSocketEvent(
    'ride:offer',
    useCallback((o) => {
      setOffers((list) => (list.some((x) => x.id === o.id) ? list : [o, ...list]));
      try {
        // A short chime so a new request is noticed.
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 880;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } catch {
        /* audio blocked until the user interacts - fine */
      }
    }, []),
  );
  // An admin rejected today's helmet selfie: the server has taken us offline.
  const [helmetKey, setHelmetKey] = useState(0);
  useSocketEvent(
    'driver:forced-offline',
    useCallback(({ reason }) => {
      setOnline(false);
      setOffers([]);
      writeOnline(false);
      setHelmetKey((k) => k + 1);
      toast(`You are offline: ${reason}`, 'error');
    }, []),
  );
  useSocketEvent(
    'ride:withdrawn',
    useCallback(({ id }) => setOffers((list) => list.filter((o) => o.id !== id)), []),
  );
  useSocketEvent(
    'ride:update',
    useCallback(
      (r) => {
        setRide((cur) => (cur?.id === r.id ? r : cur));
        if (r.payment.status === 'paid') loadEarnings();
      },
      [loadEarnings],
    ),
  );

  // Route from the driver to the pickup while heading there.
  useEffect(() => {
    if (ride?.status !== 'accepted' || !meRef.current) return setApproach(null);
    const from = meRef.current;
    api(`/geo/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${ride.pickup.lat}&toLng=${ride.pickup.lng}`)
      .then(({ route }) => setApproach(route.geometry))
      .catch(() =>
        setApproach([
          [from.lat, from.lng],
          [ride.pickup.lat, ride.pickup.lng],
        ]),
      );
  }, [ride?.id, ride?.status, Boolean(me)]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async (offer) => {
    try {
      const { ride } = await post(`/rides/${offer.id}/accept`);
      setRide(ride);
      setOffers([]);
      setFocusOffer(null);
    } catch (err) {
      toast(err.message, 'error');
      setOffers((list) => list.filter((o) => o.id !== offer.id));
    }
  };
  const decline = (offer) => {
    post(`/rides/${offer.id}/decline`).catch(() => {});
    setOffers((list) => list.filter((o) => o.id !== offer.id));
    if (focusOffer?.id === offer.id) setFocusOffer(null);
  };

  // Display only: sheet height and map framing.
  const [rootRef, rootH] = useElementHeight();
  const desktop = useMedia('(min-width: 1024px)');
  const [footerSlot, setFooterSlot] = useState(null);
  const [userSnap, setUserSnap] = useState(null);
  const finished = ride && (ride.status === 'completed' || ride.status === 'cancelled');
  const stage = ride === undefined ? 'loading' : !ride ? 'home' : finished ? 'done' : 'ride';
  const snaps = SNAPS[stage];
  const snap = userSnap?.stage === stage ? userSnap.i : stage === 'ride' ? 1 : 0;
  const padBottom = desktop ? 0 : Math.round(Math.min(snaps[snap], 0.7) * rootH);

  const shown = ride ?? focusOffer;
  const VIcon = VEHICLE_ICON[user.vehicle?.type] ?? VEHICLE_ICON.car;
  const portal = (node) => (footerSlot ? createPortal(node, footerSlot) : node);

  return (
    <div ref={rootRef} className="relative h-full overflow-hidden lg:flex">
      <div className="absolute inset-0 lg:relative lg:order-2 lg:flex-1">
        <MapView
          pickup={shown?.pickup}
          stops={shown?.stops ?? []}
          dropoff={shown?.dropoff}
          route={shown?.route}
          approach={ride?.status === 'accepted' ? approach : null}
          vehicle={me}
          vehicleType={user.vehicle?.type}
          fitPoints={shown ? (ride?.status === 'accepted' ? [me, ride.pickup] : [shown.pickup, ...shown.stops, shown.dropoff]) : [me]}
          fitKey={shown ? `${shown.id}:${ride?.status ?? 'offer'}` : `me:${Boolean(me)}`}
          padBottom={padBottom}
          showWaterlog
        />
        <div className="absolute right-3 top-3" style={{ zIndex: 500 }}>
          <ReportWaterlogButton />
        </div>
        {stage === 'home' && (
          <p
            className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-surface px-3 py-2 text-caption font-semibold"
            style={{ zIndex: 500, boxShadow: 'var(--shadow-float)' }}
          >
            <span className={`size-2 rounded-full ${online ? 'bg-success' : 'bg-line-strong'}`} aria-hidden />
            {online ? t('drive.online') : t('drive.offline')}
          </p>
        )}
      </div>

      <BottomSheet
        key={stage}
        label={stage === 'home' ? 'Driver home' : 'Current ride'}
        snaps={snaps}
        snap={snap}
        onSnapChange={(i) => setUserSnap({ stage, i })}
        footer={stage === 'loading' ? undefined : <div ref={setFooterSlot} />}
        className="lg:order-1"
      >
        {stage === 'loading' ? (
          <div role="status" aria-busy="true" className="space-y-4 pt-1">
            <span className="sr-only">Loading</span>
            <Skeleton width="50%" height={28} />
            <Skeleton height={84} radius="var(--radius-lg)" />
          </div>
        ) : ride ? (
          <ActiveRide ride={ride} me={me} onRide={setRide} onDone={() => (setRide(null), loadEarnings(), online && goOnline(true))} portal={portal} />
        ) : (
          <div className="space-y-4 pb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="font-display text-title font-bold">{online ? (offers.length ? t('drive.requests') : t('drive.online')) : t('drive.offline')}</h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-small text-fg-2">
                  <VIcon aria-hidden className="size-[18px]" />
                  {user.vehicle?.model}
                  {user.vehicle?.plate && <Plate plate={user.vehicle.plate} />}
                </p>
              </div>
              {earnings && (
                <Badge tone="neutral">
                  <Stars value={earnings.rating} size={13} />
                </Badge>
              )}
            </div>

            {!gps && (
              <Notice icon={LocateOff} tone="danger" title={t('drive.location')}>
                <p>{gpsError || t('drive.locationWaiting')}</p>
              </Notice>
            )}
            {verification && !verification.canDrive && (
              <Notice
                icon={ShieldAlert}
                tone="warning"
                title={t('drive.verificationNeeded')}
                action={
                  <Button as={Link} to="/documents" size="sm" variant="outline" iconRight={ArrowRight}>
                    {t('drive.openDocuments')}
                  </Button>
                }
              >
                <p>{verification.message}</p>
              </Notice>
            )}

            {online && (
              <section aria-label={t('drive.requests')} className="space-y-3">
                {offers.length === 0 ? (
                  <div className="flex items-center gap-4 rounded-[var(--radius-lg)] p-4 ring-1 ring-line" role="status">
                    <span className="relative grid size-12 shrink-0 place-items-center" aria-hidden>
                      <span className="pulse-ring absolute inset-0 rounded-full bg-success/30" />
                      <Radar className="relative size-6 text-success" />
                    </span>
                    <p className="text-small text-fg-2">{t('drive.waiting')}</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {offers.map((o) => (
                      <OfferCard key={o.id} offer={o} focused={focusOffer?.id === o.id} onFocus={() => setFocusOffer(o)} onAccept={() => accept(o)} onDecline={() => decline(o)} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {earnings ? (
              <div className="grid grid-cols-3 gap-2">
                <MiniStat label={t('drive.today')} value={rupees(earnings.earnings.today)} sub={t('drive.trips', { n: earnings.trips.today })} />
                <MiniStat label={t('drive.week')} value={rupees(earnings.earnings.week)} sub={t('drive.total', { n: earnings.trips.total })} />
                <MiniStat label={t('drive.rating')} value={Number(earnings.rating ?? 5).toFixed(1)} sub={t('drive.reviews', { n: earnings.ratingCount })} />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} height={76} radius="var(--radius-md)" />
                ))}
              </div>
            )}
            {earnings && (
              <p className="text-caption text-fg-2">
                {earnings.walletBalance < 0 ? t('drive.owe', { amount: rupees(-earnings.walletBalance) }) : t('drive.wallet', { amount: rupees(earnings.walletBalance) })} {t('drive.shareNote')}
              </p>
            )}

            <HelmetSelfie key={helmetKey} />
            <FatigueNote online={online} />
            <StationQueue online={online} />
            <HeadingHome online={online} me={me} />
            <PassCard onChange={loadEarnings} />
            <DriverPayouts onChange={loadEarnings} />

            {portal(
              online ? (
                <Button variant="outline" size="lg" block icon={Power} onClick={goOffline}>
                  {t('drive.goOffline')}
                </Button>
              ) : (
                <Button variant="primary" size="lg" block icon={Power} disabled={!connected || !gps} onClick={() => goOnline()}>
                  {t('drive.goOnline')}
                </Button>
              ),
            )}
          </div>
        )}
      </BottomSheet>
    </div>
  );
}

function MiniStat({ label, value, sub }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-md)] bg-raised p-3">
      <p className="truncate text-caption font-semibold text-fg-2">{label}</p>
      <p className="truncate font-display text-heading font-bold tabular-nums">{value}</p>
      <p className="truncate text-caption text-fg-2">{sub}</p>
    </div>
  );
}

function OfferCard({ offer, focused, onFocus, onAccept, onDecline }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const PayIcon = PAID_VIA[offer.payment.method].icon;
  return (
    <li>
      <Card flat className={`space-y-3 ${focused ? 'ring-2 ring-fg' : ''}`} onMouseEnter={onFocus} onFocus={onFocus}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-[1.75rem] font-bold leading-none tabular-nums">{rupees(offer.price.fare)}</p>
            <p className="mt-1.5 text-caption text-fg-2">
              {offer.distanceKm} km trip · {offer.pickupDistanceKm != null ? `${offer.pickupDistanceKm} km to pickup` : 'pickup nearby'} · {ago(offer.createdAt)}
            </p>
          </div>
          <Badge icon={PayIcon}>{PAID_VIA[offer.payment.method].label}</Badge>
        </div>
        <TripRoute ride={offer} compact />
        {(offer.station || offer.scheduledFor || offer.price.surge > 1) && (
          <div className="flex flex-wrap gap-2">
            {offer.station && (
              <Badge tone="accent" icon={TrainFront}>
                1st in {offer.station.name} queue · {offer.station.offerSeconds} s
              </Badge>
            )}
            {offer.scheduledFor && (
              <Badge icon={CalendarClock}>Pickup {new Date(offer.scheduledFor).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</Badge>
            )}
            {offer.price.surge > 1 && (
              <Badge tone="warning" icon={Zap}>
                {offer.price.surge}× demand
              </Badge>
            )}
          </div>
        )}
        <div className="space-y-2 empty:hidden">
          <DriverRideExtras ride={offer} />
        </div>
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <Button variant="outline" icon={X} onClick={onDecline}>
            {t('drive.decline')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onAccept();
              setBusy(false);
            }}
          >
            {t('drive.accept')}
          </Button>
        </div>
      </Card>
    </li>
  );
}

function ActiveRide({ ride, me, onRide, onDone, portal }) {
  const t = useT();
  const [otp, setOtp] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, run] = useAction();
  const act = (path, body) =>
    run(async () => {
      const res = await post(`/rides/${ride.id}/${path}`, body);
      onRide(res.ride);
    });

  const r = ride.rider;
  const navPoints = ride.status === 'accepted' ? [me ?? ride.pickup, ride.pickup] : [me ?? ride.pickup, ...ride.stops, ride.dropoff];
  const finished = ride.status === 'completed' || ride.status === 'cancelled';
  const cashDue = ride.status === 'completed' && ride.payment.status === 'due' && ride.payment.method === 'cash';
  const onlineDue = ride.status === 'completed' && ride.payment.status === 'due' && ride.payment.method !== 'cash';
  const PayIcon = PAID_VIA[ride.payment.method].icon;
  const heading =
    ride.status === 'accepted'
      ? t(ride.parcel ? 'drive.pickUpParcel' : 'drive.pickUp', { name: (ride.passenger?.name ?? r.name).split(' ')[0] })
      : ride.status === 'arrived'
        ? t('drive.askOtp')
        : ride.status === 'ongoing'
          ? ride.rental
            ? t('drive.rental')
            : ride.parcel
              ? t('drive.deliverTo', { name: ride.parcel.receiverName })
              : t('drive.dropAt', { place: shortPlace(ride.dropoff) })
          : ride.status === 'completed'
            ? ride.payment.status === 'paid'
              ? t('drive.tripPaid')
              : t('drive.collectPayment')
            : t('drive.rideCancelled');

  const codeForm = (id, label, submitLabel, onSubmit) =>
    portal(
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label className="flex items-center gap-2 text-small font-semibold" htmlFor={id}>
          <KeyRound aria-hidden className="size-4" /> {label}
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            className="input min-w-0 flex-1 text-center font-display text-[1.5rem] font-bold tracking-[0.5em]"
            inputMode="numeric"
            maxLength={4}
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={otp.length !== 4}>
            {submitLabel}
          </Button>
        </div>
      </form>,
    );

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-start gap-3">
        {finished ? (
          <span className={`grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] ${ride.status === 'completed' ? 'bg-success-soft text-success' : 'bg-raised'}`} aria-hidden>
            {ride.status === 'completed' ? <CircleCheck className="size-6" /> : <X className="size-6" />}
          </span>
        ) : null}
        <div className="min-w-0">
          {!finished && <Badge tone={ride.status === 'ongoing' ? 'success' : 'accent'}>{t(`drive.status.${ride.status}`)}</Badge>}
          <h1 className={`font-display text-title font-bold ${finished ? '' : 'mt-2'}`}>{heading}</h1>
          {ride.status === 'cancelled' && <p className="mt-1 text-small text-fg-2">{ride.cancelReason}</p>}
        </div>
      </div>

      <Card flat className="flex items-center gap-3">
        <Avatar src={r.avatar} name={r.name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-heading font-bold">{r.name}</p>
          <p className="flex items-center gap-1.5 text-small text-fg-2">
            <PayIcon aria-hidden className="size-4" />
            {PAID_VIA[ride.payment.method].label} · <span className="font-semibold tabular-nums text-fg">{rupees(ride.price.fare)}</span>
          </p>
        </div>
        {!finished && <ChatButton ride={ride} otherName={r.name} />}
      </Card>

      {!finished && <RouteWatch ride={ride} role="driver" />}
      <DriverRideExtras ride={ride} />

      <Card flat>
        <TripRoute ride={ride} />
      </Card>

      {!finished && (
        <div className="grid grid-cols-2 gap-2">
          <Button as="a" variant="outline" icon={Navigation} href={navigationUrl(navPoints)} target="_blank" rel="noreferrer">
            {t('drive.navigate')}
          </Button>
          {ride.status !== 'ongoing' ? (
            <Button variant="outline" icon={X} onClick={() => setCancelOpen(true)}>
              {t('drive.cancel')}
            </Button>
          ) : (
            <MessageCards />
          )}
        </div>
      )}
      {!finished && ride.status !== 'ongoing' && <MessageCards />}
      <TripRecorder ride={ride} role="driver" />

      {onlineDue && (
        <Notice icon={Hourglass} tone="accent">
          <p>{t('drive.waitingOnline', { amount: rupees(ride.price.due) })}</p>
        </Notice>
      )}

      {/* The one main action for this step, pinned in thumb reach. */}
      {ride.status === 'accepted' &&
        portal(
          <Button variant="primary" size="lg" block icon={MapPinCheck} loading={busy} onClick={() => act('arrive')}>
            {t('drive.arrived')}
          </Button>,
        )}
      {ride.status === 'arrived' && codeForm('otp', t('drive.riderOtp'), t('drive.startTrip'), () => act('start', { otp }))}
      {ride.status === 'ongoing' &&
        !ride.parcel &&
        portal(
          <Button variant="primary" size="lg" block icon={CircleCheck} loading={busy} onClick={() => act('complete')}>
            {ride.rental ? t('drive.endRental') : t('drive.completeTrip')}
          </Button>,
        )}
      {ride.status === 'ongoing' && ride.parcel && codeForm('delivery-otp', t('drive.receiverCode'), t('drive.delivered'), () => act('complete', { deliveryOtp: otp }))}
      {cashDue &&
        portal(
          <Button variant="primary" size="lg" block icon={Banknote} loading={busy} onClick={() => act('collect-cash')}>
            {t('drive.collectedCash', { amount: rupees(ride.price.due) })}
          </Button>,
        )}
      {finished &&
        !cashDue &&
        portal(
          <Button variant="secondary" size="lg" block onClick={onDone}>
            {t('drive.backToRequests')}
          </Button>,
        )}

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('drive.cancelTitle')}>
        <p className="mb-4 text-small text-fg-2">{t('drive.cancelNote')}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => setCancelOpen(false)}>
            {t('drive.keepRide')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              setCancelOpen(false);
              act('cancel', { reason: 'Driver could not make it' });
            }}
          >
            {t('drive.cancelRide')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
