import { HttpError } from './auth.js';

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase().slice(0, 24);

/**
 * Checks a promo code for this rider and fare. Returns { code, discount, description }
 * or throws a 400 explaining why it does not apply. `q` is `query` or a transaction's query.
 */
export async function evaluatePromo(q, rawCode, userId, subtotal) {
  const code = normalizeCode(rawCode);
  const promo = (await q('SELECT * FROM promos WHERE code = $1', [code])).rows[0];
  if (!promo || !promo.active) throw new HttpError(400, `"${code}" is not a valid promo code`);
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) throw new HttpError(400, `${code} has expired`);
  if (subtotal < promo.min_fare) throw new HttpError(400, `${code} needs a fare of at least ₹${promo.min_fare}`);

  const counts = (
    await q(
      `SELECT
         (SELECT count(*)::int FROM promo_redemptions WHERE code = $1) AS total,
         (SELECT count(*)::int FROM promo_redemptions pr JOIN rides r ON r.id = pr.ride_id
            WHERE pr.code = $1 AND pr.user_id = $2 AND r.status <> 'cancelled') AS mine,
         (SELECT count(*)::int FROM rides WHERE rider_id = $2 AND status = 'completed') AS completed`,
      [code, userId],
    )
  ).rows[0];
  if (promo.usage_limit != null && counts.total >= promo.usage_limit) throw new HttpError(400, `${code} has been fully used`);
  if (counts.mine >= promo.per_user_limit) throw new HttpError(400, `You have already used ${code}`);
  if (promo.first_ride_only && counts.completed > 0) throw new HttpError(400, `${code} is only for your first ride`);

  let discount = promo.kind === 'percent' ? Math.round((subtotal * promo.value) / 100) : promo.value;
  if (promo.max_discount != null) discount = Math.min(discount, promo.max_discount);
  return { code, discount: Math.min(discount, subtotal), description: promo.description };
}
