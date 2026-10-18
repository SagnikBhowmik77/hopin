import { useEffect, useState } from 'react';
import { t as tr } from '../i18n/index.js';
import { api, post } from '../api.js';
import { Banknote, CircleAlert, CreditCard, FlaskConical, RefreshCw, Smartphone, Wallet } from 'lucide-react';
import { PAYMENT_META, REVIEW_TAGS, rupees } from '../util.js';
import { StarInput, toast, useAction } from './ui.jsx';
import { Button, Chip, Input, Notice } from '../ds/index.js';

const PAY_ICON = { wallet: Wallet, upi: Smartphone, card: CreditCard, cash: Banknote };

let featuresCache = null;
/**
 * Which optional services the server really has connected:
 * { onlinePayments, onlinePaymentsMessage, email }. The app only offers what is true here.
 */
export function useFeatures() {
  const [features, setFeatures] = useState(featuresCache);
  useEffect(() => {
    if (featuresCache) return;
    api('/features')
      .then((f) => setFeatures((featuresCache = f)))
      .catch(() => setFeatures({ onlinePayments: false, onlinePaymentsMessage: 'Could not check payment options.', email: false }));
  }, []);
  return features;
}

// --- Razorpay Checkout ---------------------------------------------------------
// Card numbers, UPI PINs and bank logins are entered only in Razorpay's own window;
// Hopin never sees them. Hopin's server sets the amount and confirms the result.

let checkoutLoading = null;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  checkoutLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => {
      checkoutLoading = null;
      reject(new Error('Could not load Razorpay. Check your internet connection.'));
    };
    document.body.appendChild(s);
  });
  return checkoutLoading;
}

/**
 * Opens Razorpay for a ride payment or a wallet top-up and resolves with the
 * server's verified result. Rejects if the window is closed without paying.
 */
export async function payWithRazorpay({ kind, rideId, amount, method, splitId }) {
  const order = await post('/payments/razorpay/order', { kind, rideId, amount, splitId });
  await loadCheckout();
  return new Promise((resolve, reject) => {
    const checkout = new window.Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: 'Hopin',
      description: order.description,
      prefill: { ...order.prefill, ...(method ? { method } : {}) },
      theme: { color: '#17150f' },
      handler: (r) =>
        post('/payments/razorpay/verify', { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }).then(resolve, reject),
      // A failed attempt keeps Razorpay's window open so the rider can try again; only closing it ends the payment.
      modal: { ondismiss: () => reject(new Error('Payment window closed.')) },
    });
    checkout.open();
  });
}

export function TestModeNote() {
  const features = useFeatures();
  if (!features?.onlinePaymentsTestMode) return null;
  return (
    <Notice icon={FlaskConical} tone="accent" title="Razorpay test mode">
      No real money moves. Use Razorpay’s test card or test UPI ID (success@razorpay).
    </Notice>
  );
}

export function TripRoute({ ride, compact = false }) {
  const points = [
    ['pickup', 'Pickup', 'bg-success rounded-full', ride.pickup],
    ...ride.stops.map((s, i) => [`stop${i}`, `Stop ${i + 1}`, 'bg-accent rounded-full ring-2 ring-fg/70', s]),
    ['drop', 'Drop', 'bg-fg rounded-[3px]', ride.dropoff],
  ];
  return (
    <ol className="relative space-y-3">
      <span className="absolute bottom-2.5 left-[5px] top-2.5 w-0.5 bg-line-strong/50" aria-hidden />
      {points.map(([key, label, dot, p]) => (
        <li key={key} className="relative flex items-start gap-3">
          <span className={`mt-1.5 size-3 shrink-0 ${dot}`} aria-hidden />
          <span className={`min-w-0 text-small ${compact ? 'truncate' : ''}`}>
            <span className="sr-only">{label}: </span>
            {p.address}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function FareBreakdown({ ride }) {
  const p = ride.price;
  const rows =
    ride.status === 'cancelled'
      ? [[tr('Cancellation fee'), p.cancellationFee]]
      : ride.rental
        ? [
            [`Rental: ${ride.rental.name}`, ride.rental.price],
            ride.rental.extra > 0 && [`Extra km / time (${(ride.rental.actualKm ?? 0).toFixed(1)} km driven)`, ride.rental.extra],
          ].filter(Boolean)
        : [
            [ride.kind === 'parcel' ? tr('Delivery fare') : tr('Trip fare'), p.baseFare],
            p.surge > 1 && [`High demand (${p.surge}×)`, Math.round(p.baseFare * p.surge) - p.baseFare],
            p.stopCharge > 0 && [`Extra stops (${ride.stops.length})`, p.stopCharge],
            p.discount > 0 && [`Promo ${p.promoCode ?? ''}`, -p.discount],
            ride.lockSaving > 0 && ['Price lock', -ride.lockSaving],
          ].filter(Boolean);
  return (
    <dl className="space-y-1.5 text-small">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-fg-2">{label}</dt>
          <dd className={`tabular-nums ${value < 0 ? 'font-semibold text-success' : ''}`}>{value < 0 ? `− ${rupees(-value)}` : rupees(value)}</dd>
        </div>
      ))}
      <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2.5">
        <dt className="font-semibold">{tr('Total')}</dt>
        <dd className="font-display text-heading font-bold tabular-nums">{rupees(p.due)}</dd>
      </div>
    </dl>
  );
}

/**
 * Settles whatever is due on a ride. The wallet debits the rider's real balance;
 * card and UPI are only offered once the server reports a payment gateway.
 */
export function PayDue({ ride, walletBalance, onPaid }) {
  const features = useFeatures();
  const [method, setMethod] = useState('wallet');
  const [failed, setFailed] = useState(''); // display only: why the last attempt didn't go through
  const [busy, run] = useAction();
  if (ride.payment.status !== 'due') return null;
  const online = Boolean(features?.onlinePayments);
  const due = ride.price.due;
  const walletShort = walletBalance != null && walletBalance < due;

  const pay = () =>
    run(async () => {
      setFailed('');
      try {
        if (method === 'wallet') {
          const res = await post(`/payments/rides/${ride.id}/pay`, { method });
          toast(`${rupees(due)} paid from your wallet.`, 'ok');
          return onPaid?.(res.ride);
        }
        const res = await payWithRazorpay({ kind: 'ride', rideId: ride.id, method });
        if (res.status === 'needs_refund') toast('This ride was already paid, so your payment has been flagged for a refund.', 'error');
        else toast(`${rupees(due)} paid${features?.onlinePaymentsTestMode ? ' (Razorpay test mode)' : ''}.`, 'ok');
        onPaid?.(res.ride);
      } catch (err) {
        setFailed(err.message);
      }
    });

  return (
    <div className="space-y-3">
      {ride.payment.method === 'cash' && ride.status === 'completed' && (
        <Notice icon={Banknote} tone="accent">
          {tr('Pay {amount} in cash to your driver. They will confirm it on their app.', { amount: rupees(due) })}
        </Notice>
      )}
      {failed && (
        <Notice role="alert" icon={CircleAlert} tone="danger" title={tr('Payment didn’t go through')}>
          <p>{tr('{reason} You haven’t been charged. Try again or pick another method.', { reason: failed })}</p>
        </Notice>
      )}
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment method">
        {['wallet', 'upi', 'card'].map((m) => (
          <Chip
            key={m}
            role="radio"
            aria-checked={method === m}
            selected={method === m}
            icon={PAY_ICON[m]}
            disabled={m !== 'wallet' && !online}
            onClick={() => (setMethod(m), setFailed(''))}
          >
            {m === 'wallet' ? `Wallet${walletBalance != null ? ` ${rupees(walletBalance)}` : ''}` : PAYMENT_META[m].label}
          </Chip>
        ))}
      </div>
      <Button variant="primary" size="lg" block loading={busy} disabled={method === 'wallet' && walletShort} icon={failed ? RefreshCw : undefined} onClick={pay}>
        {failed ? tr('Try again · {amount}', { amount: rupees(due) }) : tr('Pay {amount}', { amount: rupees(due) })}
      </Button>
      {method === 'wallet' && walletShort && <p className="text-center text-small font-medium text-danger">{tr('Wallet balance is below {amount}. Pick UPI or card.', { amount: rupees(due) })}</p>}
      {features && !online && <p className="text-center text-caption text-fg-2">{features.onlinePaymentsMessage}</p>}
      {method !== 'wallet' && <TestModeNote />}
    </div>
  );
}

export function ReviewForm({ ride, onDone }) {
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState([]);
  const [comment, setComment] = useState('');
  const [busy, run] = useAction();
  if (ride.review) return null;
  const options = stars >= 4 ? REVIEW_TAGS.good : stars ? REVIEW_TAGS.bad.concat(REVIEW_TAGS.good.slice(0, 2)) : [];
  const toggle = (t) => setTags((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));

  const submit = () =>
    run(async () => {
      const res = await post(`/rides/${ride.id}/review`, { stars, tags, comment });
      toast('Thanks for the feedback!', 'ok');
      onDone?.(res.ride);
    });

  return (
    <div className="space-y-4">
      <p className="text-center font-display text-heading font-bold">{tr('How was your trip with {name}?', { name: ride.driver?.name.split(' ')[0] })}</p>
      <StarInput value={stars} onChange={setStars} />
      {stars > 0 && (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {options.map((t) => (
              <Chip key={t} selected={tags.includes(t)} aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>
                {t}
              </Chip>
            ))}
          </div>
          <Input multiline label={tr('Anything else?')} optional rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button variant="primary" size="lg" block loading={busy} onClick={submit}>
            {tr('Submit rating')}
          </Button>
        </>
      )}
    </div>
  );
}
