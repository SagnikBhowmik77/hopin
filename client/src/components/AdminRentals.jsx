import { useCallback, useEffect, useState } from 'react';
import { BadgeIndianRupee, Construction, Plus, Timer, Trash2 } from 'lucide-react';
import { api, post } from '../api.js';
import { Empty, ErrorNote, Pill, toast, useAction } from './ui.jsx';
import { Button, Input, ListSkeleton, Section } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { VEHICLE_META, rupees } from '../util.js';

/** A collapsible "add" form under a list, so the list stays the first thing you read. */
function AddForm({ label, children }) {
  return (
    <details className="group rounded-[var(--radius-md)] ring-1 ring-line">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-small font-semibold [&::-webkit-details-marker]:hidden">
        <Plus aria-hidden className="size-4 transition-transform duration-[var(--dur-fast)] group-open:rotate-45" />
        {label}
      </summary>
      <div className="border-t border-line p-4">{children}</div>
    </details>
  );
}

/** Admin: rental packages (switch them on/off, add seasonal Puja packages). */
export function RentalPackagesAdmin() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: '', vehicleType: 'car', hours: 4, km: 30, price: '', extraKmRate: 15, extraMinRate: 2, seasonal: true, availableFrom: '', availableTo: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/rentals/admin/packages').then((d) => setList(d.packages)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/rentals/admin/packages', {
          ...form,
          hours: Number(form.hours),
          km: Number(form.km),
          price: Number(form.price),
          extraKmRate: Number(form.extraKmRate),
          extraMinRate: Number(form.extraMinRate),
        });
        toast('Package added', 'ok');
        setForm((f) => ({ ...f, name: '', price: '' }));
        load();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  return (
    <Section title="Rental packages" icon={Timer}>
      {!list ? (
        <ListSkeleton rows={2} label="Loading packages" />
      ) : list.length === 0 ? (
        <Empty icon={Timer} title="No packages" />
      ) : (
        <ul className="divide-y divide-line text-small">
          {list.map((p) => {
            const Icon = VEHICLE_ICON[p.vehicleType];
            return (
              <li key={p.id} className={`flex items-center justify-between gap-3 py-2.5 ${p.active ? '' : 'text-fg-2'}`}>
                <span className="flex min-w-0 items-start gap-2.5">
                  <Icon aria-hidden className="mt-0.5 size-[18px] shrink-0" />
                  <span className="min-w-0">
                    <span className="font-semibold">{p.name}</span> · <span className="tabular-nums">{rupees(p.price)}</span>
                    <span className="block text-caption text-fg-2">
                      {p.hours} h / {p.km} km, then {rupees(p.extraKmRate)}/km, {rupees(p.extraMinRate)}/min
                      {p.seasonal && ` · ${p.availableFrom} to ${p.availableTo}`}
                    </span>
                  </span>
                </span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => (await post(`/rentals/admin/packages/${p.id}/active`, { active: !p.active }), load()))}>
                  {p.active ? 'Switch off' : 'Switch on'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <AddForm label="Add a package (e.g. Puja pandal hopping)">
        <form className="grid grid-cols-2 gap-3" onSubmit={add}>
          <Input id="pkg-name" className="col-span-2" label="Name" placeholder="Puja pandal hopping" value={form.name} onChange={set('name')} />
          <div className="space-y-1.5">
            <label className="ds-label" htmlFor="pkg-vehicle">
              Vehicle
            </label>
            <select id="pkg-vehicle" className="input" value={form.vehicleType} onChange={set('vehicleType')}>
              <option value="car">Cab</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          <Input id="pkg-price" label="Price" prefix="₹" inputMode="numeric" value={form.price} onChange={set('price')} />
          <Input id="pkg-hours" label="Hours" inputMode="numeric" value={form.hours} onChange={set('hours')} />
          <Input id="pkg-km" label="Km included" inputMode="numeric" value={form.km} onChange={set('km')} />
          <Input id="pkg-xkm" label="Extra per km" prefix="₹" inputMode="decimal" value={form.extraKmRate} onChange={set('extraKmRate')} />
          <Input id="pkg-xmin" label="Extra per min" prefix="₹" inputMode="decimal" value={form.extraMinRate} onChange={set('extraMinRate')} />
          <label className="col-span-2 flex min-h-11 cursor-pointer items-center gap-3 text-small">
            <input type="checkbox" className="size-5 accent-[var(--fg)]" checked={form.seasonal} onChange={set('seasonal')} /> Only on certain dates (seasonal)
          </label>
          {form.seasonal && (
            <>
              <Input id="pkg-from" type="date" label="From" value={form.availableFrom} onChange={set('availableFrom')} />
              <Input id="pkg-to" type="date" label="To" value={form.availableTo} onChange={set('availableTo')} />
            </>
          )}
          <div className="col-span-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
          <Button type="submit" variant="secondary" className="col-span-2 justify-self-start" loading={busy}>
            Add package
          </Button>
        </form>
      </AddForm>
    </Section>
  );
}

/** Admin: road closures from police notices, shown to riders and drivers. */
export function ClosuresAdmin() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ title: '', source: '', note: '', lat: '', lng: '', radiusM: 300, startsAt: '', endsAt: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(() => api('/rentals/admin/closures').then((d) => setList(d.closures)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      setError('');
      try {
        await post('/rentals/admin/closures', {
          ...form,
          lat: Number(form.lat),
          lng: Number(form.lng),
          radiusM: Number(form.radiusM),
          startsAt: form.startsAt && new Date(form.startsAt).toISOString(),
          endsAt: form.endsAt && new Date(form.endsAt).toISOString(),
        });
        toast('Closure added', 'ok');
        setForm((f) => ({ ...f, title: '', note: '', lat: '', lng: '' }));
        load();
      } catch (err) {
        setError(err.message);
      }
    });
  };
  const now = Date.now();
  return (
    <Section title="Road closures" icon={Construction}>
      {!list ? (
        <ListSkeleton rows={2} label="Loading closures" />
      ) : list.length === 0 ? (
        <Empty icon={Construction} title="No closures">
          Add closures from official notices, such as the Kolkata Traffic Police Puja advisories.
        </Empty>
      ) : (
        <ul className="divide-y divide-line text-small">
          {list.map((c) => {
            const over = new Date(c.endsAt) < now;
            const live = !over && new Date(c.startsAt) <= now;
            return (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-semibold">{c.title}</span> · {c.radiusM} m
                  <span className="block text-caption text-fg-2">
                    {new Date(c.startsAt).toLocaleString('en-IN')} to {new Date(c.endsAt).toLocaleString('en-IN')} · source: {c.source}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Pill tone={over ? 'resolved' : live ? 'open' : 'in_progress'}>{over ? 'over' : live ? 'now' : 'upcoming'}</Pill>
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost ds-iconbtn"
                    aria-label={`Delete ${c.title}`}
                    title="Delete"
                    disabled={busy}
                    onClick={() => run(async () => (await api(`/rentals/admin/closures/${c.id}`, { method: 'DELETE' }), load()))}
                  >
                    <Trash2 aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <AddForm label="Add a closure">
        <form className="grid grid-cols-2 gap-3" onSubmit={add}>
          <Input id="cl-title" className="col-span-2" label="Name" placeholder="Park Street no-entry" value={form.title} onChange={set('title')} />
          <Input id="cl-source" className="col-span-2" label="Source" placeholder="Kolkata Traffic Police notice of 10 Oct" value={form.source} onChange={set('source')} />
          <Input id="cl-note" className="col-span-2" label="Note" optional value={form.note} onChange={set('note')} />
          <Input id="cl-lat" label="Latitude" inputMode="decimal" value={form.lat} onChange={set('lat')} />
          <Input id="cl-lng" label="Longitude" inputMode="decimal" value={form.lng} onChange={set('lng')} />
          <Input id="cl-radius" className="col-span-2" label="Radius (m)" inputMode="numeric" value={form.radiusM} onChange={set('radiusM')} />
          <Input id="cl-from" type="datetime-local" label="From" value={form.startsAt} onChange={set('startsAt')} />
          <Input id="cl-to" type="datetime-local" label="Until" value={form.endsAt} onChange={set('endsAt')} />
          <p className="col-span-2 text-caption text-fg-2">Tip: in Google Maps, right-click the spot and click the numbers at the top to copy latitude and longitude.</p>
          <div className="col-span-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
          <Button type="submit" variant="secondary" className="col-span-2 justify-self-start" loading={busy}>
            Add closure
          </Button>
        </form>
      </AddForm>
    </Section>
  );
}

/** Admin: the drivers' daily pass prices (keep 100% of fares for the day). */
export function PassPricesAdmin() {
  const [prices, setPrices] = useState(null);
  const [busy, run] = useAction();
  useEffect(() => {
    api('/admin/pass-prices')
      .then((d) => setPrices(d.prices ?? { bike: '', auto: '', car: '' }))
      .catch(() => {});
  }, []);
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const d = await api('/admin/pass-prices', { method: 'PUT', body: { prices: { bike: Number(prices.bike), auto: Number(prices.auto), car: Number(prices.car) } } });
      setPrices(d.prices);
      toast('Pass prices saved', 'ok');
    });
  };
  return (
    <Section title="Driver daily pass" icon={BadgeIndianRupee} description="A driver who buys today’s pass keeps 100% of fares on rides they accept that day.">
      {!prices ? (
        <ListSkeleton rows={1} label="Loading pass prices" />
      ) : (
        <form className="grid grid-cols-3 gap-2" onSubmit={save}>
          {['bike', 'auto', 'car'].map((t) => (
            <Input key={t} id={`pass-${t}`} label={VEHICLE_META[t].label} prefix="₹" inputMode="numeric" value={prices[t]} onChange={(e) => setPrices((p) => ({ ...p, [t]: e.target.value }))} />
          ))}
          <Button type="submit" variant="secondary" className="col-span-3 justify-self-start" loading={busy}>
            Save prices
          </Button>
        </form>
      )}
    </Section>
  );
}
