import { Router } from 'express';
import { HttpError, requireAuth, requireRole } from '../auth.js';
import { many, one } from '../db.js';
import { LOYALTY, REFERRAL, applyReferral, loyaltyTier, redeemPoints, referralCode, referralStats } from '../growth.js';

/** Referral codes (riders and drivers) and loyalty points (riders). */

const router = Router();
router.use(requireAuth);

router.get('/referral', async (req, res) => {
  if (req.user.role === 'admin') throw new HttpError(403, 'Admins do not have referral codes');
  res.json({
    code: await referralCode(req.user),
    rules:
      req.user.role === 'driver'
        ? { reward: REFERRAL.driverReward, when: `after the driver you refer completes ${REFERRAL.driverTrips} trips` }
        : { reward: REFERRAL.riderReward, newRiderReward: REFERRAL.riderReward, when: "after the new rider's first paid trip", max: REFERRAL.maxRewardedPerReferrer },
    ...(await referralStats(req.user.id)),
  });
});

router.post('/referral/apply', async (req, res) => {
  if (req.user.role === 'admin') throw new HttpError(403, 'Admins cannot use referral codes');
  res.status(201).json(await applyReferral(req.user, req.body?.code));
});

router.get('/loyalty', requireRole('rider'), async (req, res) => {
  const history = await many(
    `SELECT l.points, l.kind, l.created_at, r.pickup, r.dropoff FROM loyalty_txns l LEFT JOIN rides r ON r.id = l.ride_id
     WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 20`,
    [req.user.id],
  );
  const { loyalty_points: points } = await one('SELECT loyalty_points FROM users WHERE id = $1', [req.user.id]);
  res.json({
    points,
    tier: await loyaltyTier(req.user.id),
    rules: { rupeesPerPoint: LOYALTY.rupeesPerPoint, redeemStep: LOYALTY.redeemStep, rupeesPer100: LOYALTY.rupeesPer100, tiers: LOYALTY.tiers },
    history: history.map((h) => ({
      points: h.points,
      kind: h.kind,
      at: h.created_at,
      trip: h.pickup ? `${h.pickup.address.split(',')[0]} → ${h.dropoff.address.split(',')[0]}` : null,
    })),
  });
});

router.post('/loyalty/redeem', requireRole('rider'), async (req, res) => {
  const rupees = await redeemPoints(req.user.id, Number(req.body?.points));
  res.json({ credited: rupees });
});

export default router;
