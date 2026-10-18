import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { deviceCount, pushEnabled, sendPush, subscribe, unsubscribe } from '../push.js';

/** Web Push sign-up for this browser (step 9). See src/push.js. */

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: pushEnabled() ? config.push.publicKey : null, devices: await deviceCount(req.user.id) });
});

router.post('/subscribe', async (req, res) => {
  await subscribe(req.user, req.body?.subscription, req.get('user-agent'));
  res.status(201).json({ devices: await deviceCount(req.user.id) });
});

router.post('/unsubscribe', async (req, res) => {
  await unsubscribe(req.user, req.body?.endpoint);
  res.json({ devices: await deviceCount(req.user.id) });
});

/** Sends a real push to this user's own devices, so they can see it works. */
router.post('/test', async (req, res) => {
  const result = await sendPush(req.user.id, { title: 'Hopin notifications are on', body: 'You will get ride updates here, even with Hopin closed.', link: '/profile', tag: 'test' });
  res.json(result);
});

export default router;
