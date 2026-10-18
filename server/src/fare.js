// Fares are whole rupees. Rates loosely track Indian app pricing in 2025-26.
export const VEHICLES = {
  bike: { label: 'Bike', seats: 1, base: 20, perKm: 7, perMin: 1, minimum: 30, speedFactor: 0.85, cancelFee: 15 },
  auto: { label: 'Auto', seats: 3, base: 30, perKm: 11, perMin: 1.5, minimum: 40, speedFactor: 1.0, cancelFee: 25 },
  car: { label: 'Cab', seats: 4, base: 50, perKm: 15, perMin: 2, minimum: 80, speedFactor: 1.0, cancelFee: 40 },
};
export const VEHICLE_TYPES = Object.keys(VEHICLES);
export const STOP_CHARGE = 10;
export const MAX_STOPS = 3;
export const MAX_SURGE = 2;

export function baseFare(type, distanceKm, durationMin) {
  const v = VEHICLES[type];
  if (!v) throw new Error(`Unknown vehicle type: ${type}`);
  return Math.max(v.minimum, Math.round(v.base + v.perKm * distanceKm + v.perMin * durationMin * v.speedFactor));
}

/** Demand-based multiplier: every waiting request beyond the free drivers nearby adds 20%. */
export function surgeFrom(demand, supply) {
  if (demand <= supply) return 1;
  return Math.min(MAX_SURGE, Math.round((1 + 0.2 * (demand - supply)) * 10) / 10);
}

/** Full price breakdown. `discount` is applied last and never makes the fare negative. */
export function priceTrip({ type, distanceKm, durationMin, stops = 0, surge = 1, discount = 0 }) {
  const base = baseFare(type, distanceKm, durationMin);
  const stopCharge = stops * STOP_CHARGE;
  const subtotal = Math.round(base * surge) + stopCharge;
  const appliedDiscount = Math.min(discount, subtotal);
  return { baseFare: base, surge, stopCharge, subtotal, discount: appliedDiscount, fare: subtotal - appliedDiscount };
}

export function etaMinutes(type, durationMin) {
  return Math.max(1, Math.round(durationMin * VEHICLES[type].speedFactor));
}
