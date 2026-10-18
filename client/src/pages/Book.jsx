import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Ambulance, ArrowRight, Banknote, Briefcase, Car, CircleAlert, CircleCheck, Copy, CreditCard, Download, LifeBuoy, LocateFixed, LocateOff, MapPin, MessageSquareText,
  Package, PencilLine, Phone, Plus, RefreshCw, SearchX, Share2, Siren, Smartphone, Star, Timer, Users, Wallet, X, Zap,
} from 'lucide-react';
import { api, download, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import MapView from '../components/MapView.jsx';
import PlaceInput from '../components/PlaceInput.jsx';
import DriverSheet from '../components/DriverSheet.jsx';
import { ChatButton } from '../components/RideChat.jsx';
import { RouteWatch, SafetyCheckBanner, SafetyReminder } from '../components/RouteWatch.jsx';
import { TripRecorder } from '../components/TripRecorder.jsx';
import { t as tr, useT } from '../i18n/index.js';
import { ReportWaterlogButton, WaterlogDelayLine, WaterlogRouteNotice } from '../components/Waterlog.jsx';
import { SavePlaceModal, SavedPlaceChips, UpcomingRides, WhenPicker, pickupTime, useSavedPlaces } from '../components/Planning.jsx';
import { SurgeWatch } from '../components/FairMoney.jsx';
import { DriverRest, StationPlace } from '../components/DriverTools.jsx';
import { BusinessPayment, useBusiness } from '../components/Growth.jsx';
import { AccessibilityPicker, ClosuresNote, PARCEL_SIZES, ParcelForm, PassengerPicker, PriceLockBox, RentalPlanner, RideExtras, emptyParcel, parcelReady, useClosures } from '../components/BookingModes.jsx';
import { FareBreakdown, PayDue, ReviewForm, TripRoute, useFeatures } from '../components/RideBits.jsx';
import { Avatar, Modal, Stars, toast, useAction } from '../components/ui.jsx';
import { Anim, Badge, BottomSheet, Button, Card, Chip, EmptyState, IconButton, Illustration, Input, Skeleton, Tabs, useMedia } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { DEFAULT_CENTER, PAID_VIA, PAYMENT_META, STATUS_TEXT, VEHICLE_META, getBrowserLocation, rupees, shortPlace, useElapsed } from '../util.js';

const MAX_STOPS = 3;
const PAY_ICON = { cash: Banknote, upi: Smartphone, card: CreditCard, wallet: Wallet, corporate: Briefcase };
// Sheet heights per stage, as fractions of the screen below the header.
const SNAPS = { loading: [0.4], plan: [0.5, 0.64, 0.94], search: [0.52, 0.92], live: [0.36, 0.62, 0.92], done: [0.92], nodriver: [0.5] };

/** Height of an element, kept current. */
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

export default function Book() {
  const { user, setUser } = useSession();
  const [ride, setRide] = useState(undefined); // undefined = loading, null = none
  const [driverLoc, setDriverLoc] = useState(null);
  const [eta, setEta] = useState(null);
  const [me, setMe] = useState(null);
  const [gps, setGps] = useState('pending'); // pending | on | off, display only

  // Planner state lives here so it survives a cancelled request.
  const [pickup, setPickup] = useState(null);
  const [stops, setStops] = useState([]);
  const [dropoff, setDropoff] = useState(null);
  const [activeField, setActiveField] = useState('drop');

  useEffect(() => {
    api('/rides/active')
      .then(({ ride }) => {
        setRide(ride);
        if (ride?.driverLocation) setDriverLoc(ride.driverLocation);
      })
      .catch(() => setRide(null));
    getBrowserLocation().then(async (loc) => {
      if (!loc) return setGps('off');
      setGps('on');
      setMe(loc);
      setPickup((p) => p ?? { ...loc, address: 'Current location' });
      const { address } = await api(`/geo/reverse?lat=${loc.lat}&lng=${loc.lng}`).catch(() => ({}));
      if (address) setPickup((p) => (p && p.lat === loc.lat && p.lng === loc.lng ? { ...p, address } : p));
    });
  }, []);

  useSocketEvent(
    'ride:update',
    useCallback((r) => {
      setRide((cur) => {
        // While planning, a booked-ahead ride that is still waiting (or was cancelled before
        // it went out) belongs in the Upcoming list, not on the ride screen.
        if (cur === null && (r.status === 'scheduled' || (r.status === 'cancelled' && r.scheduledFor && !r.acceptedAt))) return cur;
        // An ETA measured toward the pickup is meaningless once the trip starts.
        if (cur?.status !== r.status) setEta(null);
        return cur === null || cur?.id === r.id ? r : cur;
      });
      if (r.driverLocation) setDriverLoc(r.driverLocation);
    }, []),
  );
  useSocketEvent(
    'ride:location',
    useCallback((p) => {
      setDriverLoc({ lat: p.lat, lng: p.lng });
      setEta(p.etaMin);
    }, []),
  );

  const placeFromMap = async (point) => {
    if (ride && ride.status !== 'cancelled') return;
    const { address } = await api(`/geo/reverse?lat=${point.lat}&lng=${point.lng}`).catch(() => ({ address: null }));
    const place = { ...point, address: address ?? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` };
    if (activeField === 'pickup') {
      setPickup(place);
      setActiveField('drop');
    } else if (activeField === 'drop') setDropoff(place);
    else {
      const i = Number(activeField.slice(4));
      setStops((s) => s.map((x, j) => (j === i ? place : x)));
    }
  };

  const live = ride && ['requested', 'accepted', 'arrived', 'ongoing'].includes(ride.status);
  const vehicleOnMap = live && ride.status !== 'requested' ? driverLoc : null;
  const fit = !ride ? null : ride.status === 'accepted' && driverLoc ? [driverLoc, ride.pickup] : [ride.pickup, ...ride.stops, ride.dropoff];
  const done = () => {
    setRide(null);
    setDriverLoc(null);
    setEta(null);
    api('/auth/me')
      .then(({ user }) => setUser(user))
      .catch(() => {});
  };

  // Display only: which sheet height is showing, and whether fares are on screen.
  const [rootRef, rootH] = useElementHeight();
  const desktop = useMedia('(min-width: 1024px)');
  const [choosing, setChoosing] = useState(false);
  const [quoteRoute, setQuoteRoute] = useState(null); // display only: the quoted route line while choosing
  const [footerSlot, setFooterSlot] = useState(null);
  const [userSnap, setUserSnap] = useState(null);

  const noDriver = ride?.status === 'cancelled' && ride.cancelledBy === 'system' && !ride.driver;
  const stage = ride === undefined ? 'loading' : !ride ? 'plan' : ride.status === 'requested' ? 'search' : live ? 'live' : noDriver ? 'nodriver' : 'done';
  const snaps = SNAPS[stage];
  const snapCtx = `${stage}:${choosing}`;
  const snap = userSnap?.ctx === snapCtx ? userSnap.i : stage === 'live' || (stage === 'plan' && choosing) ? 1 : 0;
  // Frame the map inside the part the sheet leaves visible.
  const padBottom = desktop ? 0 : Math.round(Math.min(snaps[snap], 0.7) * rootH);

  return (
    <div ref={rootRef} className="relative h-full overflow-hidden lg:flex">
      <div className="absolute inset-0 lg:relative lg:order-2 lg:flex-1">
        <MapView
          pickup={ride ? ride.pickup : pickup}
          stops={ride ? ride.stops : stops.filter(Boolean)}
          dropoff={ride ? ride.dropoff : dropoff}
          route={ride ? ride.route : quoteRoute ?? undefined}
          vehicle={vehicleOnMap}
          vehicleType={ride?.vehicleType}
          me={!ride ? me : null}
          onMapClick={placeFromMap}
          fitPoints={fit ?? undefined}
          fitKey={fit ? `${ride.id}:${ride.status}` : undefined}
          padBottom={padBottom}
          showWaterlog
        />
        {stage === 'plan' && !choosing && (
          <p
            className="pointer-events-none absolute left-3 top-3 whitespace-nowrap rounded-[var(--radius-sm)] bg-surface px-3 py-2 text-caption font-semibold lg:left-1/2 lg:-translate-x-1/2"
            style={{ zIndex: 500, boxShadow: 'var(--shadow-float)' }}
          >
            {activeField === 'pickup' ? tr('Tap the map to set pickup') : activeField === 'drop' ? tr('Tap the map to set drop') : tr('Tap the map to set stop {n}', { n: Number(activeField.slice(4)) + 1 })}
          </p>
        )}
        <div className="absolute right-3 top-3" style={{ zIndex: 500 }}>
          <ReportWaterlogButton />
        </div>
      </div>

      <BottomSheet
        key={stage}
        label={stage === 'plan' ? tr('Plan your ride') : tr('Your ride')}
        snaps={snaps}
        snap={snap}
        onSnapChange={(i) => setUserSnap({ ctx: snapCtx, i })}
        footer={stage === 'plan' && choosing ? <div ref={setFooterSlot} /> : undefined}
        className="lg:order-1"
      >
        <SafetyCheckBanner />
        {stage === 'loading' ? (
          <SheetSkeleton />
        ) : stage === 'plan' ? (
          <Planner
            user={user}
            me={me}
            gps={gps}
            pickup={pickup}
            setPickup={setPickup}
            stops={stops}
            setStops={setStops}
            dropoff={dropoff}
            setDropoff={setDropoff}
            activeField={activeField}
            setActiveField={setActiveField}
            onBooked={(r) => setRide(r)}
            onChoosing={(on, route) => {
              setChoosing(on);
              setQuoteRoute(route ?? null);
            }}
            footerSlot={footerSlot}
          />
        ) : (
          <RidePanel ride={ride} eta={eta} onRide={setRide} onDone={done} />
        )}
      </BottomSheet>
    </div>
  );
}

function SheetSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-4 pt-1">
      <span className="sr-only">{tr('Loading your ride')}</span>
      <Skeleton width="55%" height={28} />
      <Skeleton height={112} radius="var(--radius-lg)" />
      <Skeleton height={64} radius="var(--radius-lg)" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planning: where to, choose a ride, confirm.

function RideOption({ option, selected, onSelect }) {
  const Icon = VEHICLE_ICON[option.type];
  const meta = VEHICLE_META[option.type];
  return (
    <Card as="button" interactive role="radio" aria-checked={selected} data-selected={selected || undefined} onClick={onSelect} className="flex w-full items-center gap-3.5 !p-3 text-left">
      <span className={`grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] ${selected ? 'bg-accent text-accent-fg' : 'bg-raised text-fg'}`}>
        <Icon aria-hidden className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-display text-heading font-bold leading-tight">{meta.label}</span>
          <span className="inline-flex items-center gap-0.5 text-small text-fg-2">
            <Users aria-hidden className="size-3.5" />
            {option.seats}
          </span>
        </span>
        <span className="block truncate text-small text-fg-2">
          {meta.blurb} · {tr('{n} min', { n: option.etaMin })}
        </span>
        {option.price.surge > 1 && (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="warning" icon={Zap}>
              {tr('{n}× demand', { n: option.price.surge })}
            </Badge>
            {option.demand && (
              <span className="text-caption text-fg-2">
                {tr('{w} waiting · {f} free drivers within {r} km', { w: option.demand.waiting, f: option.demand.freeDrivers, r: option.demand.radiusKm })}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-display text-heading font-bold tabular-nums">{rupees(option.price.fare)}</span>
        {option.price.discount > 0 && <span className="block text-caption text-fg-2 line-through">{rupees(option.price.subtotal)}</span>}
      </span>
    </Card>
  );
}

function FareSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">{tr('Calculating fares')}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3.5 rounded-[var(--radius-lg)] p-3 ring-1 ring-line">
          <Skeleton width={48} height={48} radius="var(--radius-md)" />
          <span className="flex-1">
            <Skeleton width="38%" height={18} />
            <Skeleton width="62%" height={12} className="mt-2" />
          </span>
          <Skeleton width={56} height={22} />
        </div>
      ))}
    </div>
  );
}

function Planner({ user, me, gps, pickup, setPickup, stops, setStops, dropoff, setDropoff, activeField, setActiveField, onBooked, onChoosing, footerSlot }) {
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [selected, setSelected] = useState('car');
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState('');
  const [methods, setMethods] = useState({ upi: [], walletBalance: user.walletBalance });
  const [payment, setPayment] = useState(user.defaultPayment);
  const [upiVpa, setUpiVpa] = useState('');
  const [scheduledFor, setScheduledFor] = useState(null); // null = ride now
  const [upcomingKey, setUpcomingKey] = useState(0);
  const [places, reloadPlaces] = useSavedPlaces();
  const [savingPlace, setSavingPlace] = useState(false);
  // Batch C: ride / rental / parcel, who's riding, accessibility, parcel details.
  const [mode, setMode] = useState('trip');
  const [passenger, setPassenger] = useState(null);
  const [accessibility, setAccessibility] = useState([]);
  const [parcel, setParcel] = useState(emptyParcel);
  const [quoteKey, setQuoteKey] = useState(0);
  const closures = useClosures();
  // Batch E: business rides paid by the company wallet.
  const [business] = useBusiness();
  const [bizOn, setBizOn] = useState(false);
  const [bizNote, setBizNote] = useState('');
  const asBusiness = bizOn && mode === 'trip';
  const [busy, run] = useAction();
  const features = useFeatures();
  const online = Boolean(features?.onlinePayments);
  const [optionsOpen, setOptionsOpen] = useState(false); // display only
  const [editing, setEditing] = useState(false); // display only: addresses open while fares show

  // Card and UPI cannot be offered until the server has a payment gateway.
  useEffect(() => {
    if (features && !online && (payment === 'card' || payment === 'upi')) setPayment('cash');
  }, [features, online, payment]);

  useEffect(() => {
    api('/profile/payment-methods')
      .then((m) => {
        setMethods(m);
        if (m.upi[0]) setUpiVpa(m.upi[0].vpa);
      })
      .catch(() => {});
  }, []);

  // Bias place search toward where the trip is: GPS, else a point already chosen, else the home city.
  const near = me ?? pickup ?? dropoff ?? stops.find(Boolean) ?? DEFAULT_CENTER;
  const ready = pickup && dropoff && stops.every(Boolean);
  const tripKey = ready ? JSON.stringify([pickup, stops, dropoff].flat().map((p) => [p.lat, p.lng])) : '';

  useEffect(() => {
    if (!ready) return setQuote(null);
    const ctrl = new AbortController();
    setQuoting(true);
    setQuoteError('');
    api('/rides/quote', { method: 'POST', body: { pickup, stops, dropoff, promoCode: promo || undefined, scheduledFor: scheduledFor ?? undefined }, signal: ctrl.signal })
      .then(setQuote)
      .catch((e) => e.name !== 'AbortError' && setQuoteError(e.message))
      .finally(() => setQuoting(false));
    return () => ctrl.abort();
  }, [tripKey, promo, scheduledFor, quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A parcel's size decides which vehicles can carry it.
  const allowedTypes = mode === 'parcel' ? PARCEL_SIZES[parcel.size].vehicles : null;
  useEffect(() => {
    if (allowedTypes && !allowedTypes.includes(selected)) setSelected(allowedTypes[allowedTypes.length - 1]);
  }, [mode, parcel.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once fares are in, the addresses fold into one summary row so the rides sit in reach.
  const choosing = Boolean(ready) && mode !== 'rental' && Boolean(quote || quoting || quoteError);
  const compact = choosing && !editing;
  const geometry = choosing ? quote?.route.geometry : null;
  useEffect(() => onChoosing?.(choosing, geometry), [choosing, geometry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onChoosing?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setEditing(false), [tripKey]);

  const option = quote?.options.find((o) => o.type === selected);
  const walletShort = !asBusiness && payment === 'wallet' && option && methods.walletBalance < option.price.fare;

  const book = () =>
    run(async () => {
      const { ride } = await post('/rides', {
        pickup,
        stops,
        dropoff,
        vehicleType: selected,
        paymentMethod: asBusiness ? 'corporate' : payment,
        businessNote: asBusiness ? bizNote : undefined,
        upiVpa: payment === 'upi' ? upiVpa : undefined,
        promoCode: option?.promo ? promo : undefined,
        scheduledFor: scheduledFor ?? undefined,
        kind: mode,
        ...(mode === 'trip' ? { passenger: passenger ?? undefined, accessibility } : {}),
        ...(mode === 'parcel' ? { parcel } : {}),
      });
      if (ride.status === 'scheduled') {
        toast(tr('Booked for {time}. We’ll start finding your driver 15 minutes before.', { time: pickupTime(ride.scheduledFor) }), 'ok');
        setScheduledFor(null);
        setUpcomingKey((k) => k + 1);
        return;
      }
      onBooked(ride);
    });

  /** Fills whichever field is being edited with a saved place. */
  const pickSaved = (p) => {
    const place = { lat: p.lat, lng: p.lng, address: p.address };
    if (activeField === 'pickup') {
      setPickup(place);
      setActiveField('drop');
    } else if (activeField === 'drop') setDropoff(place);
    else {
      const i = Number(activeField.slice(4));
      setStops((s) => s.map((x, j) => (j === i ? place : x)));
    }
  };
  const saveCandidates = [dropoff && { label: 'Drop', place: dropoff }, pickup && pickup.address !== 'Current location' && { label: 'Pickup', place: pickup }].filter(Boolean);

  const useMyLocation = async () => {
    const loc = me ?? (await getBrowserLocation());
    if (!loc) return toast(tr('Location permission is off — tap the map instead.'), 'error');
    const { address } = await api(`/geo/reverse?lat=${loc.lat}&lng=${loc.lng}`).catch(() => ({ address: 'Current location' }));
    setPickup({ ...loc, address });
  };

  const bookDisabled =
    busy ||
    !option ||
    walletShort ||
    (!asBusiness && payment === 'upi' && !upiVpa) ||
    (mode === 'parcel' && !parcelReady(parcel)) ||
    (mode === 'trip' && passenger && (passenger.name.trim().length < 2 || passenger.phone.trim().length < 10));
  const firstName = user.name.split(' ')[0];
  const showFares = mode !== 'rental' && (quote || (ready && quoting) || quoteError);
  const PayIcon = PAY_ICON[asBusiness ? 'corporate' : payment] ?? Banknote;
  const portal = (node) => (footerSlot ? createPortal(node, footerSlot) : node);
  const optionSummary = [
    scheduledFor ? tr('Pickup {time}', { time: pickupTime(scheduledFor) }) : tr('Leave now'),
    mode === 'trip' && (passenger ? tr('For {name}', { name: passenger.name || tr('someone else') }) : tr('For me')),
    promo && tr('Promo {code}', { code: promo }),
    accessibility.length > 0 && tr('{n} accessibility needs', { n: accessibility.length }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-4 pb-2">
      <h1 className="font-display text-title font-bold">{choosing ? tr('Choose a ride') : tr('Where to, {name}?', { name: firstName })}</h1>
      {compact ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-lg)] bg-raised py-3 pl-4 pr-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-line"
          aria-label={tr('Change route: {from} to {to}', { from: shortPlace(pickup), to: shortPlace(dropoff) })}
        >
          <span className="flex flex-col items-center gap-1" aria-hidden>
            <span className="size-2.5 rounded-full bg-success" />
            <span className="h-3.5 w-0.5 bg-line-strong" />
            <span className="size-2.5 rounded-[3px] bg-fg" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-small font-semibold">{shortPlace(pickup)}</span>
            <span className="block truncate text-small font-semibold">
              {stops.length > 0 && <span className="font-normal text-fg-2">{tr('{n} stops', { n: stops.length })} · </span>}
              {shortPlace(dropoff)}
            </span>
          </span>
          {quote && (
            <span className="shrink-0 text-right text-caption text-fg-2">
              {quote.route.distanceKm} km
              <span className="block">{tr('{n} min', { n: quote.route.durationMin })}</span>
            </span>
          )}
          <PencilLine aria-hidden className="size-[18px] shrink-0" />
        </button>
      ) : (
      <>
      <Tabs
        label={tr('What do you want to book?')}
        value={mode}
        onChange={setMode}
        items={[
          { id: 'trip', label: tr('Ride'), icon: Car },
          { id: 'rental', label: tr('Rental'), icon: Timer },
          { id: 'parcel', label: tr('Parcel'), icon: Package },
        ]}
      />

      {gps === 'off' && !pickup && (
        <div role="status" className="flex items-start gap-3 rounded-[var(--radius-md)] bg-warning-soft p-3 text-small text-warning">
          <LocateOff aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{tr('Location is off')}</p>
            <p>{tr('Search your pickup or tap the map. Allow location to see the nearest drivers.')}</p>
          </div>
          <Button size="sm" variant="outline" onClick={useMyLocation}>
            {tr('Retry')}
          </Button>
        </div>
      )}

      {/* Pickup, stops and drop sit in one card, read top to bottom like the route. */}
      <div className="rounded-[var(--radius-lg)] bg-raised p-1">
        <PlaceInput
          kind="pickup"
          label={tr('Pickup location')}
          value={pickup}
          onChange={setPickup}
          near={near}
          active={activeField === 'pickup'}
          onFocus={() => setActiveField('pickup')}
          trailing={<IconButton icon={LocateFixed} label={tr('Use my location for pickup')} onClick={useMyLocation} />}
        />
        {mode !== 'rental' &&
          stops.map((s, i) => (
            <PlaceInput
              key={i}
              kind="stop"
              label={tr('Stop {n}', { n: i + 1 })}
              value={s}
              onChange={(p) => setStops((list) => list.map((x, j) => (j === i ? p : x)))}
              near={near}
              active={activeField === `stop${i}`}
              onFocus={() => setActiveField(`stop${i}`)}
              trailing={
                <IconButton
                  icon={X}
                  label={tr('Remove stop {n}', { n: i + 1 })}
                  onClick={() => {
                    setStops((list) => list.filter((_, j) => j !== i));
                    setActiveField('drop');
                  }}
                />
              }
            />
          ))}
        {mode !== 'rental' && (
          <PlaceInput
            kind="drop"
            label={mode === 'parcel' ? tr('Deliver to') : tr('Where to?')}
            value={dropoff}
            onChange={setDropoff}
            near={near}
            active={activeField === 'drop'}
            onFocus={() => setActiveField('drop')}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {mode === 'trip' && stops.length < MAX_STOPS && (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            onClick={() => {
              setStops((s) => [...s, null]);
              setActiveField(`stop${stops.length}`);
            }}
          >
            {tr('Add stop')}
          </Button>
        )}
        <SavedPlaceChips places={places} onPick={pickSaved} canSave={saveCandidates.length > 0} onSave={() => setSavingPlace(true)} />
      </div>
      </>
      )}
      <SavePlaceModal open={savingPlace} onClose={() => setSavingPlace(false)} candidates={saveCandidates} onSaved={reloadPlaces} />

      <ClosuresNote closures={closures} />
      {!quote && <UpcomingRides reloadKey={upcomingKey} />}

      {mode === 'rental' && <RentalPlanner pickup={pickup} onBooked={onBooked} />}
      {mode === 'parcel' && <ParcelForm value={parcel} onChange={setParcel} />}

      {showFares && (
        <section aria-label={tr('Fares')} className="space-y-3">
          {quote && !quoteError && !compact && (
            <p className="flex items-center gap-1.5 text-small text-fg-2">
              <MapPin aria-hidden className="size-4" />
              {tr('{km} km · about {min} min', { km: quote.route.distanceKm, min: quote.route.durationMin })}{quote.route.estimated ? ` ${tr('(estimated)')}` : ''}
            </p>
          )}
          {quoteError ? (
            <div role="alert" className="rounded-[var(--radius-lg)] bg-danger-soft p-4 text-small text-danger">
              <p className="flex items-center gap-2 font-semibold">
                <CircleAlert aria-hidden className="size-5 shrink-0" /> {tr('Couldn’t get fares')}
              </p>
              <p className="mt-1">{quoteError}</p>
              {portal(
                <Button variant="primary" size="lg" block icon={RefreshCw} loading={quoting} onClick={() => setQuoteKey((k) => k + 1)}>
                  {tr('Try again')}
                </Button>,
              )}
            </div>
          ) : !quote ? (
            <>
              <FareSkeleton />
              {portal(
                <div className="flex items-center gap-4" aria-hidden>
                  <div className="shrink-0 space-y-1.5">
                    <Skeleton width={48} height={12} />
                    <Skeleton width={72} height={26} />
                  </div>
                  <Button variant="primary" size="lg" block disabled>
                    {tr('Book')}
                  </Button>
                </div>,
              )}
            </>
          ) : (
            <>
              <WaterlogRouteNotice waterlog={quote.waterlog} />
              <div className="space-y-2" role="radiogroup" aria-label={tr('Choose a ride')}>
                {quote.options
                  .filter((o) => !allowedTypes || allowedTypes.includes(o.type))
                  .map((o) => (
                    <RideOption key={o.type} option={o} selected={selected === o.type} onSelect={() => setSelected(o.type)} />
                  ))}
              </div>
              {!scheduledFor && <SurgeWatch pickup={pickup} vehicleType={selected} surging={option?.price.surge > 1} />}
              {mode === 'trip' && !scheduledFor && <PriceLockBox option={option} pickup={pickup} dropoff={dropoff} onLocked={() => setQuoteKey((k) => k + 1)} />}

              <div className="space-y-2">
                {mode === 'trip' && <BusinessPayment membership={business?.membership} on={bizOn} setOn={setBizOn} note={bizNote} setNote={setBizNote} />}
                {!asBusiness && (
                  <>
                    <p className="text-small font-semibold">{tr('Pay with')}</p>
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr('Payment method')}>
                      {Object.entries(PAYMENT_META).map(([m, meta]) => (
                        <Chip
                          key={m}
                          role="radio"
                          aria-checked={payment === m}
                          selected={payment === m}
                          icon={PAY_ICON[m]}
                          disabled={(m === 'card' || m === 'upi') && !online}
                          onClick={() => setPayment(m)}
                        >
                          {m === 'wallet' ? rupees(methods.walletBalance) : meta.label}
                        </Chip>
                      ))}
                    </div>
                    {payment === 'upi' &&
                      (methods.upi.length ? (
                        <select className="input" aria-label="UPI ID" value={upiVpa} onChange={(e) => setUpiVpa(e.target.value)}>
                          {methods.upi.map((u) => (
                            <option key={u.id}>{u.vpa}</option>
                          ))}
                        </select>
                      ) : (
                        <Input label="UPI ID" placeholder="yourname@okhdfc" value={upiVpa} onChange={(e) => setUpiVpa(e.target.value.trim())} />
                      ))}
                    {walletShort && <p className="text-small font-medium text-danger">{tr('Wallet has {amount}. Pick another method.', { amount: rupees(methods.walletBalance) })}</p>}
                    {features && !online && <p className="text-caption text-fg-2">{features.onlinePaymentsMessage}</p>}
                  </>
                )}
              </div>

              {/* Everything optional sits behind one row, so the fare and button stay in reach. */}
              <div className="rounded-[var(--radius-lg)] ring-1 ring-line">
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2 text-left"
                  aria-expanded={optionsOpen}
                  onClick={() => setOptionsOpen((o) => !o)}
                >
                  <span className="min-w-0">
                    <span className="block text-small font-semibold">{tr('Trip options')}</span>
                    <span className="block truncate text-caption text-fg-2">{optionSummary}</span>
                  </span>
                  <span className="shrink-0 text-small font-semibold underline underline-offset-4">{optionsOpen ? tr('Done') : tr('Change')}</span>
                </button>
                {optionsOpen && (
                  <div className="space-y-5 border-t border-line p-4">
                    <WhenPicker value={scheduledFor} onChange={setScheduledFor} />
                    {mode === 'trip' && <PassengerPicker value={passenger} onChange={setPassenger} />}
                    {mode === 'trip' && <AccessibilityPicker value={accessibility} onChange={setAccessibility} />}
                    <div className="space-y-1.5">
                      <div className="flex items-end gap-2">
                        <Input
                          className="min-w-0 flex-1"
                          label={tr('Promo code')}
                          placeholder="KOLKATA50"
                          value={promoInput}
                          onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                          onKeyDown={(e) => e.key === 'Enter' && setPromo(promoInput.trim())}
                        />
                        {promo ? (
                          <Button
                            variant="outline"
                            onClick={() => {
                              setPromo('');
                              setPromoInput('');
                            }}
                          >
                            {tr('Remove')}
                          </Button>
                        ) : (
                          <Button variant="outline" onClick={() => setPromo(promoInput.trim())} disabled={!promoInput.trim()}>
                            {tr('Apply')}
                          </Button>
                        )}
                      </div>
                      {promo && option?.promo && (
                        <p className="flex items-center gap-1.5 text-small font-semibold text-success">
                          <CircleCheck aria-hidden className="size-4 shrink-0" /> {option.promo.description} — {tr('you save {amount}', { amount: rupees(option.price.discount) })}
                        </p>
                      )}
                      {promo && option?.promoError && <p className="text-small text-danger">{option.promoError}</p>}
                    </div>
                  </div>
                )}
              </div>

              {/* Fare and the one main action, pinned to the bottom of the sheet at every height. */}
              {portal(
                <div className="flex items-center gap-4">
                <div className="shrink-0">
                  <p className="flex items-center gap-1 whitespace-nowrap text-caption text-fg-2">
                    <PayIcon aria-hidden className="size-3.5" />
                    {asBusiness ? tr('Company') : PAYMENT_META[payment]?.label}
                  </p>
                  <p className="font-display text-title font-bold leading-tight tabular-nums">{option ? rupees(option.price.fare) : '—'}</p>
                </div>
                <Button variant="primary" size="lg" block loading={busy} disabled={bookDisabled} onClick={book} iconRight={ArrowRight}>
                  {scheduledFor ? tr('Schedule {ride}', { ride: option ? VEHICLE_META[option.type].label : '' }) : tr('Book {ride}', { ride: option ? VEHICLE_META[option.type].label : '' })}
                </Button>
                </div>,
              )}
            </>
          )}
        </section>
      )}

      {mode !== 'rental' && !ready && <p className="text-small text-fg-2">{tr('Upfront fares, no surprises. Search an address or tap the map; add up to {n} stops.', { n: MAX_STOPS })}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ride: searching, driver on the way, on the trip, arrived.

/** Indian commercial vehicles carry yellow plates; drawing it the same way makes the cab easy to spot. */
function Plate({ plate }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[var(--radius-xs)] border-2 border-ink bg-taxi px-2 py-0.5 font-mono text-small font-bold tracking-wider text-ink" aria-label={tr('Number plate {plate}', { plate })}>
      {plate}
    </span>
  );
}

function OtpDigits({ otp }) {
  return (
    <div className="flex gap-1.5" role="img" aria-label={tr('Start code {code}', { code: otp.split('').join(' ') })}>
      {otp.split('').map((d, i) => (
        <span key={i} className="grid h-12 w-10 place-items-center rounded-[var(--radius-sm)] bg-taxi font-display text-[1.625rem] font-bold tabular-nums text-ink">
          {d}
        </span>
      ))}
    </div>
  );
}

function RidePanel({ ride, eta, onRide, onDone }) {
  const t = useT();
  const [driverSheet, setDriverSheet] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const { user } = useSession();

  if (ride.status === 'requested') return <Searching ride={ride} onCancel={() => setCancelOpen(true)} cancelModal={<CancelModal ride={ride} open={cancelOpen} onClose={() => setCancelOpen(false)} onRide={onRide} />} />;

  if (ride.status === 'completed' || ride.status === 'cancelled') {
    // The server cancels a request nobody accepted; that is "no drivers", not something the rider did.
    if (ride.status === 'cancelled' && ride.cancelledBy === 'system' && !ride.driver) {
      return (
        <EmptyState
          art={<Illustration name="order-a-ride" width={180} />}
          title={tr('No drivers nearby right now')}
          className="!py-6"
          action={
            <Button variant="primary" size="lg" icon={RefreshCw} onClick={onDone}>
              {tr('Try again')}
            </Button>
          }
        >
          {tr('Every {vehicle} near {place} was busy, and you haven’t been charged. Try again in a minute or pick another vehicle.', { vehicle: VEHICLE_META[ride.vehicleType].label.toLowerCase(), place: shortPlace(ride.pickup) })}
        </EmptyState>
      );
    }
    const blocked = ride.payment.status === 'due' && ride.payment.method !== 'cash';
    const completed = ride.status === 'completed';
    const justPaid = ride.payment.status === 'paid' && ride.payment.method !== 'cash' && ride.payment.paidAt && Date.now() - new Date(ride.payment.paidAt) < 120_000;
    return (
      <div className="space-y-4 pb-2">
        <div className="flex items-start gap-3">
          {completed ? (
            // Plays once on arrival; green when an online payment has just gone through.
            <Anim name={justPaid ? 'payment-success' : 'trip-complete'} size={56} className="-m-1" />
          ) : (
            <span className="grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] bg-raised text-fg">
              <X aria-hidden className="size-6" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="font-display text-title font-bold">{completed ? tr('You’ve arrived at {place}', { place: shortPlace(ride.dropoff) }) : tr('Ride cancelled')}</h1>
            {!completed && ride.cancelReason && <p className="mt-1 text-small text-fg-2">{ride.cancelReason}</p>}
          </div>
        </div>
        {(completed || ride.price.cancellationFee > 0) && (
          <Card flat className="space-y-4">
            <FareBreakdown ride={ride} />
            {ride.payment.status === 'paid' ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge tone="success" icon={CircleCheck}>
                  {tr('Paid by {method}', { method: PAID_VIA[ride.payment.method].label })}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Download}
                  onClick={() => download(`/rides/${ride.id}/receipt.pdf`, `hopin-receipt-${ride.id.slice(0, 8)}.pdf`).catch((e) => toast(e.message, 'error'))}
                >
                  {tr('Receipt')}
                </Button>
              </div>
            ) : (
              <PayDue ride={ride} walletBalance={user.walletBalance} onPaid={onRide} />
            )}
          </Card>
        )}
        {completed && ride.driver && (
          <Card flat>
            {ride.review ? (
              <p className="flex items-center justify-center gap-1 text-small">
                {tr('You rated this trip')}
                {Array.from({ length: ride.review.stars }, (_, i) => (
                  <Star key={i} aria-hidden className="size-4 fill-[var(--accent)] text-[var(--accent-press)]" />
                ))}
                <span className="sr-only">{tr('{n} stars', { n: ride.review.stars })}</span>
              </p>
            ) : (
              <ReviewForm ride={ride} onDone={onRide} />
            )}
          </Card>
        )}
        <div>
          <Button variant={completed ? 'secondary' : 'primary'} size="lg" block onClick={onDone} disabled={blocked}>
            {completed ? tr('Done') : tr('Book another ride')}
          </Button>
          {blocked && <p className="mt-2 text-center text-caption text-fg-2">{tr('Settle the amount due to continue.')}</p>}
        </div>
      </div>
    );
  }

  // accepted / arrived / ongoing
  const d = ride.driver;
  const etaMin = eta ?? ride.pickupEtaMin;
  const heading =
    ride.status === 'accepted'
      ? etaMin != null
        ? t('ride.arrivingIn', { n: etaMin })
        : t('ride.driverOnWay')
      : ride.status === 'arrived'
        ? t('ride.driverHere')
        : etaMin != null
          ? t('ride.minTo', { n: etaMin, place: shortPlace(ride.dropoff) })
          : t('ride.headingTo', { place: shortPlace(ride.dropoff) });
  const VIcon = VEHICLE_ICON[ride.vehicleType];
  const PIcon = PAY_ICON[ride.payment.method] ?? Banknote;

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge tone={ride.status === 'ongoing' ? 'success' : 'accent'}>{STATUS_TEXT[ride.status]}</Badge>
          <h1 className="mt-2 font-display text-title font-bold">{heading}</h1>
        </div>
        <Button variant="danger" size="sm" icon={Siren} onClick={() => setSosOpen(true)} aria-label={t('sos.aria')}>
          {t('sos.button')}
        </Button>
      </div>

      {/* Driver and vehicle: what you look for at the kerb. */}
      <Card flat className="space-y-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setDriverSheet(d.id)} className="shrink-0 rounded-[var(--radius-md)]" aria-label={tr('View {name}’s profile and reviews', { name: d.name })}>
            <Avatar src={d.avatar} name={d.name} size={52} />
          </button>
          <div className="min-w-0 flex-1">
            <button type="button" className="block truncate font-display text-heading font-bold hover:underline" onClick={() => setDriverSheet(d.id)}>
              {d.name}
            </button>
            <p className="text-small text-fg-2">
              <Stars value={d.rating} size={14} /> · {tr('{n} ratings', { n: d.ratingCount })}
            </p>
          </div>
          <ChatButton ride={ride} otherName={d.name} />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="flex min-w-0 items-center gap-2 text-small font-medium">
            <VIcon aria-hidden className="size-5 shrink-0" />
            <span className="truncate">{d.vehicle.model}</span>
          </span>
          <Plate plate={d.vehicle.plate} />
        </div>
      </Card>

      {ride.status !== 'ongoing' && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-ink p-4 text-[#f5f0e6]">
          <div className="min-w-0">
            <p className="text-small font-semibold">{tr('Start code')}</p>
            <p className="text-caption text-[#cfc6b4]">{tr('Tell your driver once you’re in.')}</p>
          </div>
          <OtpDigits otp={ride.otp} />
        </div>
      )}

      <RouteWatch ride={ride} role="rider" onSos={() => setSosOpen(true)} />
      <SafetyReminder ride={ride} />
      <WaterlogDelayLine ride={ride} />
      <DriverRest driver={ride.driver} />
      <RideExtras ride={ride} />

      <div className="grid grid-cols-2 gap-2">
        <ShareButton ride={ride} />
        {ride.status !== 'ongoing' ? (
          <Button variant="outline" icon={X} onClick={() => setCancelOpen(true)}>
            {tr('Cancel ride')}
          </Button>
        ) : (
          <Button as={Link} variant="outline" icon={LifeBuoy} to={`/help?ride=${ride.id}`}>
            {tr('Get help')}
          </Button>
        )}
      </div>

      <Card flat className="space-y-3">
        <TripRoute ride={ride} />
        <div className="flex items-center justify-between border-t border-line pt-3 text-small">
          <span className="flex items-center gap-2 text-fg-2">
            <PIcon aria-hidden className="size-4" />
            {PAID_VIA[ride.payment.method].label}
          </span>
          <span className="font-display text-heading font-bold tabular-nums">{rupees(ride.price.fare)}</span>
        </div>
      </Card>

      <TripRecorder ride={ride} role="rider" />

      <DriverSheet driverId={driverSheet} onClose={() => setDriverSheet(null)} />
      <CancelModal ride={ride} open={cancelOpen} onClose={() => setCancelOpen(false)} onRide={onRide} />
      <SosModal ride={ride} open={sosOpen} onClose={() => setSosOpen(false)} />
    </div>
  );
}

function Searching({ ride, onCancel, cancelModal }) {
  const elapsed = useElapsed(ride.createdAt);
  const VIcon = VEHICLE_ICON[ride.vehicleType];
  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center gap-4 pt-1">
        <div className="relative grid size-20 shrink-0 place-items-center" aria-hidden>
          <Anim name="searching" size={80} loop className="absolute inset-0" />
          <span className="relative grid size-12 place-items-center rounded-full bg-accent text-accent-fg ring-4 ring-surface">
            <VIcon className="size-6" />
          </span>
        </div>
        <div role="status" aria-live="polite" className="min-w-0">
          <h1 className="font-display text-title font-bold">{tr('Finding your {vehicle}', { vehicle: VEHICLE_META[ride.vehicleType].label.toLowerCase() })}</h1>
          <p className="text-small tabular-nums text-fg-2">
            {tr('Asking drivers near {place}', { place: shortPlace(ride.pickup) })} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </p>
        </div>
      </div>
      {/* Where the driver card will appear. */}
      <div aria-hidden className="flex items-center gap-3 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
        <Skeleton width={52} height={52} radius="var(--radius-md)" />
        <span className="flex-1">
          <Skeleton width="50%" height={18} />
          <Skeleton width="70%" height={12} className="mt-2" />
        </span>
        <Skeleton width={84} height={28} radius="var(--radius-xs)" />
      </div>
      <StationPlace ride={ride} />
      <Card flat className="space-y-3">
        <TripRoute ride={ride} />
        <div className="flex justify-between border-t border-line pt-3 text-small">
          <span className="text-fg-2">{PAID_VIA[ride.payment.method].label}</span>
          <span className="font-display text-heading font-bold tabular-nums">{rupees(ride.price.fare)}</span>
        </div>
      </Card>
      <Button variant="outline" size="lg" block onClick={onCancel}>
        {tr('Cancel request')}
      </Button>
      {cancelModal}
    </div>
  );
}

const CANCEL_REASONS = ['Driver is taking too long', 'Changed my plans', 'Booked by mistake', 'Driver asked me to cancel', 'Found another ride'];

function CancelModal({ ride, open, onClose, onRide }) {
  const [fee, setFee] = useState(null);
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [busy, run] = useAction();
  useEffect(() => {
    if (!open) return;
    setFee(null);
    api(`/rides/${ride.id}/cancel-fee`)
      .then((r) => setFee(r.fee))
      .catch(() => setFee(0));
  }, [open, ride.id]);
  const confirm = () =>
    run(async () => {
      const res = await post(`/rides/${ride.id}/cancel`, { reason });
      onRide(res.ride);
      onClose();
    });
  return (
    <Modal open={open} onClose={onClose} title={tr('Cancel this ride?')}>
      <div className="space-y-4">
        {fee === null ? (
          <Skeleton height={44} radius="var(--radius-md)" />
        ) : fee > 0 ? (
          <p className="rounded-[var(--radius-md)] bg-danger-soft p-3 text-small text-danger">
            {tr('Your driver is already on the way, so a {amount} cancellation fee applies.', { amount: rupees(fee) })}
          </p>
        ) : (
          <p className="rounded-[var(--radius-md)] bg-success-soft p-3 text-small text-success">{tr('Free cancellation — no fee right now.')}</p>
        )}
        {ride.status !== 'requested' && (
          <fieldset>
            <legend className="mb-1 text-small font-semibold">{tr('Why are you cancelling?')}</legend>
            {CANCEL_REASONS.map((r) => (
              <label key={r} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-2 text-small hover:bg-raised">
                <input type="radio" name="reason" className="size-5 accent-[var(--fg)]" checked={reason === r} onChange={() => setReason(r)} /> {tr(r)}
              </label>
            ))}
          </fieldset>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tr('Keep ride')}
          </Button>
          <Button variant="danger" onClick={confirm} loading={busy} disabled={fee === null}>
            {tr('Cancel')}{fee > 0 ? ` · ${rupees(fee)}` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ShareButton({ ride }) {
  const url = `${window.location.origin}/track/${ride.shareToken}`;
  const share = async () => {
    const text = `Track my Hopin ride live (${ride.driver?.vehicle.plate}):`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'My Hopin trip', text, url });
        return;
      } catch {
        /* dismissed - fall through to copying */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(tr('Live tracking link copied.'), 'ok');
    } catch {
      toast(url);
    }
  };
  return (
    <Button variant="outline" icon={Share2} onClick={share}>
      {tr('Share trip')}
    </Button>
  );
}

function SosModal({ ride, open, onClose }) {
  const t = useT();
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  useEffect(() => {
    if (!open) setResult(null);
  }, [open]);

  const trigger = () =>
    run(async () => {
      const location = await getBrowserLocation(4000);
      setResult(await post('/sos', { rideId: ride.id, location }));
    });

  const smsHref = useMemo(() => {
    if (!result) return null;
    const numbers = result.contacts.map((c) => c.phone).join(',');
    // iOS uses `&body=`, Android accepts `?body=`; `?&body=` works on both.
    return `sms:${numbers}?&body=${encodeURIComponent(result.message)}`;
  }, [result]);

  return (
    <Modal open={open} onClose={onClose} title={t('sos.title')}>
      {!result ? (
        <div className="space-y-4">
          <p className="text-small text-fg-2">{t('sos.intro')}</p>
          <Button variant="danger" size="lg" block icon={Siren} loading={busy} onClick={trigger}>
            {t('sos.send')}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button as="a" variant="outline" icon={Phone} href="tel:112">
              {t('sos.police')}
            </Button>
            <Button as="a" variant="outline" icon={Ambulance} href="tel:108">
              {t('sos.ambulance')}
            </Button>
          </div>
          <p className="text-center text-caption text-fg-2">{t('sos.callHint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="flex items-center gap-2 rounded-[var(--radius-md)] bg-success-soft p-3 text-small font-semibold text-success">
            <CircleCheck aria-hidden className="size-5 shrink-0" />
            {t('sos.alerted')}
          </p>
          {result.smsResults?.length > 0 && (
            <ul className="space-y-1 rounded-[var(--radius-md)] bg-raised p-3 text-small">
              {result.smsResults.map((s) => (
                <li key={s.phone} className={s.status === 'failed' ? 'text-danger' : ''}>
                  {s.status === 'failed' ? t('sos.textFailed', { name: s.name }) : t('sos.textSent', { name: s.name })}
                </li>
              ))}
            </ul>
          )}
          <Button as="a" variant="danger" size="lg" block icon={Phone} href={`tel:${result.emergencyNumber}`}>
            {t('sos.callPolice', { number: result.emergencyNumber })}
          </Button>
          <Button as="a" variant="outline" block icon={Ambulance} href="tel:108">
            {t('sos.callAmbulance')}
          </Button>
          {result.contacts.length > 0 ? (
            <>
              <Button as="a" variant="secondary" block icon={MessageSquareText} href={smsHref}>
                {t('sos.textContacts', { names: result.contacts.map((c) => c.name).join(', ') })}
              </Button>
              {result.contacts.map((c) => (
                <Button key={c.phone} as="a" variant="outline" block icon={Phone} href={`tel:${c.phone}`}>
                  {t('sos.call', { name: c.name })}
                </Button>
              ))}
            </>
          ) : (
            <p className="text-small text-fg-2">
              {t('sos.noContacts')}{' '}
              <Link className="font-semibold text-fg underline" to="/profile">
                {t('sos.addInProfile')}
              </Link>{' '}
              {t('sos.soCanMessage')}
            </p>
          )}
          <Button variant="ghost" block icon={Copy} onClick={() => navigator.clipboard?.writeText(result.trackUrl).then(() => toast(t('sos.copied'), 'ok'))}>
            {t('sos.copyLink')}
          </Button>
        </div>
      )}
    </Modal>
  );
}
