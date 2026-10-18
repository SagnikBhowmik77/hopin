import { one } from './db.js';
import { todayIST } from './driverDocs.js';

/**
 * Daily helmet selfie for bike drivers. One selfie per India day lets the driver go online
 * straight away; admins review it afterwards. A rejected selfie blocks going online until
 * a new one is taken. There is no automatic image check: a person looks at it.
 */

export const toHelmetCheck = (h) =>
  h && {
    id: h.id,
    takenOn: h.taken_on,
    status: h.status,
    rejectReason: h.reject_reason,
    createdAt: h.created_at,
    reviewedAt: h.reviewed_at,
  };

/** Today's newest selfie for a driver, or null. */
export const todaysHelmetCheck = (driverId) =>
  one(
    `SELECT *, to_char(taken_on, 'YYYY-MM-DD') AS taken_on FROM helmet_checks
     WHERE driver_id = $1 AND taken_on = $2::date ORDER BY created_at DESC LIMIT 1`,
    [driverId, todayIST()],
  );

/** Whether this driver may go online as far as the helmet check is concerned. */
export async function helmetStatus(driverId, vehicleType) {
  if (vehicleType !== 'bike') return { required: false, canDrive: true, today: null, message: null };
  const today = toHelmetCheck(await todaysHelmetCheck(driverId));
  if (!today) return { required: true, canDrive: false, today, message: "Take today's helmet selfie before going online." };
  if (today.status === 'rejected') {
    return { required: true, canDrive: false, today, message: `Your helmet selfie was rejected: ${today.rejectReason}. Take a new one to go online.` };
  }
  return { required: true, canDrive: true, today, message: null };
}
