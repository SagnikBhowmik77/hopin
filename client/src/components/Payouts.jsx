import { useCallback, useEffect, useState } from 'react';
import { Banknote, Eye, Landmark, Send, Smartphone, X } from 'lucide-react';
import { api, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { Empty, Modal, Pill, toast, useAction } from './ui.jsx';
import { Badge, Button, Chip, Input, ListSkeleton, Section } from '../ds/index.js';
import { rupees, when } from '../util.js';

/**
 * Driver payouts (step 12), paid by hand: the driver asks, Hopin holds the amount, an admin
 * sends it by UPI/bank and records the UTR. No payout API is involved.
 */

const STATUS = { requested: 'Waiting', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled' };
const STATUS_TONE = { requested: 'in_progress', paid: 'paid', rejected: 'cancelled', cancelled: 'cancelled' };

function MethodForm({ onSaved, onCancel }) {
  const [kind, setKind] = useState('upi');
  const [f, setF] = useState({ vpa: '', holder: '', account: '', ifsc: '' });
  const [busy, run] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () =>
    run(async () => {
      await api('/driver/payout-method', { method: 'PUT', body: kind === 'upi' ? { kind, vpa: f.vpa } : { kind, holder: f.holder, account: f.account, ifsc: f.ifsc } });
      toast('Payout details saved', 'ok');
      onSaved();
    });
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="radiogroup" aria-label="Payout method">
        {[
          ['upi', 'UPI ID', Smartphone],
          ['bank', 'Bank account', Landmark],
        ].map(([k, label, Icon]) => (
          <Chip key={k} role="radio" aria-checked={kind === k} selected={kind === k} icon={Icon} onClick={() => setKind(k)}>
            {label}
          </Chip>
        ))}
      </div>
      {kind === 'upi' ? (
        <Input label="UPI ID" placeholder="yourname@okhdfc" value={f.vpa} onChange={set('vpa')} />
      ) : (
        <>
          <Input label="Account holder" placeholder="Name as on the bank account" value={f.holder} onChange={set('holder')} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Account number" inputMode="numeric" value={f.account} onChange={set('account')} />
            <Input label="IFSC" placeholder="HDFC0001234" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} />
          </div>
        </>
      )}
      <p className="text-caption text-fg-2">Stored encrypted. Only Hopin admins see it in full, when sending you money.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" loading={busy} onClick={save}>
          Save
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

/** Drive page: withdraw earnings to UPI/bank. */
export function DriverPayouts({ onChange }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(
    () =>
      api('/driver/payouts')
        .then(setData)
        .catch(() => setData({ enabled: false })),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!data?.enabled) return null;

  const open = data.payouts.find((p) => p.status === 'requested');
  const withdraw = () =>
    run(async () => {
      await post('/driver/payouts', { amount: Number(amount) });
      setAmount('');
      toast('Withdrawal requested. You will be notified when Hopin sends it.', 'ok');
      load();
      onChange?.();
    });
  const cancel = (id) =>
    run(async () => {
      await post(`/driver/payouts/${id}/cancel`);
      toast('Cancelled. The money is back in your wallet.', 'ok');
      load();
      onChange?.();
    });

  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <Banknote aria-hidden className="size-[18px]" /> Withdraw earnings
        </p>
        {data.method && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>
      {!data.method || editing ? (
        <MethodForm
          onSaved={() => {
            setEditing(false);
            load();
          }}
          onCancel={data.method ? () => setEditing(false) : null}
        />
      ) : (
        <p className="text-small text-fg-2">
          Paid to <strong className="text-fg">{data.method.label}</strong>
        </p>
      )}
      {data.method &&
        !editing &&
        (open ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-raised p-3 text-small">
            <p className="min-w-0 flex-1">
              <strong className="tabular-nums">{rupees(open.amount)}</strong> requested {when(open.requestedAt)}. Waiting for Hopin to send it.
            </p>
            <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={() => cancel(open.id)}>
              Cancel
            </Button>
          </div>
        ) : data.walletBalance >= data.minAmount ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input
              className="w-36"
              label="Amount"
              prefix="₹"
              inputMode="numeric"
              placeholder={`${data.minAmount}–${data.walletBalance}`}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
            />
            <Button variant="ghost" onClick={() => setAmount(String(data.walletBalance))}>
              All
            </Button>
            <Button variant="secondary" icon={Send} loading={busy} disabled={!amount} onClick={withdraw}>
              Withdraw
            </Button>
          </div>
        ) : (
          <p className="text-small text-fg-2">
            You can withdraw once your wallet has {rupees(data.minAmount)} or more (now {rupees(data.walletBalance)}).
          </p>
        ))}
      {data.payouts.length > 0 && (
        <ul className="divide-y divide-line text-caption">
          {data.payouts.slice(0, 5).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-fg-2">
                {when(p.requestedAt)} · <span className="font-semibold tabular-nums text-fg">{rupees(p.amount)}</span>
                {p.reference && ` · ref ${p.reference}`}
                {p.rejectReason && ` · ${p.rejectReason}`}
              </span>
              <Pill tone={STATUS_TONE[p.status]}>{STATUS[p.status]}</Pill>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Admin: waiting withdrawals. Send the money yourself, then record the UTR. */
export function AdminPayouts() {
  const [list, setList] = useState(null);
  const [details, setDetails] = useState(null);
  const [acting, setActing] = useState(null); // { id, mode: 'paid' | 'reject', amount, driver }
  const [text, setText] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(
    () =>
      api('/admin/payouts')
        .then((d) => setList(d.payouts))
        .catch(() => setList([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  useSocketEvent(
    'payout',
    useCallback(() => {
      toast('A driver asked to withdraw earnings', 'info');
      load();
    }, [load]),
  );

  const show = (id) =>
    run(async () => {
      const { details: d } = await api(`/admin/payouts/${id}/details`);
      setDetails({ id, ...d });
      load();
    });
  const submit = () =>
    run(async () => {
      if (acting.mode === 'paid') await post(`/admin/payouts/${acting.id}/paid`, { reference: text });
      else await post(`/admin/payouts/${acting.id}/reject`, { reason: text });
      toast(acting.mode === 'paid' ? 'Marked paid. The driver was told.' : 'Rejected. The money is back in their wallet.', 'ok');
      setActing(null);
      setText('');
      setDetails(null);
      load();
    });
  const waiting = list?.filter((p) => p.status === 'requested') ?? [];

  return (
    <Section
      title="Driver payouts"
      icon={Banknote}
      description="Send each payout yourself from Hopin’s bank or UPI, then record the UTR. Viewing full details is logged."
      action={
        waiting.length > 0 && (
          <Badge tone="danger">
            {waiting.length} waiting · {rupees(waiting.reduce((s, p) => s + p.amount, 0))}
          </Badge>
        )
      }
    >
      {!list ? (
        <ListSkeleton rows={2} label="Loading payouts" />
      ) : list.length === 0 ? (
        <Empty icon={Banknote} title="No withdrawals yet" />
      ) : (
        <ul className="divide-y divide-line text-small">
          {list.map((p) => (
            <li key={p.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0">
                  <strong className="tabular-nums">{rupees(p.amount)}</strong> to {p.driver.name} · {p.label}
                  <span className="block text-caption text-fg-2">
                    {when(p.requestedAt)}
                    {p.reference && ` · UTR ${p.reference}`}
                    {p.rejectReason && ` · ${p.rejectReason}`} · details viewed {p.detailViews}×
                  </span>
                </p>
                <Pill tone={STATUS_TONE[p.status]}>{STATUS[p.status]}</Pill>
              </div>
              {p.status === 'requested' && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" icon={Eye} disabled={busy} onClick={() => show(p.id)}>
                    Show details
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setActing({ id: p.id, mode: 'paid', amount: p.amount, driver: p.driver.name })}>
                    I’ve paid it
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setActing({ id: p.id, mode: 'reject', amount: p.amount, driver: p.driver.name })}>
                    Reject
                  </Button>
                </div>
              )}
              {details?.id === p.id && (
                <p className="rounded-[var(--radius-sm)] bg-raised p-2.5 font-mono text-caption">
                  {details.kind === 'upi' ? `UPI: ${details.vpa}` : `${details.holder} · A/c ${details.account} · IFSC ${details.ifsc}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={Boolean(acting)} onClose={() => setActing(null)} title={acting?.mode === 'paid' ? `Record payment to ${acting?.driver}` : `Reject ${acting?.driver}'s withdrawal`}>
        <div className="space-y-3 text-small">
          <p className="text-fg-2">
            {acting?.mode === 'paid'
              ? `Only after you have sent ${rupees(acting?.amount)}. Enter the UTR / UPI reference from your bank app.`
              : `${rupees(acting?.amount ?? 0)} goes back to their Hopin wallet. Tell them why.`}
          </p>
          <Input
            label={acting?.mode === 'paid' ? 'UTR reference' : 'Reason'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={acting?.mode === 'paid' ? '404912345678' : 'Bank account name did not match'}
          />
          <Button variant={acting?.mode === 'paid' ? 'primary' : 'danger'} block loading={busy} disabled={!text.trim()} onClick={submit}>
            {acting?.mode === 'paid' ? 'Mark as paid' : 'Reject and return the money'}
          </Button>
        </div>
      </Modal>
    </Section>
  );
}
