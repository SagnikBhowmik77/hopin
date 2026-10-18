import { useEffect, useRef, useState } from 'react';
import { Camera, HardHat } from 'lucide-react';
import { api, apiUrl, currentToken } from '../api.js';
import { toast } from './ui.jsx';
import { Notice } from '../ds/index.js';

const STATUS = {
  pending: "Today's selfie is waiting for review. You can drive meanwhile.",
  approved: "Today's helmet selfie is approved.",
};

/** Bike drivers: one helmet selfie per day before going online. Renders nothing for other vehicles. */
export default function HelmetSelfie({ onChange }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    api('/driver/helmet').then(setState).catch(() => {});
  }, []);
  if (!state?.required) return null;

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/driver/helmet'), {
        method: 'PUT',
        headers: { authorization: `Bearer ${await currentToken()}`, 'content-type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      setState(data);
      onChange?.(data);
      toast('Helmet selfie sent. You can go online.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const ok = state.canDrive;
  return (
    <Notice icon={HardHat} tone={ok ? 'neutral' : 'accent'} title="Helmet check">
      <p>{ok ? STATUS[state.today?.status] : state.message}</p>
      {!ok && (
        <div className="space-y-2 pt-1">
          <input ref={input} id="helmet-selfie" type="file" accept="image/jpeg,image/png" capture="user" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
          <label htmlFor="helmet-selfie" className={`ds-btn ds-btn--secondary ds-btn--sm ${busy ? 'pointer-events-none opacity-60' : ''}`} aria-busy={busy || undefined}>
            {busy ? <span className="ds-spinner" aria-hidden /> : <Camera aria-hidden />}
            <span className="ds-btn__label">Take helmet selfie</span>
          </label>
          <p className="text-caption text-fg-2">Wear your helmet with the strap fastened and your face visible. An admin reviews it.</p>
        </div>
      )}
    </Notice>
  );
}
