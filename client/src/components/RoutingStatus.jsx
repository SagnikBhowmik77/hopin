import { useEffect, useState } from 'react';
import { Route } from 'lucide-react';
import { api } from '../api.js';
import { Badge, KeyValue, ListSkeleton, Section } from '../ds/index.js';
import { when } from '../util.js';

const NAME = { openrouteservice: 'OpenRouteService', osrm: 'OSRM public server', none: 'Straight-line estimate only' };

/** Admin: which service live trip ETAs use (step 11), and what is left of today's free quota. */
export default function RoutingStatus() {
  const [s, setS] = useState(null);
  useEffect(() => {
    const load = () => api('/admin/routing').then(setS).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Section
      title="Live ETA routing"
      icon={Route}
      action={s && <Badge tone={s.provider === 'openrouteservice' ? 'success' : s.provider === 'osrm' ? 'warning' : 'danger'}>{NAME[s.provider]}</Badge>}
    >
      {!s ? (
        <ListSkeleton rows={1} label="Loading routing status" />
      ) : (
        <>
          {!s.orsConfigured && <p className="text-small text-fg-2">Add ORS_API_KEY to use OpenRouteService.</p>}
          {s.orsConfigured && (
            <KeyValue
              rows={[
                ['ORS quota left', s.orsRemaining ?? 'Not known yet'],
                s.orsResetAt && ['Resets', when(s.orsResetAt)],
                ['Calls since start', `${s.orsCalls} ORS · ${s.osrmCalls} OSRM`],
              ]}
            />
          )}
          {s.lastError && <p className="text-caption text-fg-2">Last routing error: {s.lastError}</p>}
        </>
      )}
    </Section>
  );
}
