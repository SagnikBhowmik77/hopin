import { useEffect, useState } from 'react';
import {
  ArrowRight, Bike, Car, CarTaxiFront, CircleCheck, CloudRain, CreditCard, IndianRupee, LocateFixed, LocateOff, MapPin, Monitor, Moon, Phone, Plus, Search,
  SearchX, Share2, ShieldCheck, Smartphone, Star, Sun, Wallet, WifiOff, X, History, Package, Timer,
} from 'lucide-react';
import { Avatar, Badge, BottomSheet, Button, Card, Chip, EmptyState, IconButton, Input, Loading, Modal, Skeleton, SkeletonText, Switch, Tabs, ToastView, Toaster, setTheme, toast, useTheme } from '../ds/index.js';
import MapView from '../components/MapView.jsx';
import { rupees } from '../util.js';

/**
 * /design-preview (development only): every token and component of the Hopin design system,
 * in all states, with real content. Not linked from the app.
 */

const PARK_STREET = { lat: 22.5535, lng: 88.3525, address: 'Park Street, Kolkata' };
const SECTOR_V = { lat: 22.5726, lng: 88.4339, address: 'Salt Lake Sector V, Kolkata' };

const COLOURS = [
  ['ground', 'Page ground'],
  ['surface', 'Cards, sheets'],
  ['raised', 'Inputs, quiet fills'],
  ['line', 'Dividers'],
  ['line-strong', 'Control borders'],
  ['fg', 'Text'],
  ['fg-2', 'Secondary text'],
  ['fg-3', 'Placeholders'],
  ['accent', 'Taxi yellow: main action'],
  ['accent-soft', 'Accent tint'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Danger'],
];

// WCAG contrast from computed colours, so the numbers shown are the real rendered ones.
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function cssColor(name) {
  const probe = document.createElement('span');
  probe.style.color = `var(--${name})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  probe.remove();
  return rgb;
}
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
function contrast(a, b) {
  const [x, y] = [luminance(cssColor(a)), luminance(cssColor(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function Section({ id, title, note, children }) {
  return (
    <section id={id} className="border-t border-line py-10 first:border-t-0">
      <h2 className="font-display text-title font-bold">{title}</h2>
      {note && <p className="mt-2 max-w-[62ch] text-small text-fg-2">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Swatches({ theme }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const t = setTimeout(() => {
      setRows(
        COLOURS.map(([name, use]) => ({
          name,
          use,
          hex: toHex(cssColor(name)),
          onGround: name.startsWith('fg') || ['success', 'warning', 'danger'].includes(name) ? contrast(name, 'ground') : null,
          onSurface: name.startsWith('fg') || ['success', 'warning', 'danger'].includes(name) ? contrast(name, 'surface') : null,
        })),
      );
    }, 30);
    return () => clearTimeout(t);
  }, [theme]);
  const pairs = [
    ['Text on accent (button label)', 'accent-fg', 'accent'],
    ['Text on ground', 'fg', 'ground'],
    ['Secondary text on raised', 'fg-2', 'raised'],
    ['Placeholder on surface', 'fg-3', 'surface'],
    ['Control border on surface (UI, needs 3:1)', 'line-strong', 'surface'],
    ['Danger text on danger tint', 'danger', 'danger-soft'],
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.name} className="overflow-hidden rounded-[var(--radius-md)] bg-surface">
            <div className="h-16 border-b border-line" style={{ background: `var(--${r.name})` }} />
            <div className="p-3 text-small">
              <p className="font-semibold">{r.name}</p>
              <p className="text-caption text-fg-2">{r.use}</p>
              <p className="mt-1 font-mono text-caption text-fg-2">{r.hex}</p>
              {r.onGround && (
                <p className="mt-1 text-caption">
                  on ground {r.onGround.toFixed(1)}:1 · on surface {r.onSurface.toFixed(1)}:1
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 overflow-hidden rounded-[var(--radius-md)] bg-surface">
        {pairs.map(([label, a, b]) => {
          const ratio = rows.length ? contrast(a, b) : 0;
          const need = label.includes('3:1') ? 3 : 4.5;
          return (
            <div key={label} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 text-small last:border-b-0">
              <span className="flex items-center gap-3">
                <span className="grid h-9 w-14 shrink-0 place-items-center rounded-[var(--radius-xs)] font-semibold" style={{ background: `var(--${b})`, color: `var(--${a})`, border: '1px solid var(--line)' }}>
                  Aa
                </span>
                {label}
              </span>
              <Badge tone={ratio >= need ? 'success' : 'danger'} icon={ratio >= need ? CircleCheck : X}>
                {ratio.toFixed(2)}:1 {ratio >= need ? 'AA' : 'fails'}
              </Badge>
            </div>
          );
        })}
      </div>
    </>
  );
}

const STATES = [undefined, 'hover', 'focus', 'active'];
const STATE_LABEL = { undefined: 'Default', hover: 'Hover', focus: 'Focus', active: 'Pressed' };

function ButtonMatrix() {
  const variants = [
    ['primary', 'Book Cab'],
    ['secondary', 'Confirm pickup'],
    ['outline', 'Schedule'],
    ['ghost', 'Cancel ride'],
    ['danger', 'Send SOS'],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-y-3 text-left">
        <thead>
          <tr className="text-caption text-fg-2">
            <th className="w-24 font-semibold">Variant</th>
            {[...STATES.map((s) => STATE_LABEL[s]), 'Disabled', 'Loading'].map((h) => (
              <th key={h} className="font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {variants.map(([v, text]) => (
            <tr key={v}>
              <td className="text-small font-semibold capitalize">{v}</td>
              {STATES.map((s) => (
                <td key={String(s)}>
                  <Button variant={v} state={s} size="sm">
                    {text}
                  </Button>
                </td>
              ))}
              <td>
                <Button variant={v} size="sm" disabled>
                  {text}
                </Button>
              </td>
              <td>
                <Button variant={v} size="sm" loading>
                  {text}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RideOption({ icon: Icon, name, note, eta, fare, selected, onSelect, state }) {
  return (
    <Card as="button" interactive state={state} aria-pressed={selected} onClick={onSelect} className="flex items-center gap-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] bg-raised">
        <Icon aria-hidden className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-heading font-bold leading-tight">{name}</span>
        <span className="block text-small text-fg-2">
          {eta} away · {note}
        </span>
      </span>
      <span className="font-display text-heading font-bold tabular-nums">{rupees(fare)}</span>
    </Card>
  );
}

function SheetDemo() {
  const [choice, setChoice] = useState('car');
  const options = [
    { id: 'bike', icon: Bike, name: 'Bike', note: '1 rider', eta: '3 min', fare: 56 },
    { id: 'auto', icon: CarTaxiFront, name: 'Auto', note: 'Up to 3', eta: '5 min', fare: 92 },
    { id: 'car', icon: Car, name: 'Cab', note: 'AC, up to 4', eta: '6 min', fare: 184 },
  ];
  const picked = options.find((o) => o.id === choice);
  return (
    <div className="relative mx-auto h-[680px] w-full max-w-[390px] overflow-hidden rounded-[var(--radius-xl)] border border-line bg-raised">
      <div className="absolute inset-0">
        <MapView pickup={PARK_STREET} dropoff={SECTOR_V} route={[[22.5535, 88.3525], [22.5626, 88.3911], [22.5726, 88.4339]]} />
      </div>
      <div className="absolute right-4 top-4" style={{ zIndex: 500 }}>
        <IconButton icon={LocateFixed} label="Centre on my location" variant="float" />
      </div>
      <BottomSheet
        label="Choose a ride"
        snaps={[150, 0.56, 0.9]}
        initialSnap={1}
        panelFrom="(min-width: 99999px)"
        header={
          <div>
            <h3 className="font-display text-title font-bold">Choose a ride</h3>
            <p className="text-small text-fg-2">Park Street → Salt Lake Sector V · 9.4 km</p>
          </div>
        }
        footer={
          <div className="flex items-center gap-4">
            <div className="shrink-0">
              <p className="whitespace-nowrap text-caption text-fg-2">Cash</p>
              <p className="font-display text-title font-bold tabular-nums">{rupees(picked.fare)}</p>
            </div>
            <Button variant="primary" size="lg" block iconRight={ArrowRight}>
              Book {picked.name}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <RideOption key={o.id} {...o} selected={choice === o.id} onSelect={() => setChoice(o.id)} />
          ))}
          <p className="pt-2 text-caption text-fg-2">Fares include tolls and taxes. Waiting after 3 minutes is ₹2 a minute.</p>
        </div>
      </BottomSheet>
    </div>
  );
}

export default function DesignPreview() {
  const [theme, resolved] = useTheme();
  const [tab, setTab] = useState('trip');
  const [share, setShare] = useState(true);
  const [tip, setTip] = useState(30);
  const [modal, setModal] = useState(false);
  const [phone, setPhone] = useState('98300 41275');

  return (
    <div className="min-h-full bg-ground text-fg">
      <Toaster />
      <header className="sticky top-0 border-b border-line bg-ground" style={{ zIndex: 'var(--z-header)' }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <p className="font-display text-heading font-bold">
            Hopin <span className="font-sans font-medium text-fg-2">design system</span>
          </p>
          <Tabs
            label="Theme"
            value={theme}
            onChange={setTheme}
            className="w-full sm:w-[300px]"
            items={[
              { id: 'system', label: 'Auto', icon: Monitor },
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'dark', label: 'Dark', icon: Moon },
            ]}
          />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-8">
        <div className="py-12">
          <h1 className="font-display text-display font-extrabold tracking-[-0.035em]">Yellow taxi, rebuilt for a phone.</h1>
          <p className="mt-4 max-w-[56ch] text-body text-fg-2">
            One accent, warm ink on warm paper, big type for bright sun and one-handed use. Every token and component Hopin screens are built from, in every state, shown here in{' '}
            {resolved} mode.
          </p>
        </div>

        <Section id="colour" title="Colour" note="Taxi yellow is the only accent and marks the main action on a screen. Ink and warm paper do everything else. Ratios are measured from the rendered colours.">
          <Swatches theme={resolved} />
        </Section>

        <Section id="type" title="Type" note="Bricolage Grotesque for headings, Mukta for everything you read. Mukta also carries Hindi, so both languages share one voice. Body text is 17px for outdoor reading.">
          <div className="space-y-5">
            <div>
              <p className="text-caption text-fg-2">Display · Bricolage 800 · 36–64px</p>
              <p className="font-display text-display font-extrabold tracking-[-0.035em]">Rides that just show up.</p>
            </div>
            <div>
              <p className="text-caption text-fg-2">Title · 26px</p>
              <p className="font-display text-title font-bold">Rakesh is 4 min away</p>
            </div>
            <div>
              <p className="text-caption text-fg-2">Heading · 20px</p>
              <p className="font-display text-heading font-bold">Choose a ride</p>
            </div>
            <div>
              <p className="text-caption text-fg-2">Body · Mukta 17px</p>
              <p className="max-w-[60ch] text-body">Your driver will wait at the Park Street Metro gate. Share the 4-digit code only once you are inside the cab.</p>
            </div>
            <div>
              <p className="text-caption text-fg-2">Small · 15px</p>
              <p className="text-small text-fg-2">Cash · upfront fare · ₹1,240 this month</p>
            </div>
            <div>
              <p className="text-caption text-fg-2">Hindi · same faces</p>
              <p className="font-display text-title font-bold">ड्राइवर रास्ते में हैं</p>
              <p className="text-body">आपका ड्राइवर पार्क स्ट्रीट मेट्रो गेट पर इंतज़ार करेगा।</p>
            </div>
          </div>
        </Section>

        <Section id="space" title="Space, radius, elevation, motion" note="A 4px grid. Controls use the 14px radius everywhere; sheets 28px. Shadows only on things that float above the map. Movement is under 250ms and switches off with reduced motion.">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-2">
              {[4, 8, 12, 16, 20, 24, 32, 40, 48, 64].map((px) => (
                <div key={px} className="flex items-center gap-3 text-caption">
                  <span className="w-10 text-fg-2 tabular-nums">{px}px</span>
                  <span className="h-3 rounded-[2px] bg-fg" style={{ width: px * 3 }} />
                </div>
              ))}
            </div>
            <div className="space-y-6">
              <div className="flex flex-wrap gap-3">
                {['xs', 'sm', 'md', 'lg', 'xl'].map((r) => (
                  <div key={r} className="grid size-20 place-items-center border-2 border-fg text-caption font-semibold" style={{ borderRadius: `var(--radius-${r})` }}>
                    {r}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-4 rounded-[var(--radius-lg)] bg-raised p-5">
                {[
                  ['float', 'Map controls'],
                  ['sheet', 'Bottom sheet'],
                  ['dialog', 'Dialog, toast'],
                ].map(([s, label]) => (
                  <div key={s} className="grid h-20 w-28 place-items-center rounded-[var(--radius-md)] bg-surface p-2 text-center text-caption" style={{ boxShadow: `var(--shadow-${s})` }}>
                    {label}
                  </div>
                ))}
              </div>
              <ul className="space-y-1 text-small">
                <li>
                  <strong>120ms</strong> fast · presses, hovers
                </li>
                <li>
                  <strong>180ms</strong> base · toasts, tabs, fades
                </li>
                <li>
                  <strong>240ms</strong> slow · sheets and dialogs (ease-out 0.16, 1, 0.3, 1)
                </li>
              </ul>
            </div>
          </div>
        </Section>

        <Section id="buttons" title="Buttons" note="Primary is taxi yellow and appears once per screen. Every button is at least 44px tall. Loading keeps the width and blocks a second tap.">
          <ButtonMatrix />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" iconRight={ArrowRight}>
              Book Cab · {rupees(184)}
            </Button>
            <Button variant="secondary" icon={Wallet}>
              Pay {rupees(1240)}
            </Button>
            <Button variant="outline" size="sm" icon={Plus}>
              Add stop
            </Button>
            <IconButton icon={Phone} label="Call driver" variant="outline" />
            <IconButton icon={Share2} label="Share trip" variant="outline" />
            <IconButton icon={LocateFixed} label="Centre on my location" variant="float" />
          </div>
        </Section>

        <Section id="inputs" title="Inputs" note="52px tall, 3:1 borders, label always visible above the field. Errors say what to do, sit under the field and are announced.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Input label="Where to?" placeholder="Search a place or address" prefix={<Search />} />
            <Input label="Pickup" defaultValue="Park Street Metro, Gate 2" prefix={<MapPin />} state="hover" hint="Hover" />
            <Input label="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} prefix="+91" state="focus" hint="We text your code to this number." />
            <Input label="Tip amount" defaultValue="15" prefix={<IndianRupee />} error="Tips start at ₹20." />
            <Input label="Promo code" placeholder="KOLKATA50" disabled hint="Promo codes are not available for business rides." />
            <Input label="Note for the driver" optional multiline placeholder="Blue gate next to the pharmacy" />
          </div>
        </Section>

        <Section id="cards" title="Cards, badges, chips, avatars">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-2">
              <RideOption icon={Bike} name="Bike" note="1 rider" eta="3 min" fare={56} selected={false} onSelect={() => {}} />
              <RideOption icon={CarTaxiFront} name="Auto" note="Up to 3" eta="5 min" fare={92} selected={false} state="hover" onSelect={() => {}} />
              <RideOption icon={Car} name="Cab" note="AC, up to 4" eta="6 min" fare={184} selected onSelect={() => {}} />
              <Card flat className="mt-4 flex items-center gap-3">
                <Avatar name="Rakesh Mondal" size={52} />
                <div className="min-w-0 flex-1">
                  <p className="font-display text-heading font-bold">Rakesh Mondal</p>
                  <p className="text-small text-fg-2">
                    <Star aria-hidden className="mb-0.5 inline size-4 fill-current" /> 4.9 · Maruti Dzire · <span className="font-semibold text-fg">WB 04 K 2211</span>
                  </p>
                </div>
              </Card>
            </div>
            <div className="space-y-6">
              <div className="flex flex-wrap gap-2">
                <Badge tone="accent">Driver on the way</Badge>
                <Badge tone="success" icon={CircleCheck}>
                  Paid
                </Badge>
                <Badge tone="warning" icon={CloudRain}>
                  Knee-deep water ahead
                </Badge>
                <Badge tone="danger">Payment due</Badge>
                <Badge>Scheduled · 7:30 am</Badge>
              </div>
              <div>
                <p className="mb-2 text-small font-semibold">Add a tip for Rakesh</p>
                <div className="flex flex-wrap gap-2">
                  {[20, 30, 50].map((v) => (
                    <Chip key={v} selected={tip === v} onClick={() => setTip(v)}>
                      {rupees(v)}
                    </Chip>
                  ))}
                  <Chip state="hover">Other</Chip>
                  <Chip disabled>{rupees(100)}</Chip>
                </div>
              </div>
              <div className="flex items-end gap-3">
                <Avatar name="Rakesh Mondal" size={64} />
                <Avatar name="Asha Devi" size={52} />
                <Avatar name="Sagnik Bhowmik" size={44} />
                <Avatar name="Imran Sheikh" size={32} />
              </div>
            </div>
          </div>
        </Section>

        <Section id="tabs" title="Tabs and switches">
          <div className="grid gap-6 sm:grid-cols-2">
            <Tabs
              label="Booking type"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'trip', label: 'Ride', icon: Car },
                { id: 'rental', label: 'Rental', icon: Timer },
                { id: 'parcel', label: 'Parcel', icon: Package },
              ]}
            />
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-surface px-4 py-2">
              <span>
                <span className="block font-semibold">Share trips with family</span>
                <span className="block text-caption text-fg-2">Asha sees your live location on every ride</span>
              </span>
              <Switch checked={share} onChange={setShare} label="Share trips with family" />
            </div>
          </div>
        </Section>

        <Section id="feedback" title="Toasts and loading" note="Content loads into skeletons shaped like what is coming, not spinners.">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-3">
              <ToastView tone="success" message="Payment of ₹184 received. Your receipt is in Trips." onClose={() => {}} />
              <ToastView tone="info" message="Rakesh has arrived at Park Street Metro, Gate 2." />
              <ToastView tone="error" message="We could not reach the payment server. You have not been charged." onClose={() => {}} />
              <div className="flex flex-wrap gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={() => toast('Driver assigned: Rakesh, WB 04 K 2211', 'success')}>
                  Show success toast
                </Button>
                <Button size="sm" variant="outline" onClick={() => toast('No internet. We will retry when you are back online.', 'error')}>
                  Show error toast
                </Button>
              </div>
            </div>
            <Loading label="Finding rides near you">
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-4 rounded-[var(--radius-lg)] bg-surface p-4">
                    <Skeleton width={48} height={48} radius="var(--radius-md)" />
                    <div className="flex-1">
                      <Skeleton width="40%" height={16} />
                      <Skeleton width="65%" height={12} className="mt-2" />
                    </div>
                    <Skeleton width={56} height={20} />
                  </div>
                ))}
                <div className="rounded-[var(--radius-lg)] bg-surface p-4">
                  <SkeletonText lines={3} />
                </div>
              </div>
            </Loading>
          </div>
        </Section>

        <Section id="states" title="Empty and error states" note="Each one says what happened and what to do next, with one action.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <EmptyState icon={SearchX} title="No drivers nearby" action={<Button variant="primary">Try again</Button>}>
                Every Cab near Park Street is busy. Autos are 4 minutes away.
              </EmptyState>
            </Card>
            <Card>
              <EmptyState icon={LocateOff} tone="warning" title="Location is off" action={<Button variant="secondary">Turn on location</Button>}>
                Hopin needs your location to find the nearest driver.
              </EmptyState>
            </Card>
            <Card>
              <EmptyState icon={CreditCard} tone="danger" title="Payment didn’t go through" action={<Button variant="secondary">Pay {rupees(184)} again</Button>}>
                Your bank declined the card. You have not been charged.
              </EmptyState>
            </Card>
            <Card>
              <EmptyState icon={WifiOff} title="You’re offline" action={<Button variant="outline">Retry</Button>}>
                Your ride is safe. We’ll update it as soon as you’re back online.
              </EmptyState>
            </Card>
            <Card>
              <EmptyState icon={History} title="No trips yet" action={<Button variant="primary">Book your first ride</Button>}>
                Rides you take will show up here with their receipts.
              </EmptyState>
            </Card>
            <Card>
              <EmptyState
                icon={ShieldCheck}
                title="You’re all set"
                action={
                  <Button variant="outline" icon={Smartphone}>
                    Add emergency contact
                  </Button>
                }
              >
                SOS shares your live location with the Hopin safety team.
              </EmptyState>
            </Card>
          </div>
        </Section>

        <Section id="modal" title="Dialog">
          <Button variant="outline" onClick={() => setModal(true)}>
            Open “Cancel ride” dialog
          </Button>
          <Modal
            open={modal}
            onClose={() => setModal(false)}
            title="Cancel this ride?"
            description="Rakesh is 2 minutes away. Cancelling now costs ₹25."
            footer={
              <>
                <Button variant="ghost" onClick={() => setModal(false)}>
                  Keep ride
                </Button>
                <Button variant="danger" onClick={() => setModal(false)}>
                  Cancel for {rupees(25)}
                </Button>
              </>
            }
          >
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-raised p-3">
              <Avatar name="Rakesh Mondal" size={44} />
              <p className="text-small">
                <strong>Rakesh Mondal</strong> · WB 04 K 2211
              </p>
            </div>
          </Modal>
        </Section>

        <Section id="sheet" title="Bottom sheet over the map" note="Drag the handle (or focus it and use the arrow keys). The fare and the main button stay pinned to the bottom of the visible sheet at every height. On a desktop the booking screens use the side panel version.">
          <SheetDemo />
        </Section>
      </main>
    </div>
  );
}
