import { useEffect, useState } from 'react';
import { Accessibility, Banknote, Construction, CreditCard, Ear, Eye, HandHelping, Lock, MessageSquareText, Package, Timer, UserRound, Wallet } from 'lucide-react';
import { api, post } from '../api.js';
import { useSession } from '../session.jsx';
import { payWithRazorpay, useFeatures } from './RideBits.jsx';
import { ErrorNote, Modal, toast, useAction } from './ui.jsx';
import { Button, Card, Chip, Input, Notice, Skeleton } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { PAYMENT_META, VEHICLE_META, rupees } from '../util.js';

// --- the three ways to book ------------------------------------------------------------

export const MODES = { trip: 'Ride', rental: 'Rental', parcel: 'Parcel' };

// --- who's riding -------------------------------------------------------------------------

/** Me, a family member, or anyone by name and number. `value` is null (me) or { name, phone }. */
export function PassengerPicker({ value, onChange }) {
  const [family, setFamily] = useState([]);
  const [other, setOther] = useState(false);
  useEffect(() => {
    api('/family')
      .then((d) => setFamily(d.members.map((m) => m.person)))
      .catch(() => {});
  }, []);
  const someone = other || (value && !family.some((f) => f.phone === value.phone));
  return (
    <div className="space-y-2">
      <p className="text-small font-semibold">Who’s riding?</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Who's riding?">
        <Chip role="radio" aria-checked={!value && !other} selected={!value && !other} icon={UserRound} onClick={() => (setOther(false), onChange(null))}>
          Me
        </Chip>
        {family.map((f) => (
          <Chip key={f.id} role="radio" aria-checked={value?.phone === f.phone} selected={value?.phone === f.phone} onClick={() => (setOther(false), onChange({ name: f.name, phone: f.phone }))}>
            {f.name.split(' ')[0]}
          </Chip>
        ))}
        <Chip role="radio" aria-checked={Boolean(someone)} selected={Boolean(someone)} onClick={() => (setOther(true), onChange({ name: '', phone: '' }))}>
          Someone else
        </Chip>
      </div>
      {someone && (
        <div className="grid grid-cols-2 gap-2">
          <Input id="passenger-name" label="Their name" value={value?.name ?? ''} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          <Input id="passenger-phone" label="Their mobile" inputMode="tel" value={value?.phone ?? ''} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
        </div>
      )}
      {value && <p className="text-caption text-fg-2">They get the driver’s details and their own start code by SMS. The driver sees their name, not their number.</p>}
    </div>
  );
}

// --- accessibility -------------------------------------------------------------------------

export const ACCESSIBILITY = {
  wheelchair: 'Folding wheelchair (Cab only)',
  assistance: 'Help getting in and out',
  hearing: 'Deaf or hard of hearing',
  vision: 'Blind or low vision',
};
const ACCESSIBILITY_ICON = { wheelchair: Accessibility, assistance: HandHelping, hearing: Ear, vision: Eye };

export function AccessibilityPicker({ value, onChange }) {
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-small font-semibold">Accessibility needs</legend>
      {Object.entries(ACCESSIBILITY).map(([k, label]) => {
        const Icon = ACCESSIBILITY_ICON[k];
        return (
          <label key={k} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-1 text-small hover:bg-raised">
            <input type="checkbox" className="size-5 accent-[var(--fg)]" checked={value.includes(k)} onChange={() => toggle(k)} />
            <Icon aria-hidden className="size-[18px] text-fg-2" />
            {label}
          </label>
        );
      })}
      <p className="pt-1 text-caption text-fg-2">Shown to drivers before they accept.</p>
    </fieldset>
  );
}

// --- parcels ---------------------------------------------------------------------------------

export const PARCEL_SIZES = {
  small: { label: 'Small (fits in a bag)', vehicles: ['bike', 'auto', 'car'] },
  medium: { label: 'Medium (up to a suitcase)', vehicles: ['auto', 'car'] },
  large: { label: 'Large (needs a boot)', vehicles: ['car'] },
};

export const emptyParcel = { receiverName: '', receiverPhone: '', item: '', size: 'small', confirmAllowed: false };
export const parcelReady = (p) => p.receiverName.trim().length >= 2 && p.receiverPhone.trim().length >= 10 && p.item.trim().length >= 3 && p.confirmAllowed;

export function ParcelForm({ value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Input id="parcel-receiver" label="Receiver’s name" value={value.receiverName} onChange={set('receiverName')} />
        <Input id="parcel-phone" label="Receiver’s mobile" inputMode="tel" value={value.receiverPhone} onChange={set('receiverPhone')} />
      </div>
      <Input id="parcel-item" label="What are you sending?" placeholder="Documents, a laptop bag" maxLength={120} value={value.item} onChange={set('item')} />
      <div className="space-y-1.5">
        <label htmlFor="parcel-size" className="text-small font-semibold">
          Size
        </label>
        <select id="parcel-size" className="input" value={value.size} onChange={set('size')}>
          {Object.entries(PARCEL_SIZES).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-small">
        <input type="checkbox" checked={value.confirmAllowed} onChange={set('confirmAllowed')} className="mt-0.5 size-5 shrink-0 accent-[var(--fg)]" />
        No cash, jewellery, drugs, weapons, alcohol, live animals or anything illegal.
      </label>
      <p className="text-caption text-fg-2">The receiver gets a delivery code by SMS. The driver can only finish when they give it.</p>
    </div>
  );
}

// --- price lock -------------------------------------------------------------------------------

/** On a quote option: shows an active lock, or offers to buy one for this route and vehicle. */
export function PriceLockBox({ option, pickup, dropoff, onLocked }) {
  const { user, setUser } = useSession();
  const features = useFeatures();
  const [busy, run] = useAction();
  if (option?.lock) {
    return (
      <Notice icon={Lock} tone="success">
        <p className="font-semibold">
          Price locked at {rupees(option.lock.lockedFare)} until {new Date(option.lock.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          {option.price.lockSaving > 0 && ` · saving ${rupees(option.price.lockSaving)} now`}
        </p>
      </Notice>
    );
  }
  const offer = option?.lockOffer;
  if (!offer) return null;
  const body = { pickup, dropoff, vehicleType: option.type };
  const done = async () => {
    toast(`Locked at ${rupees(offer.lockedFare)} for ${offer.days} days.`, 'ok');
    const { user: fresh } = await api('/auth/me');
    setUser(fresh);
    onLocked();
  };
  return (
    <details className="group rounded-[var(--radius-lg)] ring-1 ring-line">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2 text-small [&::-webkit-details-marker]:hidden">
        <Lock aria-hidden className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-semibold">Lock {rupees(offer.lockedFare)}</span> for {offer.days} days
        </span>
        <span className="shrink-0 font-semibold underline underline-offset-4 group-open:hidden">{rupees(offer.fee)}</span>
      </summary>
      <div className="space-y-3 border-t border-line px-4 pb-4 pt-3 text-small">
        <p className="text-fg-2">
          Pay {rupees(offer.fee)} once and this route costs at most {rupees(offer.lockedFare)} for {offer.days} days. If the normal fare is lower, you pay that instead.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={Wallet} disabled={user.walletBalance < offer.fee} loading={busy} onClick={() => run(async () => (await post('/price-locks', body), done()))}>
            From wallet
          </Button>
          {features?.onlinePayments && (
            <Button size="sm" variant="outline" icon={CreditCard} disabled={busy} onClick={() => run(async () => (await payWithRazorpay({ kind: 'price_lock', ...body }), done()))}>
              Pay online
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}

// --- rentals -------------------------------------------------------------------------------------

/** Road closures (entered by admins from police notices) in force now or within a day. */
export function useClosures() {
  const [closures, setClosures] = useState([]);
  useEffect(() => {
    api('/rentals/closures')
      .then((d) => setClosures(d.closures))
      .catch(() => {});
  }, []);
  return closures;
}

export function ClosuresNote({ closures }) {
  if (!closures.length) return null;
  return (
    <Notice icon={Construction} tone="warning" title="Road closures">
      {closures.map((c) => (
        <p key={c.id}>
          <strong>{c.title}</strong> until {new Date(c.endsAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
          {c.note && ` · ${c.note}`} <span className="opacity-80">(source: {c.source})</span>
        </p>
      ))}
    </Notice>
  );
}

const RENTAL_PAY_ICON = { cash: Banknote, wallet: Wallet, card: CreditCard };

/** Pick an hourly package and book it from the chosen pickup. */
export function RentalPlanner({ pickup, onBooked }) {
  const { user } = useSession();
  const features = useFeatures();
  const [packages, setPackages] = useState(null);
  const [type, setType] = useState('car');
  const [chosen, setChosen] = useState(null);
  const [payment, setPayment] = useState(user.defaultPayment === 'upi' ? 'cash' : user.defaultPayment);
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  useEffect(() => {
    api('/rentals/packages')
      .then((d) => setPackages(d.packages))
      .catch(() => setPackages([]));
  }, []);
  if (!packages) {
    return (
      <div role="status" aria-busy="true" className="space-y-2">
        <span className="sr-only">Loading rental packages</span>
        <Skeleton height={48} radius="var(--radius-md)" />
        <Skeleton height={72} radius="var(--radius-lg)" />
        <Skeleton height={72} radius="var(--radius-lg)" />
      </div>
    );
  }
  const list = packages.filter((p) => p.vehicleType === type);
  const pkg = list.find((p) => p.id === chosen);
  const book = () =>
    run(async () => {
      setError('');
      try {
        const { ride } = await post('/rides', { kind: 'rental', packageId: pkg.id, pickup, vehicleType: type, paymentMethod: payment });
        onBooked(ride);
      } catch (err) {
        setError(err.message);
      }
    });
  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="radiogroup" aria-label="Vehicle">
        {['car', 'auto'].map((t) => (
          <Chip key={t} role="radio" aria-checked={type === t} selected={type === t} icon={VEHICLE_ICON[t]} onClick={() => (setType(t), setChosen(null))}>
            {VEHICLE_META[t].label}
          </Chip>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="text-small text-fg-2">No rental packages for this vehicle right now.</p>
      ) : (
        <div className="space-y-2" role="radiogroup" aria-label="Rental package">
          {list.map((p) => (
            <Card key={p.id} as="button" interactive role="radio" aria-checked={chosen === p.id} onClick={() => setChosen(p.id)} className="flex w-full items-center gap-3 !p-3.5 text-left">
              <span className={`grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] ${chosen === p.id ? 'bg-accent text-accent-fg' : 'bg-raised'}`}>
                <Timer aria-hidden className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-heading font-bold">{p.name}</span>
                  {p.seasonal && <span className="ds-badge ds-badge--accent">Puja special</span>}
                </span>
                <span className="block text-caption text-fg-2">
                  Then {rupees(p.extraKmRate)}/km and {rupees(p.extraMinRate)}/min
                </span>
              </span>
              <span className="font-display text-heading font-bold tabular-nums">{rupees(p.price)}</span>
            </Card>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <p className="text-small font-semibold">Pay with</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment method">
          {['cash', 'wallet', 'card'].map((m) => (
            <Chip
              key={m}
              role="radio"
              aria-checked={payment === m}
              selected={payment === m}
              icon={RENTAL_PAY_ICON[m]}
              disabled={m === 'card' && !features?.onlinePayments}
              onClick={() => setPayment(m)}
            >
              {m === 'wallet' ? rupees(user.walletBalance) : PAYMENT_META[m].label}
            </Chip>
          ))}
        </div>
      </div>
      <p className="text-caption text-fg-2">No fixed drop: the driver stays with you. Distance comes from the driver’s GPS; extra km and minutes are added at the end. No surge or promo codes on rentals.</p>
      <ErrorNote>{error}</ErrorNote>
      <Button variant="primary" size="lg" block loading={busy} disabled={!pkg || !pickup} onClick={book}>
        {pkg ? `Book ${pkg.name} · ${rupees(pkg.price)}` : 'Choose a package'}
      </Button>
    </div>
  );
}

// --- on the ride screens --------------------------------------------------------------------------

const smsLine = (sms, who) =>
  !sms ? null : sms.status === 'failed' || sms.status === 'not_sent' ? `We could not text ${who}. Please share the code with them yourself.` : `${who} was sent an SMS.`;

/** Rider's live ride: passenger, parcel code, rental meter, accessibility, a deaf driver. */
export function RideExtras({ ride }) {
  const startedMin = ride.startedAt ? Math.max(0, Math.round((Date.now() - new Date(ride.startedAt)) / 60_000)) : 0;
  return (
    <>
      {ride.driver?.deaf && (
        <Notice icon={Ear} tone="accent">
          Your driver is deaf or hard of hearing. Please use chat instead of calling.
        </Notice>
      )}
      {ride.passenger && (
        <Notice icon={UserRound}>
          Booked for <strong>{ride.passenger.name}</strong>. {smsLine(ride.passenger.sms, ride.passenger.name) ?? 'They will get the driver details by SMS once a driver accepts.'}
        </Notice>
      )}
      {ride.parcel && (
        <Notice icon={Package}>
          <p>
            {ride.parcel.item} to <strong>{ride.parcel.receiverName}</strong>
          </p>
          {ride.parcel.deliveryOtp && (
            <p>
              Delivery code <strong className="font-mono tracking-widest">{ride.parcel.deliveryOtp}</strong> (the receiver gives it to the driver)
            </p>
          )}
          {smsLine(ride.parcel.sms, ride.parcel.receiverName) && <p className="text-caption text-fg-2">{smsLine(ride.parcel.sms, ride.parcel.receiverName)}</p>}
        </Notice>
      )}
      {ride.rental && (
        <Notice icon={Timer}>
          <p>
            {ride.rental.name} · {rupees(ride.rental.price)}
            {ride.status === 'ongoing' && ` · ${startedMin} min so far of ${ride.rental.hours * 60}`}
          </p>
          <p className="text-caption text-fg-2">
            Extra: {rupees(ride.rental.extraKmRate)}/km over {ride.rental.km} km, {rupees(ride.rental.extraMinRate)}/min over {ride.rental.hours} h.
          </p>
        </Notice>
      )}
      {ride.accessibility?.length > 0 && <p className="text-caption text-fg-2">Your requests: {ride.accessibility.map((a) => ACCESSIBILITY[a]).join(' · ')}</p>}
    </>
  );
}

/** Driver's view of the same: who to pick up, needs, parcel or rental details. */
export function DriverRideExtras({ ride }) {
  return (
    <>
      {ride.passenger && (
        <Notice icon={UserRound}>
          Pick up <strong>{ride.passenger.name}</strong> (booked by {ride.rider.name}). Ask them for the start code.
        </Notice>
      )}
      {ride.accessibility?.length > 0 && (
        <Notice icon={Accessibility} tone="accent">
          <strong>Rider needs:</strong> {ride.accessibility.map((a) => ACCESSIBILITY[a]).join(' · ')}
        </Notice>
      )}
      {ride.parcel && (
        <Notice icon={Package}>
          Parcel: {ride.parcel.item} ({PARCEL_SIZES[ride.parcel.size].label}) for <strong>{ride.parcel.receiverName}</strong>. Get the delivery code from the receiver at the drop.
        </Notice>
      )}
      {ride.rental && <Notice icon={Timer}>Rental: {ride.rental.name}. No fixed drop; stay with the rider. Your GPS measures the distance, so keep location on.</Notice>}
    </>
  );
}

// --- message cards (deaf drivers, or anyone who can't talk right now) ------------------------------------

const CARDS = [
  'I am deaf or hard of hearing. Please type in the Hopin chat.',
  'Please show me the address on your phone.',
  'We have arrived.',
  'Please tell me the 4-digit start code.',
  'Please wear your seatbelt.',
  'Thank you!',
];

export function MessageCards() {
  const [card, setCard] = useState(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" icon={MessageSquareText} onClick={() => setOpen(true)}>
        Show a message
      </Button>
      <Modal open={open} onClose={() => (setOpen(false), setCard(null))} title={card ? 'Show this to the rider' : 'Show a message'} wide>
        {card ? (
          <button
            type="button"
            className="w-full rounded-[var(--radius-lg)] bg-ink p-6 text-left font-display text-[2rem] font-bold leading-snug text-[#f5f0e6] sm:text-[2.5rem]"
            onClick={() => setCard(null)}
          >
            {card}
          </button>
        ) : (
          <div className="grid gap-2">
            {CARDS.map((c) => (
              <Button key={c} variant="outline" className="!h-auto min-h-12 !justify-start whitespace-normal py-3 text-left" onClick={() => setCard(c)}>
                {c}
              </Button>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
