import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, SendHorizontal } from 'lucide-react';
import { Chip, Input, ListSkeleton } from '../ds/index.js';
import { api, post } from '../api.js';
import { useSession, useSocketEvent } from '../session.jsx';
import { Modal, Spinner, toast, useAction } from './ui.jsx';
import { ago } from '../util.js';

/** Messages of one ride, kept live over the socket. */
function useRideMessages(rideId) {
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api(`/rides/${rideId}/messages`)
      .then(setData)
      .catch((e) => toast(e.message, 'error'));
  }, [rideId]);

  const add = useCallback(
    (m) => {
      if (m.rideId !== rideId) return;
      setData((d) => (d && !d.messages.some((x) => x.id === m.id) ? { ...d, messages: [...d.messages, m] } : d));
    },
    [rideId],
  );
  useSocketEvent('chat:message', add);
  useSocketEvent(
    'chat:read',
    useCallback(
      ({ rideId: id, ids, readAt }) => {
        if (id !== rideId) return;
        setData((d) => d && { ...d, messages: d.messages.map((m) => (ids.includes(m.id) ? { ...m, readAt } : m)) });
      },
      [rideId],
    ),
  );
  return [data, add];
}

/** Chat button for a live ride: shows unread count, opens the conversation. */
export function ChatButton({ ride, otherName }) {
  const { user } = useSession();
  const [data, add] = useRideMessages(ride.id);
  const [open, setOpen] = useState(false);
  const unread = data?.messages.filter((m) => m.senderId !== user.id && !m.readAt).length ?? 0;

  useEffect(() => {
    if (open && unread > 0) post(`/rides/${ride.id}/messages/read`).catch(() => {});
  }, [open, unread, ride.id]);

  return (
    <>
      <button
        type="button"
        className="ds-btn ds-btn--outline ds-iconbtn relative"
        onClick={() => setOpen(true)}
        aria-label={`Message ${otherName}${unread ? `, ${unread} unread` : ''}`}
        title={`Message ${otherName}`}
      >
        <MessageCircle aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[0.6875rem] font-bold text-danger-fg">{unread}</span>
        )}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Chat with ${otherName}`}>
        <Conversation rideId={ride.id} data={data} onSent={add} />
      </Modal>
    </>
  );
}

/** Past conversation of a finished ride (read-only), e.g. on the trip receipt. */
export function ChatHistory({ rideId }) {
  const [data] = useRideMessages(rideId);
  if (!data || data.messages.length === 0) return null;
  return (
    <details className="rounded-[var(--radius-lg)] p-4 ring-1 ring-line">
      <summary className="flex min-h-11 cursor-pointer items-center text-small font-semibold">Chat ({data.messages.length})</summary>
      <div className="mt-3">
        <Conversation rideId={rideId} data={data} />
      </div>
    </details>
  );
}

function Conversation({ rideId, data, onSent }) {
  const { user } = useSession();
  const [text, setText] = useState('');
  const [busy, run] = useAction();
  const end = useRef(null);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an
  // effect must not return anything but a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length]);
  if (!data) return <ListSkeleton rows={2} label="Loading messages" />;

  const send = (body) =>
    run(async () => {
      const { message } = await post(`/rides/${rideId}/messages`, { body });
      onSent?.(message);
      setText('');
    });

  return (
    <div className="space-y-3">
      <ul className="max-h-80 space-y-2 overflow-y-auto" aria-live="polite">
        {data.messages.length === 0 && <li className="py-6 text-center text-small text-fg-2">No messages yet. Say where you’re waiting, or pick a quick reply.</li>}
        {data.messages.map((m) => {
          const mine = m.senderId === user.id;
          return (
            <li key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
              <div className={`max-w-[85%] px-3.5 py-2 text-small ${mine ? 'rounded-[var(--radius-md)] rounded-br-[var(--radius-xs)] bg-fg text-ground' : 'rounded-[var(--radius-md)] rounded-bl-[var(--radius-xs)] bg-raised'}`}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={`mt-0.5 text-[0.75rem] ${mine ? 'opacity-75' : 'text-fg-2'}`}>
                  {ago(m.createdAt)}
                  {mine && (m.readAt ? ' · Seen' : ' · Sent')}
                </p>
              </div>
            </li>
          );
        })}
        <li ref={end} />
      </ul>
      {data.open && onSent ? (
        <>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {(data.quickReplies ?? []).map((q) => (
              <Chip key={q} className="whitespace-nowrap" disabled={busy} onClick={() => send(q)}>
                {q}
              </Chip>
            ))}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text);
            }}
          >
            <Input className="min-w-0 flex-1" placeholder="Type a message…" aria-label="Message" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="ds-btn ds-btn--primary ds-iconbtn" aria-label="Send message" title="Send" disabled={busy || !text.trim()}>
              <SendHorizontal aria-hidden />
            </button>
          </form>
          <p className="text-caption text-fg-2">
            {user.role === 'driver' && 'While the vehicle is moving you can only send the quick replies above. '}
            Your phone number is never shared. Hopin support can read this chat if a problem is reported.
          </p>
        </>
      ) : (
        <p className="text-center text-caption text-fg-2">Chat is closed — the trip has ended.</p>
      )}
    </div>
  );
}
