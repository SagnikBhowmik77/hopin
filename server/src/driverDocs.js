import { many, one } from './db.js';

/**
 * Driver verification is derived, never stored as a flag: a driver may drive only
 * while the NEWEST document of every required type is approved, unexpired, and
 * (for RC/insurance) belongs to the vehicle currently on their profile.
 */

export const DOC_TYPES = {
  driving_licence: { label: 'Driving licence', number: 'Licence number', expires: true, perVehicle: false },
  vehicle_rc: { label: 'Vehicle RC (registration certificate)', number: null, expires: false, perVehicle: true },
  insurance: { label: 'Vehicle insurance', number: 'Policy number', expires: true, perVehicle: true },
  driver_photo: { label: 'Your photo (face clearly visible)', number: null, expires: false, perVehicle: false },
};
export const DOC_TYPE_KEYS = Object.keys(DOC_TYPES);

/** Today's date in India as YYYY-MM-DD, for expiry checks. */
export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const DOC_COLUMNS = `id, driver_id, doc_type, storage_path, mime_type, size_bytes, doc_number,
  to_char(expires_on, 'YYYY-MM-DD') AS expires_on, vehicle_plate, status, reject_reason,
  reviewed_at, created_at`;

/** The newest document of each type for one driver. */
export function currentDocs(driverId) {
  return many(
    `SELECT DISTINCT ON (doc_type) ${DOC_COLUMNS} FROM driver_documents WHERE driver_id = $1 ORDER BY doc_type, created_at DESC`,
    [driverId],
  );
}

export const toDoc = (d) => ({
  id: d.id,
  type: d.doc_type,
  mimeType: d.mime_type,
  sizeBytes: d.size_bytes,
  number: d.doc_number,
  expiresOn: d.expires_on,
  vehiclePlate: d.vehicle_plate,
  status: d.status,
  rejectReason: d.reject_reason,
  reviewedAt: d.reviewed_at,
  uploadedAt: d.created_at,
});

/**
 * Per-type state: missing | pending | rejected | expired | wrong_vehicle | approved.
 * `canDrive` is true only if every type is approved.
 */
export function evaluate(docs, plate, today = todayIST()) {
  const byType = Object.fromEntries(docs.map((d) => [d.doc_type, d]));
  const items = DOC_TYPE_KEYS.map((type) => {
    const d = byType[type];
    let state;
    if (!d) state = 'missing';
    else if (DOC_TYPES[type].perVehicle && d.vehicle_plate !== plate) state = 'wrong_vehicle';
    else if (d.expires_on && d.expires_on < today) state = 'expired';
    else state = d.status;
    return { type, label: DOC_TYPES[type].label, state, doc: d ? toDoc(d) : null };
  });
  const canDrive = items.every((i) => i.state === 'approved');
  const blocking = items.filter((i) => i.state !== 'approved');
  let message = null;
  if (!canDrive) {
    if (blocking.some((i) => ['missing', 'rejected', 'expired', 'wrong_vehicle'].includes(i.state))) {
      message = 'Upload your missing or rejected documents in Documents before you can drive.';
    } else {
      message = 'Your documents are being reviewed. You can drive once they are approved.';
    }
  }
  return { canDrive, message, items };
}

/** Full verification for one driver, read fresh from the database. */
export async function driverVerification(driverId) {
  const vehicle = await one('SELECT plate FROM vehicles WHERE driver_id = $1', [driverId]);
  return evaluate(await currentDocs(driverId), vehicle?.plate ?? null);
}
