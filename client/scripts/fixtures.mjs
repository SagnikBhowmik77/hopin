// Realistic Kolkata content for design screenshots (scripts/shots.mjs). Shapes match the API.
const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();

export const PICKUP = { lat: 22.5535, lng: 88.3525, address: 'Park Street Metro, Gate 2, Park Street, Kolkata' };
export const DROP = { lat: 22.5726, lng: 88.4339, address: 'Technopolis, Sector V, Salt Lake, Kolkata' };
export const ROUTE = [
  [22.5535, 88.3525], [22.5549, 88.3576], [22.5567, 88.3643], [22.5592, 88.3712], [22.5603, 88.3789], [22.5618, 88.3874],
  [22.5636, 88.3958], [22.5655, 88.4041], [22.5671, 88.4127], [22.5689, 88.4203], [22.5706, 88.4271], [22.5726, 88.4339],
];

export const users = {
  rider: {
    id: 'u-rider', name: 'Ananya Sen', email: 'ananya.sen@example.in', phone: '+919830041275', phoneVerified: true, role: 'rider', avatar: null,
    rating: 4.9, ratingCount: 31, walletBalance: 640, defaultPayment: 'cash', emergencyContacts: [{ name: 'Ma', phone: '+919830011122' }],
    tripPin: null, driverDeaf: false, shareTripsWithFamily: true, language: 'en', vehicle: null, createdAt: ago(60 * 24 * 90),
  },
  driver: {
    id: 'u-driver', name: 'Rakesh Mondal', email: 'rakesh.mondal@example.in', phone: '+919836052211', phoneVerified: true, role: 'driver', avatar: null,
    rating: 4.9, ratingCount: 412, walletBalance: 1840, defaultPayment: 'cash', emergencyContacts: [], tripPin: null, driverDeaf: false,
    shareTripsWithFamily: false, language: 'en', vehicle: { type: 'car', model: 'Maruti Dzire', plate: 'WB 04 K 2211' }, createdAt: ago(60 * 24 * 400),
  },
  admin: {
    id: 'u-admin', name: 'Priya Ghosh', email: 'ops@hopin.in', phone: '+919999900001', phoneVerified: true, role: 'admin', avatar: null, rating: 5, ratingCount: 0,
    walletBalance: 0, defaultPayment: 'cash', emergencyContacts: [], language: 'en', vehicle: null, createdAt: ago(60 * 24 * 400),
  },
};

const price = (fare, extra = {}) => ({ baseFare: fare, surge: 1, stopCharge: 0, discount: 0, subtotal: fare, fare, ...extra });

export const quote = {
  route: { distanceKm: 9.4, durationMin: 28, geometry: ROUTE, estimated: false },
  waterlog: { spots: [], delayMin: 0, impassable: false },
  options: [
    { type: 'bike', label: 'Bike', seats: 1, etaMin: 24, waterlogDelayMin: 0, price: price(56), promo: null, promoError: null, demand: null, lockOffer: { lockedFare: 56, fee: 49, days: 7 } },
    { type: 'auto', label: 'Auto', seats: 3, etaMin: 31, waterlogDelayMin: 0, price: price(92), promo: null, promoError: null, demand: null, lockOffer: { lockedFare: 92, fee: 49, days: 7 } },
    { type: 'car', label: 'Cab', seats: 4, etaMin: 28, waterlogDelayMin: 0, price: price(184), promo: null, promoError: null, demand: null, lockOffer: { lockedFare: 184, fee: 49, days: 7 } },
  ],
};

const driverInfo = {
  id: 'u-driver', name: 'Rakesh Mondal', avatar: null, rating: 4.9, ratingCount: 412, deaf: false, drivingMin: 95, rested: true,
  vehicle: { type: 'car', model: 'Maruti Dzire', plate: 'WB 04 K 2211' },
};

export function ride(status, over = {}) {
  const withDriver = !['requested', 'scheduled'].includes(status) && !(status === 'cancelled' && !over.withDriver);
  return {
    id: 'r-5f2c9a10', status, vehicleType: 'car', pickup: PICKUP, stops: [], dropoff: DROP, route: ROUTE, distanceKm: 9.4, durationMin: 28,
    price: { baseFare: 184, surge: 1, stopCharge: 0, discount: 0, promoCode: null, fare: 184, cancellationFee: 0, due: 184 },
    payment: { method: 'cash', status: status === 'completed' ? 'paid' : 'due', ref: null, paidAt: null, upi: null },
    otp: '4826', shareToken: 'tok123', pickupEtaMin: 4, scheduledFor: null, kind: 'trip', passenger: null, rental: null, parcel: null,
    accessibility: [], lockSaving: 0, routeWatched: true, rider: { id: 'u-rider', name: 'Ananya Sen', avatar: null },
    driver: withDriver ? driverInfo : null,
    driverLocation: withDriver ? { lat: 22.5549, lng: 88.3566 } : null,
    review: null, cancelledBy: null, cancelReason: null, createdAt: ago(2), acceptedAt: withDriver ? ago(1) : null, arrivedAt: null,
    startedAt: status === 'ongoing' || status === 'completed' ? ago(12) : null, completedAt: status === 'completed' ? ago(0) : null, cancelledAt: null,
    alerts: [],
    ...over,
  };
}

// --- driver ---
export const earnings = { earnings: { today: 1264, week: 8930 }, trips: { today: 9, total: 1412 }, rating: 4.9, ratingCount: 412, walletBalance: 1840 };
export const verification = (ok) => ({
  canDrive: ok,
  message: ok ? 'All documents approved.' : 'Upload your insurance and wait for review before you go online.',
  items: [
    { type: 'driving_licence', label: 'Driving licence', state: 'approved', doc: { id: 'd1', number: 'WB0420190012345', expiresOn: '2034-03-11', uploadedAt: ago(60 * 24 * 40) } },
    { type: 'vehicle_rc', label: 'Vehicle RC', state: 'approved', doc: { id: 'd2', uploadedAt: ago(60 * 24 * 40) } },
    { type: 'insurance', label: 'Insurance', state: ok ? 'approved' : 'rejected', doc: { id: 'd3', number: 'OG-24-2211-1801', expiresOn: '2026-11-30', uploadedAt: ago(60 * 26), rejectReason: 'The policy number is cut off. Upload the full page.' } },
    { type: 'driver_photo', label: 'Your photo', state: ok ? 'approved' : 'pending', doc: { id: 'd4', uploadedAt: ago(60 * 3) } },
  ],
});
export const driverPayouts = {
  enabled: true,
  minAmount: 200,
  walletBalance: 1840,
  method: { kind: 'upi', label: 'UPI rakesh.mondal@oksbi' },
  payouts: [{ id: 'po1', amount: 2500, status: 'paid', requestedAt: ago(60 * 24 * 6), reference: '404912345678' }],
};
export const offer = { ...ride('requested'), id: 'r-offer-1', pickupDistanceKm: 1.2, distanceKm: 9.4, rider: { id: 'u-rider', name: 'Ananya Sen', avatar: null } };

// --- admin ---
export const admin = {
  overview: { riders: 18240, drivers: 1312, online_drivers: 286, active_rides: 74, completed_today: 3918, gmv_today: 512460, open_sos: 1, open_deviations: 2, unconfirmed_night_rides: 0, pending_helmets: 3, open_tickets: 7 },
  sos: [
    {
      id: 's1', status: 'open', createdAt: ago(4), user: { name: 'Ritika Das', role: 'rider', phone: '+919831000111' }, driver: { name: 'Sujoy Pal', plate: 'WB 02 AC 4410', phone: '+919830222333' },
      location: { lat: 22.5412, lng: 88.3468 }, trackPath: '/track/tok-sos', smsResults: [{ name: 'Ma', status: 'sent' }, { name: 'Arko', status: 'sent' }],
    },
    { id: 's2', status: 'resolved', createdAt: ago(60 * 5), user: { name: 'Imran Hossain', role: 'driver', phone: '+919836111444' }, driver: null, location: null, trackPath: '/track/tok-2', smsResults: [] },
  ],
  tickets: [
    { id: 't1', subject: 'Charged twice for my Sector V trip', status: 'open', category: 'payment', user: { name: 'Ananya Sen' }, messageCount: 2, updatedAt: ago(12), rideId: 'r-5f2c9a10' },
    { id: 't2', subject: 'Driver took a longer route via EM Bypass', status: 'in_progress', category: 'ride', user: { name: 'Soham Roy' }, messageCount: 4, updatedAt: ago(70) },
    { id: 't3', subject: 'Left my umbrella in the cab', status: 'resolved', category: 'lost_item', user: { name: 'Mou Banerjee' }, messageCount: 3, updatedAt: ago(60 * 20) },
  ],
  deviations: [
    { id: 'dv1', status: 'open', kind: 'off_route', driver: { name: 'Sujoy Pal', plate: 'WB 02 AC 4410' }, rider: { name: 'Ritika Das' }, distanceM: 820, maxDistanceM: 1340, alertedAt: ago(6), trackPath: '/track/tok-sos' },
    { id: 'dv2', status: 'resolved', kind: 'long_stop', driver: { name: 'Bikram Saha', plate: 'WB 06 F 9182' }, rider: { name: 'Neel Chatterjee' }, startedAt: ago(90), alertedAt: ago(80), resolvedAt: ago(75), resolution: 'rider_ok', checkedAt: ago(74) },
  ],
  helmet: [{ id: 'h1', status: 'pending', driver: { name: 'Arijit Ghosh', plate: 'WB 05 BT 3321' }, takenOn: '18 Oct', createdAt: ago(9), url: null }],
  drivers: [
    { id: 'u-driver', name: 'Rakesh Mondal', email: 'rakesh.mondal@example.in', phone: '+919836052211', phoneVerified: true, vehicle: { model: 'Maruti Dzire', plate: 'WB 04 K 2211' }, pendingDocs: 0, canDrive: true },
    { id: 'u-d2', name: 'Arijit Ghosh', email: 'arijit.g@example.in', phone: '+919830998877', phoneVerified: true, vehicle: { model: 'Honda Shine', plate: 'WB 05 BT 3321' }, pendingDocs: 2, canDrive: false },
  ],
  promos: [
    { code: 'PUJO50', kind: 'percent', value: 50, max_discount: 75, min_fare: 100, first_ride_only: false, per_user_limit: 2, used: 1840, usage_limit: 5000, expires_at: '2026-10-24T18:29:59Z', active: true },
    { code: 'FIRSTRIDE', kind: 'flat', value: 60, max_discount: null, min_fare: 80, first_ride_only: true, per_user_limit: 1, used: 912, usage_limit: null, expires_at: null, active: true },
  ],
  payouts: [{ id: 'po2', status: 'requested', amount: 3200, driver: { name: 'Rakesh Mondal' }, label: 'UPI rakesh.mondal@oksbi', requestedAt: ago(40), detailViews: 0 }],
  packages: [
    { id: 'pk1', name: '4 hours · 40 km', vehicleType: 'car', hours: 4, km: 40, price: 899, extraKmRate: 14, extraMinRate: 2, active: true, seasonal: false },
    { id: 'pk2', name: 'Puja pandal hopping', vehicleType: 'auto', hours: 6, km: 45, price: 999, extraKmRate: 12, extraMinRate: 2, active: true, seasonal: true, availableFrom: '2026-10-17', availableTo: '2026-10-24' },
  ],
  insights: {
    days: [5, 4, 3, 2, 1, 0, -1].map((back, i) => ({
      day: new Date(now - (back + 1) * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10),
      completed: [3120, 2980, 3305, 3410, 3762, 4105, 3918][i],
      cancelled: [212, 198, 240, 251, 266, 302, 284][i],
      paid: [402110, 385660, 428930, 441870, 489120, 534400, 512460][i],
    })),
    vehicles: [
      { type: 'bike', trips: 41210 },
      { type: 'auto', trips: 27480 },
      { type: 'car', trips: 34950 },
    ],
    live: {
      drivers: [
        { lat: 22.5535, lng: 88.3525, vehicleType: 'car' }, { lat: 22.5726, lng: 88.4339, vehicleType: 'bike' }, { lat: 22.5179, lng: 88.3631, vehicleType: 'auto' },
        { lat: 22.5868, lng: 88.4171, vehicleType: 'car' }, { lat: 22.5412, lng: 88.3468, vehicleType: 'bike' }, { lat: 22.5958, lng: 88.2636, vehicleType: 'car' },
      ],
      rides: [
        { id: 'l1', status: 'ongoing', vehicleType: 'car', pickup: PICKUP, dropoff: DROP },
        { id: 'l2', status: 'requested', vehicleType: 'auto', pickup: { lat: 22.5048, lng: 88.3712, address: 'Jadavpur, Kolkata' }, dropoff: DROP },
        { id: 'l3', status: 'accepted', vehicleType: 'bike', pickup: { lat: 22.5797, lng: 88.4045, address: 'Salt Lake Stadium, Kolkata' }, dropoff: PICKUP },
      ],
    },
  },
  routing: { provider: 'openrouteservice', orsConfigured: true, orsRemaining: 1874, orsResetAt: new Date(now + 6 * 3600_000).toISOString(), orsCalls: 126, osrmCalls: 4, lastError: null },
};

export const history = [
  ride('completed', { id: 'r-5f2c9a10' }),
  ride('completed', { id: 'r-2', vehicleType: 'auto', pickup: { lat: 22.5179, lng: 88.3631, address: 'Gariahat Market, Kolkata' }, dropoff: { lat: 22.5448, lng: 88.3426, address: 'Victoria Memorial, Kolkata' }, price: { ...ride('completed').price, fare: 92, due: 92 }, createdAt: ago(60 * 26) }),
  ride('cancelled', { id: 'r-3', vehicleType: 'bike', cancelledBy: 'rider', cancelReason: 'Changed my plans', price: { ...ride('completed').price, fare: 56, due: 0, cancellationFee: 0 }, createdAt: ago(60 * 50) }),
  ride('completed', { id: 'r-4', pickup: { lat: 22.6547, lng: 88.4467, address: 'Netaji Subhas Chandra Bose International Airport, Kolkata' }, payment: { method: 'upi', status: 'due', ref: null, paidAt: null, upi: 'ananya.sen@okhdfc' }, price: { ...ride('completed').price, fare: 412, due: 412 }, createdAt: ago(60 * 24 * 4) }),
];
export const walletTxns = [
  { id: 'w1', kind: 'topup', amount: 500, created_at: ago(60 * 24 * 3) },
  { id: 'w2', kind: 'ride', amount: -184, created_at: ago(60 * 24 * 2) },
];
export const ticketThread = {
  ticket: { ...admin.tickets[0], createdAt: ago(40), user: { name: 'Ananya Sen', role: 'rider' } },
  messages: [
    { id: 'm1', author: { id: 'u-rider', name: 'Ananya Sen', role: 'rider' }, body: 'I paid ₹184 by UPI and the app also took it from my wallet. Please refund one of them.', createdAt: ago(40) },
    { id: 'm2', author: { id: 'u-admin', name: 'Priya Ghosh', role: 'admin' }, body: 'Sorry about that, Ananya. I can see both payments. The wallet one is refunded and should show within a minute.', createdAt: ago(12) },
  ],
};
export const track = {
  status: 'ongoing', riderName: 'Ananya', pickup: PICKUP, stops: [], dropoff: DROP, route: ROUTE,
  driverLocation: { lat: 22.5618, lng: 88.3874 }, driver: { name: 'Rakesh Mondal', vehicle: { type: 'car', model: 'Maruti Dzire', plate: 'WB 04 K 2211' } },
};

export const searchResults = [
  { label: 'Technopolis, Sector V, Salt Lake, Kolkata', lat: 22.5726, lng: 88.4339 },
  { label: 'Sector V Metro Station, Salt Lake, Kolkata', lat: 22.5768, lng: 88.4297 },
  { label: 'Salt Lake Stadium, Bidhannagar, Kolkata', lat: 22.5694, lng: 88.4093 },
];

export const savedPlaces = [
  { id: 'p1', name: 'Home', kind: 'home', address: 'Lake Gardens, Kolkata', lat: 22.5013, lng: 88.3527 },
  { id: 'p2', name: 'Work', kind: 'work', address: 'Technopolis, Sector V, Salt Lake', lat: 22.5726, lng: 88.4339 },
];

export const notifications = [
  { id: 'n1', title: 'Driver assigned', body: 'Rakesh Mondal · Maruti Dzire WB 04 K 2211 · arriving in ~4 min.', link: '/book', read: false, createdAt: ago(3) },
  { id: 'n2', title: 'Payment received', body: '₹212 paid by UPI. Your receipt is in Trips.', link: '/trips', read: true, createdAt: ago(60 * 26) },
];
