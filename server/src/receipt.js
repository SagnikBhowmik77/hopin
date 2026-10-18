import PDFDocument from 'pdfkit';
import { VEHICLES } from './fare.js';

// The built-in PDF fonts have no ₹ glyph, so receipts print "Rs.".
const rs = (n) => `Rs. ${Number(n).toLocaleString('en-IN')}`;
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '-');

/** Renders a one-page receipt for a ride row loaded with RIDE_SQL; `breakdown` from fareBreakdown() adds who got what. */
export function renderReceipt(r, breakdown = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `Hopin receipt ${r.id}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 72;
    doc.rect(0, 0, doc.page.width, 70).fill('#14161a');
    doc.fillColor('#ffc23d').font('Helvetica-Bold').fontSize(22).text('Hopin', 36, 24);
    doc.fillColor('#ffffff').font('Helvetica').fontSize(9).text(r.status === 'cancelled' ? 'CANCELLATION RECEIPT' : 'TRIP RECEIPT', 36, 30, { width: W, align: 'right' });
    doc.text(`#${r.id.slice(0, 8).toUpperCase()}`, 36, 44, { width: W, align: 'right' });

    doc.fillColor('#14161a').moveDown(0).text('', 36, 90);
    doc.font('Helvetica-Bold').fontSize(11).text(`${VEHICLES[r.vehicle_type].label} trip with ${r.driver_name ?? 'no driver'}`);
    doc.font('Helvetica').fontSize(9).fillColor('#5b616e').text(when(r.started_at ?? r.created_at));
    if (r.v_plate) doc.text(`${r.v_model} - ${r.v_plate}`);
    doc.moveDown(0.8);

    const place = (label, p) => {
      doc.fillColor('#5b616e').fontSize(8).text(label.toUpperCase());
      doc.fillColor('#14161a').fontSize(9.5).text(p.address, { width: W });
      doc.moveDown(0.4);
    };
    place('Pickup', r.pickup);
    (r.stops ?? []).forEach((s, i) => place(`Stop ${i + 1}`, s));
    place('Drop', r.dropoff);
    doc.fillColor('#5b616e').fontSize(8.5).text(`${r.distance_km} km  ·  ${r.duration_min} min (estimated)`);
    doc.moveDown(1);

    const line = (label, value, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor('#14161a');
      doc.text(label, 36, y, { width: W / 2 });
      doc.text(value, 36 + W / 2, y, { width: W / 2, align: 'right' });
      doc.moveDown(0.35);
    };
    doc.moveTo(36, doc.y).lineTo(36 + W, doc.y).strokeColor('#e3e5ea').stroke().moveDown(0.6);
    if (r.status === 'cancelled') {
      line('Cancellation fee', rs(r.cancellation_fee));
      line('Total', rs(r.cancellation_fee), true);
    } else if (r.kind === 'rental' && r.rental) {
      line(`Rental: ${r.rental.name}`, rs(r.rental.price));
      if (r.rental_extra) line(`Extra km / time (${Number(r.actual_km ?? 0).toFixed(1)} km driven)`, rs(r.rental_extra));
      doc.moveTo(36, doc.y).lineTo(36 + W, doc.y).stroke().moveDown(0.5);
      line('Total', rs(r.fare), true);
    } else {
      line(r.kind === 'parcel' ? 'Delivery fare' : 'Trip fare', rs(r.base_fare));
      if (r.surge > 1) line(`Demand surge (${r.surge}x)`, rs(Math.round(r.base_fare * r.surge) - r.base_fare));
      if (r.stop_charge) line(`Extra stops (${r.stops.length})`, rs(r.stop_charge));
      if (r.discount) line(`Promo ${r.promo_code ?? ''}`.trim(), `- ${rs(r.discount)}`);
      if (r.lock_saving) line('Price lock', `- ${rs(r.lock_saving)}`);
      doc.moveTo(36, doc.y).lineTo(36 + W, doc.y).stroke().moveDown(0.5);
      line('Total', rs(r.fare), true);
    }
    doc.moveDown(0.6);
    const paid = r.payment_status === 'paid';
    doc.font('Helvetica').fontSize(9).fillColor(paid ? '#0e7a4f' : '#b4231b');
    doc.text(paid ? `Paid by ${r.payment_method.toUpperCase()} on ${when(r.paid_at)}  ·  Ref ${r.payment_ref}` : 'Payment pending', { width: W });

    if (breakdown) {
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#14161a').text('Where your money went', 36, doc.y);
      doc.moveDown(0.3);
      line(`Driver ${r.driver_name ?? ''} (${breakdown.driverSharePct}%)`.replace('  ', ' '), rs(breakdown.driverFare));
      line('Hopin', rs(breakdown.hopinFare));
      if (breakdown.tip) line('Your tip (100% to the driver)', rs(breakdown.tip));
      if (breakdown.cash) {
        doc.font('Helvetica').fontSize(8).fillColor('#5b616e').text("Paid in cash to the driver; Hopin's share is taken from the driver's Hopin wallet.", 36, doc.y, { width: W });
      }
    }

    doc.fillColor('#8a909c').fontSize(7.5).text(`Rider: ${r.rider_name}  ·  Generated ${when(new Date())}`, 36, doc.page.height - 50, { width: W, align: 'center' });
    doc.end();
  });
}
