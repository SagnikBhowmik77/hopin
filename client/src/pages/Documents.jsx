import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Eye, FileUp, IdCard, ScrollText, ShieldAlert, ShieldCheck, UserRound } from 'lucide-react';
import { api, ApiError, apiUrl, currentToken } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import { ErrorNote, Pill, toast, useAction } from '../components/ui.jsx';
import { Button, Input, ListSkeleton, Notice, Page } from '../ds/index.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { when } from '../util.js';

// What each document needs, mirroring the server's rules.
const NEEDS = {
  driving_licence: { number: 'Licence number', expires: true, hint: 'Front side, all text readable.', icon: IdCard },
  vehicle_rc: { number: null, expires: false, hint: 'Registration certificate for the vehicle on your profile.', icon: VEHICLE_ICON.car },
  insurance: { number: 'Policy number', expires: true, hint: 'Current policy for the vehicle on your profile.', icon: ScrollText },
  driver_photo: { number: null, expires: false, hint: 'A clear photo of your face, no sunglasses or cap.', icon: UserRound },
};

const STATE = {
  missing: ['Not uploaded', 'due'],
  pending: ['Under review', 'in_progress'],
  approved: ['Approved', 'paid'],
  rejected: ['Rejected', 'cancelled'],
  expired: ['Expired', 'cancelled'],
  wrong_vehicle: ['For a different vehicle', 'cancelled'],
};

/** Uploads the raw file; the server checks its real type and size. */
async function uploadFile(type, file, params) {
  const token = await currentToken();
  let res;
  try {
    res = await fetch(apiUrl(`/driver/documents/${type}?${new URLSearchParams(params)}`), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach Hopin. Is the server running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || (res.status === 413 ? 'Files must be 5 MB or smaller' : 'Upload failed'));
  return data;
}

function DocCard({ item, plate, onChange }) {
  const need = NEEDS[item.type];
  const [file, setFile] = useState(null);
  const [number, setNumber] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAction();
  const [label, tone] = STATE[item.state];
  const canUpload = item.state !== 'approved' && item.state !== 'pending';
  const Icon = need.icon;
  const inputId = `doc-${item.type}`;

  const submit = (e) => {
    e.preventDefault();
    setError('');
    if (!file) return setError('Choose a file');
    if (file.size > 5 * 1024 * 1024) return setError('Files must be 5 MB or smaller');
    run(async () => {
      try {
        onChange(await uploadFile(item.type, file, { ...(need.number ? { number } : {}), ...(need.expires ? { expires } : {}) }));
        setFile(null);
        setNumber('');
        setExpires('');
        toast(`${item.label} uploaded — we'll review it soon.`, 'ok');
      } catch (err) {
        setError(err.message);
      }
    });
  };

  const view = () =>
    run(async () => {
      const { url } = await api(`/driver/documents/${item.doc.id}/url`);
      window.open(url, '_blank', 'noopener');
    });

  return (
    <li className="space-y-3 rounded-[var(--radius-lg)] bg-surface p-4 ring-1 ring-line">
      <div className="flex items-start gap-3">
        <span className={`grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] ${item.state === 'approved' ? 'bg-success-soft text-success' : 'bg-raised'}`} aria-hidden>
          {item.state === 'approved' ? <CircleCheck className="size-5" /> : <Icon className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-heading font-bold">{item.label}</p>
            <Pill tone={tone}>{label}</Pill>
          </div>
          <p className="text-caption text-fg-2">{need.hint}</p>
        </div>
      </div>

      {item.doc && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] bg-raised px-3 py-2.5 text-small">
          <div className="min-w-0 text-fg-2">
            {item.doc.number && <span className="text-fg">No. {item.doc.number} · </span>}
            {item.doc.expiresOn && <span>valid until {item.doc.expiresOn} · </span>}
            uploaded {when(item.doc.uploadedAt)}
          </div>
          <Button size="sm" variant="ghost" icon={Eye} onClick={view} disabled={busy}>
            View
          </Button>
        </div>
      )}
      {item.state === 'rejected' && <ErrorNote>Reason: {item.doc.rejectReason}</ErrorNote>}
      {item.state === 'wrong_vehicle' && (
        <ErrorNote>
          Uploaded for {item.doc.vehiclePlate}; your vehicle is now {plate}.
        </ErrorNote>
      )}

      {canUpload && (
        <form className="space-y-3 border-t border-line pt-3" onSubmit={submit}>
          <label
            htmlFor={inputId}
            className="flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border-2 border-dashed border-line-strong px-4 py-3 text-small transition-colors duration-[var(--dur-fast)] hover:bg-raised focus-within:outline-2 focus-within:outline-[var(--focus)]"
          >
            <FileUp aria-hidden className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{file ? file.name : 'Choose JPG, PNG or PDF (up to 5 MB)'}</span>
            <input id={inputId} type="file" accept="image/jpeg,image/png,application/pdf" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {(need.number || need.expires) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {need.number && <Input label={need.number} value={number} onChange={(e) => setNumber(e.target.value)} required />}
              {need.expires && <Input label="Valid until" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required />}
            </div>
          )}
          {item.type === 'vehicle_rc' && <p className="text-caption text-fg-2">For vehicle {plate || '— add your vehicle in Profile first'}.</p>}
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="secondary" loading={busy} disabled={!file}>
            {item.doc ? 'Upload new version' : 'Upload'}
          </Button>
        </form>
      )}
    </li>
  );
}

export default function Documents() {
  const { user } = useSession();
  const [v, setV] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api('/driver/verification')
        .then(setV)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  // Reload when an admin decision arrives.
  useSocketEvent('notify', useCallback(() => load(), [load]));

  const done = v?.items.filter((i) => i.state === 'approved').length ?? 0;
  return (
    <Page title="Documents" description="JPG, PNG or PDF, up to 5 MB each. Only Hopin’s review team can see them.">
      <ErrorNote>{error}</ErrorNote>
      {!v ? (
        !error && <ListSkeleton rows={4} label="Loading your documents" />
      ) : (
        <>
          {v.canDrive ? (
            <Notice icon={ShieldCheck} tone="success" title="You’re verified">
              <p>All documents approved — you can drive.</p>
            </Notice>
          ) : (
            <Notice icon={ShieldAlert} tone="warning" title={`${done} of ${v.items.length} approved`}>
              <p>{v.message}</p>
            </Notice>
          )}
          <ul className="space-y-3">
            {v.items.map((item) => (
              <DocCard key={item.type} item={item} plate={user.vehicle?.plate} onChange={setV} />
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
