import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiUrl, currentToken, post } from '../api.js';
import { useSocketEvent } from '../session.jsx';
import { useFeatures } from './RideBits.jsx';
import { Empty, Modal, Pill, Spinner, toast, useAction } from './ui.jsx';
import { useElapsed, when } from '../util.js';
import { Mic, Play, Square, Trash2 } from 'lucide-react';
import { Button, Input, ListSkeleton, Notice, Section } from '../ds/index.js';

/**
 * Trip audio recording (step 8b batch F). The phone records in 30-second pieces and uploads
 * each one as it is made; the server encrypts it. Nobody can listen unless the person who
 * recorded sends it to Hopin safety. Unsent recordings are deleted after 7 days.
 */

const LIVE = ['accepted', 'arrived', 'ongoing'];
const CHUNK_MS = 30_000;
const MAX_MS = 3 * 3600_000;

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const minutes = (s) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

function pickMime() {
  if (typeof window === 'undefined' || !window.MediaRecorder?.isTypeSupported) return null;
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/** Uploads one piece, retrying network hiccups. Refusals from the server are not retried. */
async function putChunk(id, seq, blob) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(apiUrl(`/recordings/${id}/chunks/${seq}`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${await currentToken()}`, 'content-type': 'application/octet-stream' },
        body: blob,
      });
      if (res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (res.status < 500 || attempt >= 4) throw Object.assign(new Error(data.error || `Upload failed (${res.status})`), { status: res.status });
    } catch (err) {
      if (err.status || attempt >= 4) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** Live ride panel: record button for this person, and a notice when the other person records. */
export function TripRecorder({ ride, role }) {
  const features = useFeatures();
  const live = LIVE.includes(ride.status);
  const session = useRef(null);
  const [recording, setRecording] = useState(null); // { id, startedAt }
  const [starting, setStarting] = useState(false);
  const [otherLive, setOtherLive] = useState(false);
  const elapsed = useElapsed(recording?.startedAt);
  const other = role === 'rider' ? 'driver' : 'rider';

  useEffect(() => {
    api(`/recordings?rideId=${ride.id}`)
      .then((d) => setOtherLive(d.liveOnRide.includes(other)))
      .catch(() => {});
  }, [ride.id, other]);
  useSocketEvent(
    'ride:recording',
    useCallback(
      (e) => {
        if (e.rideId === ride.id && e.role === other) setOtherLive(e.active);
      },
      [ride.id, other],
    ),
  );

  const stop = useCallback(() => {
    const s = session.current;
    if (s && s.recorder.state !== 'inactive') s.recorder.stop();
  }, []);

  // Stops by itself when the trip ends or the panel closes; the last piece still uploads.
  useEffect(() => {
    if (!live) stop();
  }, [live, stop]);
  useEffect(() => stop, [stop]);

  const start = async () => {
    const mimeType = pickMime();
    if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
      toast('This browser cannot record audio. Try Chrome, Firefox or Safari.', 'error');
      return;
    }
    setStarting(true);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch {
      setStarting(false);
      toast('Hopin needs microphone permission to record. Allow it in your browser settings.', 'error');
      return;
    }
    let rec;
    try {
      rec = (await post('/recordings', { rideId: ride.id, mimeType })).recording;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setStarting(false);
      toast(err.message, 'error');
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 });
    const s = { id: rec.id, recorder, seq: 0, queue: Promise.resolve(), failed: false, limit: null };
    session.current = s;
    recorder.ondataavailable = (e) => {
      if (!e.data.size || s.failed) return;
      const n = s.seq++;
      s.queue = s.queue
        .then(() => (s.failed ? undefined : putChunk(s.id, n, e.data)))
        .catch((err) => {
          if (s.failed) return;
          s.failed = true;
          toast(`Recording stopped: ${err.message}`, 'error');
          if (recorder.state !== 'inactive') recorder.stop();
        });
    };
    recorder.onstop = () => {
      clearTimeout(s.limit);
      stream.getTracks().forEach((t) => t.stop());
      s.queue
        .then(() => post(`/recordings/${s.id}/stop`))
        .catch(() => {})
        .finally(() => {
          if (session.current === s) session.current = null;
          setRecording(null);
        });
    };
    recorder.start(CHUNK_MS);
    s.limit = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), MAX_MS);
    setRecording({ id: rec.id, startedAt: rec.startedAt });
    setStarting(false);
    toast(`Recording. Your ${other} has been told.`, 'ok');
  };

  if (!features?.recording || !live) return null;

  return (
    <div className="space-y-2">
      {otherLive && (
        <Notice icon={Mic} tone="accent">
          <strong>Your {other} is recording audio of this trip</strong> for safety. Only Hopin’s safety team can ever listen, and only if it is reported to them.
        </Notice>
      )}
      {recording ? (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-danger-soft p-3 text-small text-danger">
          <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-danger motion-reduce:animate-none" aria-hidden />
          <p className="min-w-0 flex-1">
            <strong className="tabular-nums">Recording audio · {clock(elapsed)}</strong>
            <span className="block text-fg-2">Your {other} has been told. It stops when the trip ends.</span>
          </p>
          <Button variant="outline" size="sm" icon={Square} onClick={stop}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] p-3 text-small ring-1 ring-line">
          <p className="min-w-0 flex-1 text-fg-2">
            Feel unsafe? Record the trip’s audio. Your {other} is told. Nobody can listen unless you send it to Hopin safety; otherwise it’s deleted after 7 days.
          </p>
          <Button variant="outline" size="sm" icon={Mic} loading={starting} onClick={start} className="shrink-0">
            Record
          </Button>
        </div>
      )}
    </div>
  );
}

/** Trip details: this person's recordings of the ride, with "Send to Hopin safety" and delete. */
export function RideRecordings({ rideId }) {
  const [list, setList] = useState([]);
  const [reporting, setReporting] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, run] = useAction();
  const load = useCallback(
    () =>
      api(`/recordings?rideId=${rideId}`)
        .then((d) => setList(d.recordings))
        .catch(() => {}),
    [rideId],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!list.length) return null;

  const send = () =>
    run(async () => {
      await post(`/recordings/${reporting}/report`, { reason });
      setReporting(null);
      setReason('');
      toast('Sent to Hopin safety. A safety ticket is open in Help.', 'ok');
      load();
    });
  const remove = (id) =>
    run(async () => {
      if (!window.confirm('Delete this recording for good?')) return;
      await api(`/recordings/${id}`, { method: 'DELETE' });
      toast('Recording deleted', 'ok');
      load();
    });

  return (
    <div className="space-y-3 rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
      <h3 className="flex items-center gap-2 font-display text-heading font-bold">
        <Mic aria-hidden className="size-[18px]" /> Your trip recordings
      </h3>
      <ul className="divide-y divide-line text-small">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5">
            <span className="min-w-[10rem] flex-1">
              {when(r.startedAt)} · {r.status === 'recording' ? 'recording now' : minutes(r.seconds)}
              <span className="block text-caption text-fg-2">
                {r.held ? 'With Hopin safety. Only they can listen; see the ticket in Help.' : r.deleteAfter ? `Deleted automatically ${when(r.deleteAfter)}` : ''}
              </span>
            </span>
            {r.held ? (
              <Pill tone="open">With safety team</Pill>
            ) : (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReporting(r.id)}>
                  Send to safety
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={() => remove(r.id)}>
                  Delete
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <Modal open={Boolean(reporting)} onClose={() => setReporting(null)} title="Send to Hopin safety">
        <div className="space-y-3 text-small">
          <p className="text-fg-2">Hopin’s safety team will be able to listen to this recording, and it is kept until they close your case. You can’t delete it after sending.</p>
          <Input multiline label="What happened?" rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="primary" size="lg" block loading={busy} disabled={reason.trim().length < 5} onClick={send}>
            Send recording
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Admin: recordings riders and drivers sent to the safety team. Every play is logged. */
export function AdminRecordings() {
  const [list, setList] = useState(null);
  const [playing, setPlaying] = useState(null); // { id, url }
  const [busy, run] = useAction();
  const load = useCallback(
    () =>
      api('/admin/recordings')
        .then((d) => setList(d.recordings))
        .catch(() => setList([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!playing) return undefined;
    return () => URL.revokeObjectURL(playing.url);
  }, [playing]);
  useSocketEvent(
    'recording',
    useCallback(() => {
      toast('A trip recording was sent to the safety team', 'error');
      load();
    }, [load]),
  );

  const play = (id) =>
    run(async () => {
      const res = await fetch(apiUrl(`/admin/recordings/${id}/audio`), { headers: { authorization: `Bearer ${await currentToken()}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not load (${res.status})`);
      setPlaying({ id, url: URL.createObjectURL(await res.blob()) });
      load();
    });
  const remove = (id) =>
    run(async () => {
      if (!window.confirm('Case closed? This deletes the recording for good.')) return;
      await api(`/admin/recordings/${id}`, { method: 'DELETE' });
      if (playing?.id === id) setPlaying(null);
      load();
    });

  return (
    <Section
      title="Trip recordings"
      icon={Mic}
      description="Only recordings a rider or driver sent to safety appear here. Every play is logged with your name."
      action={list?.length > 0 && <Pill tone="open">{list.length} held</Pill>}
    >
      {!list ? (
        <ListSkeleton rows={2} label="Loading recordings" />
      ) : list.length === 0 ? (
        <Empty icon={Mic} title="No recordings sent to safety" />
      ) : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.id} className="space-y-2 rounded-[var(--radius-md)] p-3.5 text-small ring-1 ring-line">
              <p>
                <span className="font-semibold">{r.by.name}</span> ({r.by.role}) · {when(r.startedAt)} · {r.status === 'recording' ? 'still recording' : minutes(r.seconds)} · played {r.plays}×
              </p>
              <p className="text-fg-2">
                {r.ride.pickup} to {r.ride.dropoff}
              </p>
              <p className="rounded-[var(--radius-sm)] bg-raised p-2.5">“{r.reason}”</p>
              {playing?.id === r.id && <audio controls autoPlay src={playing.url} className="w-full" />}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" icon={Play} disabled={busy} onClick={() => play(r.id)}>
                  Play
                </Button>
                <Button variant="ghost" size="sm" icon={Trash2} disabled={busy} onClick={() => remove(r.id)}>
                  Delete (case closed)
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
