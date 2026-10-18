import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { SEVERITY, WATERLOG, activeSpots, reportSpot, vote } from '../waterlog.js';

/** Monsoon waterlogging reports (step 8b batch G). See src/waterlog.js. */

const router = Router();
router.use(requireAuth);

router.get('/', async (_req, res) => {
  res.json({ spots: await activeSpots(), severity: SEVERITY, hours: WATERLOG.hours });
});

router.post('/', requireRole('rider', 'driver'), async (req, res) => {
  const result = await reportSpot(req.user, req.body);
  res.status(result.merged ? 200 : 201).json(result);
});

router.post('/:id/vote', requireRole('rider', 'driver'), async (req, res) => {
  res.json({ spot: await vote(req.user, req.params.id, req.body) });
});

export default router;
