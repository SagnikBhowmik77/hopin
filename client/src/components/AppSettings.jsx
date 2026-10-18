import { useEffect, useState } from 'react';
import { BellRing, Languages, Monitor, Moon, Palette, Send, Smartphone, Sun } from 'lucide-react';
import { api, post } from '../api.js';
import { currentSubscription, disablePush, enablePush, isInstalled, isIOS, promptInstall, pushSupported, useInstallPrompt } from '../pwa.js';
import { toast, useAction } from './ui.jsx';
import LanguageSwitch from './LanguageSwitch.jsx';
import { Button, Chip, Skeleton } from '../ds/index.js';
import { setTheme, useTheme } from '../ds/theme.js';
import { t as tr } from '../i18n/index.js';

function Row({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-wrap items-start gap-3 py-3.5 first:pt-0 last:pb-0">
      <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-raised" aria-hidden>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-semibold">{title}</p>
        <div className="text-small text-fg-2">{children}</div>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

/** Profile: theme and language, install Hopin as an app, and ride notifications on this device (step 9). */
export default function AppSettings() {
  const installEvent = useInstallPrompt();
  const [installed] = useState(isInstalled);
  const [state, setState] = useState(null); // { serverOn, here, devices, permission }
  const [busy, run] = useAction();
  const [themeChoice] = useTheme();

  const load = async () => {
    const info = await api('/push').catch(() => ({ enabled: false, devices: 0 }));
    const sub = await currentSubscription().catch(() => null);
    setState({ serverOn: info.enabled, here: Boolean(sub), devices: info.devices, permission: 'Notification' in window ? Notification.permission : 'unsupported' });
  };
  useEffect(() => {
    load();
  }, []);

  const turnOn = () =>
    run(async () => {
      await enablePush();
      await load();
      toast('Notifications are on for this device', 'ok');
    });
  const turnOff = () =>
    run(async () => {
      await disablePush();
      await load();
      toast('Notifications are off for this device', 'ok');
    });
  const test = () =>
    run(async () => {
      const r = await post('/push/test');
      toast(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}. It should appear in a few seconds.` : 'No device accepted it. Turn notifications off and on again.', r.sent ? 'ok' : 'error');
    });

  return (
    <div className="divide-y divide-line">
      <Row icon={Palette} title={tr('Appearance')}>
        <div className="flex flex-wrap gap-2 pt-2" role="radiogroup" aria-label="Theme">
          {[
            ['system', tr('System'), Monitor],
            ['light', tr('Light'), Sun],
            ['dark', tr('Dark'), Moon],
          ].map(([k, label, Icon]) => (
            <Chip key={k} role="radio" aria-checked={themeChoice === k} selected={themeChoice === k} icon={Icon} onClick={() => setTheme(k)}>
              {label}
            </Chip>
          ))}
        </div>
      </Row>
      <Row icon={Languages} title={tr('Language')}>
        <div className="pt-2">
          <LanguageSwitch />
        </div>
      </Row>
      <Row
        icon={Smartphone}
        title="Hopin app"
        action={
          !installed &&
          installEvent && (
            <Button size="sm" variant="secondary" onClick={() => promptInstall()}>
              Install
            </Button>
          )
        }
      >
        {installed
          ? 'Hopin is installed on this device.'
          : installEvent
            ? 'Add Hopin to your home screen. It opens like an app, full screen.'
            : isIOS()
              ? 'On iPhone: tap Share, then “Add to Home Screen”.'
              : 'Use your browser menu, then “Install app” or “Add to Home screen”.'}
      </Row>
      <Row
        icon={BellRing}
        title="Ride notifications on this device"
        action={
          state?.serverOn &&
          pushSupported() &&
          state.permission !== 'denied' &&
          (state.here ? (
            <>
              <Button size="sm" variant="outline" icon={Send} disabled={busy} onClick={test}>
                Send test
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={turnOff}>
                Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" loading={busy} onClick={turnOn}>
              Turn on
            </Button>
          ))
        }
      >
        {!state ? (
          <Skeleton width="80%" height={14} className="mt-1" />
        ) : !state.serverOn ? (
          'Push notifications are not set up on this server.'
        ) : !pushSupported() ? (
          isIOS() ? 'On iPhone, add Hopin to your Home Screen first, then turn notifications on from the installed app.' : 'This browser cannot show notifications.'
        ) : state.permission === 'denied' ? (
          'Notifications are blocked for this site. Allow them in your browser settings, then come back.'
        ) : state.here ? (
          `On. You’ll get driver updates, safety alerts and payments here, even with Hopin closed.${state.devices > 1 ? ` (${state.devices} devices in total)` : ''}`
        ) : (
          'Off. Turn on to get driver updates even with Hopin closed.'
        )}
      </Row>
    </div>
  );
}
