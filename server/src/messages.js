import { one } from './db.js';
import { notify } from './notify.js';

/**
 * Everything Hopin's server says to riders and drivers, in English and Hindi (step 10). Each
 * notification is [title, body]; each SMS is one string. Messages to admins stay in English.
 * Text people type themselves (reasons, comments, addresses, names) is passed through as written.
 *
 * The Hindi uses the words Indian ride apps use (राइड, ड्राइवर, वॉलेट, OTP). Have a native speaker
 * review it before launch.
 */

export const LANGUAGES = ['en', 'hi'];
const rs = (n) => `₹${Math.round(n ?? 0).toLocaleString('en-IN')}`;

/** A pickup time the way people read it, in their language (India time). */
export function timeIn(lang, iso) {
  return new Date(iso).toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const DOC = {
  driving_licence: { en: 'Driving licence', hi: 'ड्राइविंग लाइसेंस' },
  vehicle_rc: { en: 'Vehicle RC', hi: 'गाड़ी की RC' },
  insurance: { en: 'Vehicle insurance', hi: 'गाड़ी का बीमा' },
  driver_photo: { en: 'Your photo', hi: 'आपकी फ़ोटो' },
};
const docName = (doc, lang) => (DOC[doc] ?? { en: 'Document', hi: 'दस्तावेज़' })[lang];
const VEHICLE = { bike: { en: 'Bike', hi: 'बाइक' }, auto: { en: 'Auto', hi: 'ऑटो' }, car: { en: 'Cab', hi: 'कैब' } };
const PAID_TWICE = {
  ride: { en: 'This ride was already paid', hi: 'इस राइड का भुगतान पहले ही हो चुका था' },
  tip: { en: 'This trip was already tipped', hi: 'इस ट्रिप पर टिप पहले ही दी जा चुकी थी' },
  split: { en: 'This fare-split request was already closed', hi: 'किराया बाँटने का यह अनुरोध पहले ही बंद हो चुका था' },
  price_lock: { en: 'The price lock could not be created (you may already have the maximum)', hi: 'प्राइस लॉक नहीं बन सका (शायद आपके पास पहले से अधिकतम लॉक हैं)' },
  driver_pass: { en: 'You already had a pass for today', hi: 'आज का पास आपके पास पहले से था' },
};
const paidTwice = (kind, lang) => (PAID_TWICE[kind] ?? PAID_TWICE.ride)[lang];

const M = {
  // --- ride flow -------------------------------------------------------------------------
  noDrivers: {
    en: (v) => ['No drivers available', v.time ? `No driver accepted your ${v.time} scheduled pickup. You were not charged. Try booking again now.` : 'Nobody accepted your request in time. Try again or pick another vehicle.'],
    hi: (v) => ['कोई ड्राइवर उपलब्ध नहीं', v.time ? `${v.time} की आपकी शेड्यूल्ड पिकअप किसी ड्राइवर ने स्वीकार नहीं की। आपसे कोई पैसा नहीं लिया गया। अभी दोबारा बुक करें।` : 'समय पर किसी ड्राइवर ने आपकी राइड स्वीकार नहीं की। फिर से कोशिश करें या दूसरी गाड़ी चुनें।'],
  },
  scheduledCancelled: {
    en: (v) => ['Scheduled ride cancelled', `${v.time} pickup: ${v.why === 'busy' ? 'you had another ride in progress at that time' : 'Hopin could not look for a driver in time'}. You were not charged.`],
    hi: (v) => ['शेड्यूल्ड राइड रद्द', `${v.time} की पिकअप: ${v.why === 'busy' ? 'उस समय आपकी दूसरी राइड चल रही थी' : 'Hopin समय पर ड्राइवर नहीं ढूँढ सका'}। आपसे कोई पैसा नहीं लिया गया।`],
  },
  findingDriver: {
    en: (v) => ['Finding your driver', `Your ${v.time} pickup is being offered to nearby drivers now.`],
    hi: (v) => ['आपके लिए ड्राइवर ढूँढ रहे हैं', `${v.time} की आपकी पिकअप अभी आस-पास के ड्राइवरों को भेजी जा रही है।`],
  },
  surgeNormal: {
    en: (v) => ['Prices are back to normal', `${VEHICLE[v.vehicle].en} near ${v.place}: no surge right now. Book soon, it can change.`],
    hi: (v) => ['किराया फिर से सामान्य है', `${v.place} के पास ${VEHICLE[v.vehicle].hi}: अभी कोई सर्ज नहीं। जल्दी बुक करें, यह बदल सकता है।`],
  },
  surgeStill: {
    en: (v) => ['Still busy', `${VEHICLE[v.vehicle].en} near ${v.place}: prices were still higher than normal after 30 minutes.`],
    hi: (v) => ['अभी भी भीड़ है', `${v.place} के पास ${VEHICLE[v.vehicle].hi}: 30 मिनट बाद भी किराया सामान्य से ज़्यादा था।`],
  },
  driverAssigned: {
    en: (v) => ['Driver assigned', `${v.driver} · ${v.vehicle}${v.eta != null ? ` · arriving in ~${v.eta} min` : ''}. ${v.passenger ? `${v.passenger} gives` : 'Share'} OTP ${v.otp} at pickup.`],
    hi: (v) => ['ड्राइवर मिल गया', `${v.driver} · ${v.vehicle}${v.eta != null ? ` · लगभग ${v.eta} मिनट में पहुँचेंगे` : ''}। पिकअप पर ${v.passenger ? `${v.passenger} OTP ${v.otp} बताएँगे` : `OTP ${v.otp} बताएँ`}।`],
  },
  driverArriving: {
    en: () => ['Your driver is arriving', 'Head to the pickup point - they are less than 300 m away.'],
    hi: () => ['आपका ड्राइवर पहुँच रहा है', 'पिकअप पॉइंट पर पहुँचें - ड्राइवर 300 मीटर से कम दूर हैं।'],
  },
  driverArrived: {
    en: (v) => ['Your driver has arrived', `${v.plate} is waiting at the pickup point.`],
    hi: (v) => ['आपका ड्राइवर आ गया है', `${v.plate} पिकअप पॉइंट पर इंतज़ार कर रही है।`],
  },
  rideStarted: {
    en: (v) =>
      v.kind === 'parcel'
        ? ['Parcel picked up', `Your parcel is on its way to ${v.receiver}.`]
        : ['Ride started', v.kind === 'rental' ? `Your ${v.rental} rental has started. Extra km and minutes are added at the end.` : `Heading to ${v.place}. Share your trip from the ride screen.`],
    hi: (v) =>
      v.kind === 'parcel'
        ? ['पार्सल उठा लिया गया', `आपका पार्सल ${v.receiver} के पास जा रहा है।`]
        : ['राइड शुरू हुई', v.kind === 'rental' ? `आपकी ${v.rental} रेंटल शुरू हो गई है। ज़्यादा किमी और मिनट का किराया आख़िर में जुड़ेगा।` : `${v.place} की ओर जा रहे हैं। राइड स्क्रीन से अपनी ट्रिप शेयर करें।`],
  },
  tripEnded: {
    en: (v) => [v.kind === 'parcel' ? 'Parcel delivered' : 'You have arrived', v.paid ? `${rs(v.fare)} paid from your wallet.${v.kind === 'parcel' ? '' : ' Rate your driver?'}` : `Fare ${rs(v.fare)}. Please complete payment.`],
    hi: (v) => [v.kind === 'parcel' ? 'पार्सल पहुँच गया' : 'आप पहुँच गए', v.paid ? `${rs(v.fare)} आपके वॉलेट से चुकाए गए।${v.kind === 'parcel' ? '' : ' अपने ड्राइवर को रेटिंग दें?'}` : `किराया ${rs(v.fare)}। कृपया भुगतान पूरा करें।`],
  },
  rideCancelled: {
    en: (v) => ['Ride cancelled', `${v.byRider ? 'The rider' : 'Your driver'} cancelled: ${v.reason}`],
    hi: (v) => ['राइड रद्द', `${v.byRider ? 'राइडर' : 'आपके ड्राइवर'} ने राइड रद्द की: ${v.reason}`],
  },
  cancelFee: {
    en: (v) => ['Cancellation fee', `A ${rs(v.fee)} fee applies because the driver was already on the way.`],
    hi: (v) => ['रद्द करने का शुल्क', `ड्राइवर पहले से रास्ते में थे, इसलिए ${rs(v.fee)} का शुल्क लगेगा।`],
  },
  lateCancelCredit: {
    en: (v) => [`${rs(v.amount)} credit for the late cancellation`, 'Your driver cancelled after the free period, so we added it to your Hopin wallet.'],
    hi: (v) => [`देर से रद्द करने पर ${rs(v.amount)} क्रेडिट`, 'आपके ड्राइवर ने मुफ़्त समय के बाद राइड रद्द की, इसलिए यह राशि आपके Hopin वॉलेट में जोड़ दी गई है।'],
  },
  lateCancelCharge: {
    en: (v) => [`${rs(v.amount)} late-cancellation charge`, 'You cancelled after the free period, so the rider was compensated from your wallet.'],
    hi: (v) => [`देर से रद्द करने का ${rs(v.amount)} शुल्क`, 'आपने मुफ़्त समय के बाद राइड रद्द की, इसलिए राइडर को आपके वॉलेट से भरपाई की गई।'],
  },
  newReview: {
    en: (v) => [`New ${v.stars}★ review`, v.comment ? `“${v.comment}”` : `${v.rider} rated your trip.`],
    hi: (v) => [`नई ${v.stars}★ रेटिंग`, v.comment ? `“${v.comment}”` : `${v.rider} ने आपकी ट्रिप को रेटिंग दी।`],
  },
  familyRideStarted: {
    en: (v) => [`${v.name}'s ride started`, `With ${v.driver} (${v.plate}). Open Family to follow it live.`],
    hi: (v) => [`${v.name} की राइड शुरू हुई`, `${v.driver} (${v.plate}) के साथ। लाइव देखने के लिए फ़ैमिली खोलें।`],
  },
  familyRideEnded: {
    en: (v) => [`${v.name}'s ride has ended`, v.rental ? 'Reached the end of their rental.' : `Reached ${v.place}.`],
    hi: (v) => [`${v.name} की राइड पूरी हुई`, v.rental ? 'उनकी रेंटल पूरी हो गई।' : `${v.place} पहुँच गए।`],
  },
  homeReached: {
    en: () => ["You're home", '"Heading home" is off. Go offline when you are done, or keep taking rides.'],
    hi: () => ['आप घर पहुँच गए', '"घर जा रहे हैं" बंद कर दिया गया। काम ख़त्म हो तो ऑफ़लाइन हो जाएँ, या राइड लेते रहें।'],
  },

  // --- safety ------------------------------------------------------------------------------
  offRoute: {
    en: (v) => ['Your driver has left the planned route', `They are about ${v.distance} away from it. If you feel unsafe, press SOS on the ride screen. Our safety team has been alerted.`],
    hi: (v) => ['आपके ड्राइवर तय रास्ते से हट गए हैं', `वे रास्ते से लगभग ${v.distance} दूर हैं। असुरक्षित लगे तो राइड स्क्रीन पर SOS दबाएँ। हमारी सेफ़्टी टीम को सूचना दे दी गई है।`],
  },
  longStop: {
    en: (v) => ['Your ride has stopped. Are you OK?', `The vehicle has not moved for ${v.minutes} minutes. Tap "I'm OK" on the ride screen, or press SOS if you need help. Our safety team has been alerted.`],
    hi: (v) => ['आपकी राइड रुकी हुई है। क्या आप ठीक हैं?', `गाड़ी ${v.minutes} मिनट से नहीं हिली है। राइड स्क्रीन पर "मैं ठीक हूँ" दबाएँ, या मदद चाहिए तो SOS दबाएँ। हमारी सेफ़्टी टीम को सूचना दे दी गई है।`],
  },
  backOnRoute: {
    en: () => ['Back on the planned route', 'Your driver has rejoined the planned route.'],
    hi: () => ['तय रास्ते पर वापस', 'आपके ड्राइवर फिर से तय रास्ते पर आ गए हैं।'],
  },
  reachedSafely: {
    en: (v) => ['Reached safely?', `Tap "I'm safe" within ${v.minutes} minutes. If we don't hear from you, we'll text your emergency contacts.`],
    hi: (v) => ['सुरक्षित पहुँच गए?', `${v.minutes} मिनट के अंदर "मैं सुरक्षित हूँ" दबाएँ। आपका जवाब नहीं आया तो हम आपके इमरजेंसी कॉन्टैक्ट्स को SMS भेजेंगे।`],
  },
  couldNotReach: {
    en: (v) => [
      'We could not reach you',
      v.texted
        ? `You didn't confirm reaching safely, so we texted ${v.texted} emergency contact${v.texted > 1 ? 's' : ''}. Tap "I'm safe" to let us know you're fine.`
        : `You didn't confirm reaching safely. Our safety team has been alerted${v.noContacts ? ' (you have no emergency contacts to text)' : ''}. Tap "I'm safe" to let us know you're fine.`,
    ],
    hi: (v) => [
      'हम आपसे संपर्क नहीं कर सके',
      v.texted
        ? `आपने सुरक्षित पहुँचने की पुष्टि नहीं की, इसलिए हमने ${v.texted} इमरजेंसी कॉन्टैक्ट को SMS भेजा। ठीक हैं तो "मैं सुरक्षित हूँ" दबाएँ।`
        : `आपने सुरक्षित पहुँचने की पुष्टि नहीं की। हमारी सेफ़्टी टीम को सूचना दे दी गई है${v.noContacts ? ' (SMS भेजने के लिए आपके कोई इमरजेंसी कॉन्टैक्ट नहीं हैं)' : ''}। ठीक हैं तो "मैं सुरक्षित हूँ" दबाएँ।`,
    ],
  },
  sosResolved: {
    en: () => ['SOS resolved', 'Our safety team has marked your alert as resolved. Reply in Help if you still need us.'],
    hi: () => ['SOS सुलझा दिया गया', 'हमारी सेफ़्टी टीम ने आपके अलर्ट को सुलझा हुआ मार्क किया है। अभी भी मदद चाहिए तो Help में जवाब दें।'],
  },

  // --- money -------------------------------------------------------------------------------
  tipReceived: {
    en: (v) => [`${rs(v.amount)} tip received`, 'A rider tipped you for a recent trip. It is in your Hopin wallet.'],
    hi: (v) => [`${rs(v.amount)} टिप मिली`, 'एक राइडर ने हाल की ट्रिप के लिए आपको टिप दी। यह आपके Hopin वॉलेट में है।'],
  },
  splitAsk: {
    en: (v) => ['Split a fare?', `${v.name} asked you to pay ${rs(v.amount)} of a ${rs(v.fare)} Hopin trip.`],
    hi: (v) => ['किराया बाँटें?', `${v.name} ने ${rs(v.fare)} की Hopin ट्रिप में से ${rs(v.amount)} चुकाने को कहा है।`],
  },
  splitPaid: {
    en: (v) => ['Fare share received', `${v.name} paid you ${rs(v.amount)}. It is in your Hopin wallet.`],
    hi: (v) => ['किराये का हिस्सा मिला', `${v.name} ने आपको ${rs(v.amount)} चुकाए। यह आपके Hopin वॉलेट में है।`],
  },
  splitDeclined: {
    en: (v) => ['Split declined', `${v.name} declined to pay ${rs(v.amount)}.`],
    hi: (v) => ['किराया बाँटना मना किया', `${v.name} ने ${rs(v.amount)} चुकाने से मना कर दिया।`],
  },
  detourReview: {
    en: (v) => ['We opened a detour review for you', `Your trip took ${v.extra} min longer than planned after leaving the route. Our team will check if a refund is due.`],
    hi: (v) => ['हमने आपके लिए रास्ता बदलने की जाँच शुरू की', `रास्ते से हटने के बाद आपकी ट्रिप तय समय से ${v.extra} मिनट ज़्यादा चली। हमारी टीम देखेगी कि रिफ़ंड बनता है या नहीं।`],
  },
  walletTopup: {
    en: (v) => ['Wallet topped up', `${rs(v.amount)} added to your Hopin wallet.`],
    hi: (v) => ['वॉलेट में पैसे जुड़े', `आपके Hopin वॉलेट में ${rs(v.amount)} जोड़े गए।`],
  },
  companyTopup: {
    en: (v) => ['Company wallet topped up', `${rs(v.amount)} added to your company's Hopin wallet.`],
    hi: (v) => ['कंपनी वॉलेट में पैसे जुड़े', `आपकी कंपनी के Hopin वॉलेट में ${rs(v.amount)} जोड़े गए।`],
  },
  paidTwice: {
    en: (v) => ['Payment received twice', `${paidTwice(v.kind, 'en')}, so your ${rs(v.amount)} payment has been flagged for a refund.`],
    hi: (v) => ['भुगतान दो बार मिला', `${paidTwice(v.kind, 'hi')}, इसलिए आपके ${rs(v.amount)} के भुगतान को रिफ़ंड के लिए चिह्नित किया गया है।`],
  },
  paymentReceived: {
    en: (v) => ['Payment received', `${rs(v.amount)} paid by ${v.method}. Your receipt is in Trips.`],
    hi: (v) => ['भुगतान मिल गया', `${v.method} से ${rs(v.amount)} चुकाए गए। आपकी रसीद Trips में है।`],
  },
  tripPaidDriver: {
    en: (v) => ['Trip paid', `${rs(v.amount)} added to your earnings.`],
    hi: (v) => ['ट्रिप का भुगतान हुआ', `आपकी कमाई में ${rs(v.amount)} जोड़े गए।`],
  },
  refundSent: {
    en: (v) => [`Refund of ${rs(v.amount)}`, `Sent to ${v.toWallet ? 'your Hopin wallet' : 'your original payment method (banks usually take a few working days)'}. Reason: ${v.reason}`],
    hi: (v) => [`${rs(v.amount)} का रिफ़ंड`, `${v.toWallet ? 'आपके Hopin वॉलेट' : 'आपके मूल भुगतान माध्यम (बैंक में आमतौर पर कुछ कामकाजी दिन लगते हैं)'} में भेजा गया। कारण: ${v.reason}`],
  },
  driverRefundTaken: {
    en: (v) => ['Trip refunded', `${rs(v.amount)} was taken back from your earnings for a refunded trip.`],
    hi: (v) => ['ट्रिप का रिफ़ंड हुआ', `रिफ़ंड हुई ट्रिप के लिए आपकी कमाई से ${rs(v.amount)} वापस लिए गए।`],
  },
  payoutSent: {
    en: (v) => [`${rs(v.amount)} sent to you`, `Paid to ${v.label}. Reference ${v.reference}. It can take a little while to show in your bank.`],
    hi: (v) => [`${rs(v.amount)} आपको भेजे गए`, `${v.label} पर भुगतान किया गया। रेफ़रेंस ${v.reference}। बैंक में दिखने में थोड़ा समय लग सकता है।`],
  },
  payoutRejected: {
    en: (v) => ['Withdrawal not paid', `${rs(v.amount)} is back in your Hopin wallet. ${v.reason}`],
    hi: (v) => ['निकासी का भुगतान नहीं हुआ', `${rs(v.amount)} वापस आपके Hopin वॉलेट में हैं। ${v.reason}`],
  },

  // --- growth --------------------------------------------------------------------------------
  referralRider: {
    en: (v) => [`${rs(v.amount)} referral credit`, 'Thanks for your first Hopin trip. The credit is in your wallet.'],
    hi: (v) => [`${rs(v.amount)} रेफ़रल क्रेडिट`, 'Hopin पर पहली ट्रिप के लिए धन्यवाद। क्रेडिट आपके वॉलेट में है।'],
  },
  referralReferrer: {
    en: (v) => [`${rs(v.amount)} for your referral`, 'Someone you referred finished their first paid trip.'],
    hi: (v) => [`आपके रेफ़रल के लिए ${rs(v.amount)}`, 'आपके रेफ़र किए व्यक्ति ने अपनी पहली पेड ट्रिप पूरी की।'],
  },
  driverReferral: {
    en: (v) => [`${rs(v.amount)} driver referral`, `A driver you referred completed ${v.trips} trips.`],
    hi: (v) => [`${rs(v.amount)} ड्राइवर रेफ़रल`, `आपके रेफ़र किए ड्राइवर ने ${v.trips} ट्रिप पूरी कीं।`],
  },
  companyAdmin: {
    en: (v) => [`You manage ${v.company} on Hopin`, 'Top up the company wallet and invite employees from the Company page.'],
    hi: (v) => [`आप Hopin पर ${v.company} को संभालते हैं`, 'कंपनी पेज से कंपनी वॉलेट में पैसे जोड़ें और कर्मचारियों को बुलाएँ।'],
  },
  companyInvite: {
    en: (v) => [`${v.company} invited you`, 'Accept to book business rides paid by your company. Open Profile → Business.'],
    hi: (v) => [`${v.company} ने आपको आमंत्रित किया`, 'कंपनी के ख़र्च पर बिज़नेस राइड बुक करने के लिए स्वीकार करें। Profile → Business खोलें।'],
  },
  familyInvite: {
    en: (v) => ['Family invite', `${v.name} wants to add you to their Hopin family. Nothing is shared until you choose to.`],
    hi: (v) => ['फ़ैमिली आमंत्रण', `${v.name} आपको अपनी Hopin फ़ैमिली में जोड़ना चाहते हैं। जब तक आप ख़ुद न चुनें, कुछ भी शेयर नहीं होगा।`],
  },
  familyAccepted: {
    en: (v) => ['Family invite accepted', `${v.name} joined your Hopin family.`],
    hi: (v) => ['फ़ैमिली आमंत्रण स्वीकार हुआ', `${v.name} आपकी Hopin फ़ैमिली में जुड़ गए।`],
  },

  // --- drivers' documents and support ------------------------------------------------------
  helmetRejected: {
    en: (v) => ['Helmet selfie rejected', `${v.reason}. Take a new helmet selfie to go online.`],
    hi: (v) => ['हेलमेट सेल्फ़ी अस्वीकार', `${v.reason}। ऑनलाइन होने के लिए नई हेलमेट सेल्फ़ी लें।`],
  },
  docRejected: {
    en: (v) => [`${docName(v.doc, 'en')} rejected`, v.reason],
    hi: (v) => [`${docName(v.doc, 'hi')} अस्वीकार`, v.reason],
  },
  docApproved: {
    en: (v) => [`${docName(v.doc, 'en')} approved`, 'Thanks — we are still checking your other documents.'],
    hi: (v) => [`${docName(v.doc, 'hi')} मंज़ूर`, 'धन्यवाद — हम आपके बाक़ी दस्तावेज़ अभी जाँच रहे हैं।'],
  },
  approvedToDrive: {
    en: () => ['You are approved to drive 🎉', 'All your documents are approved. You can go online now.'],
    hi: () => ['आप ड्राइव करने के लिए मंज़ूर हैं 🎉', 'आपके सभी दस्तावेज़ मंज़ूर हो गए। अब आप ऑनलाइन हो सकते हैं।'],
  },
  ticketResolved: {
    en: (v) => ['Ticket resolved', `Re: ${v.subject}`],
    hi: (v) => ['टिकट सुलझा दिया गया', `विषय: ${v.subject}`],
  },
  supportReplied: {
    en: (v) => ['Support replied', `Re: ${v.subject}`],
    hi: (v) => ['सपोर्ट ने जवाब दिया', `विषय: ${v.subject}`],
  },

  // --- texts to the other person (booked for someone else, parcel receiver) -----------------
  passengerTexted: {
    en: (v) => (v.failed ? ['Could not text your passenger', `We could not send ${v.name} an SMS. Share the driver details and the code ${v.otp} with them yourself.`] : ['Passenger texted', `${v.name} was sent the driver details and the code ${v.otp}.`]),
    hi: (v) => (v.failed ? ['यात्री को SMS नहीं भेज सके', `हम ${v.name} को SMS नहीं भेज सके। ड्राइवर की जानकारी और कोड ${v.otp} उन्हें ख़ुद बता दें।`] : ['यात्री को SMS भेजा गया', `${v.name} को ड्राइवर की जानकारी और कोड ${v.otp} भेज दिया गया।`]),
  },
  receiverTextFailed: {
    en: (v) => ['Could not text the receiver', `We could not send ${v.name} an SMS. Share the delivery code ${v.code} with them yourself.`],
    hi: (v) => ['पाने वाले को SMS नहीं भेज सके', `हम ${v.name} को SMS नहीं भेज सके। डिलीवरी कोड ${v.code} उन्हें ख़ुद बता दें।`],
  },
};

const SMS = {
  passenger: {
    en: (v) => `Hopin: ${v.rider} booked you a ride. Driver ${v.driver}, ${v.vehicle}. Your code to start the ride: ${v.otp}. Live: ${v.track}`,
    hi: (v) => `Hopin: ${v.rider} ने आपके लिए राइड बुक की है। ड्राइवर ${v.driver}, ${v.vehicle}। राइड शुरू करने का कोड: ${v.otp}। लाइव: ${v.track}`,
  },
  parcel: {
    en: (v) => `Hopin: ${v.rider} is sending you a parcel (${v.item}). Driver ${v.driver}, ${v.vehicle}. Give the driver code ${v.code} only when you have it. Live: ${v.track}`,
    hi: (v) => `Hopin: ${v.rider} आपको पार्सल (${v.item}) भेज रहे हैं। ड्राइवर ${v.driver}, ${v.vehicle}। पार्सल मिलने के बाद ही ड्राइवर को कोड ${v.code} बताएँ। लाइव: ${v.track}`,
  },
  sos: {
    en: (v) => `SOS from ${v.name} on a Hopin ride (${v.vehicle}). Live location: ${v.track}`,
    hi: (v) => `${v.name} ने Hopin राइड (${v.vehicle}) पर SOS दबाया है। लाइव लोकेशन: ${v.track}`,
  },
  nightCheck: {
    en: (v) => `Hopin safety check: ${v.name} finished a night ride at ${v.time} near ${v.place} (vehicle ${v.plate}) and has not confirmed reaching safely. Please check on them.`,
    hi: (v) => `Hopin सेफ़्टी चेक: ${v.name} की रात की राइड ${v.time} पर ${v.place} के पास ख़त्म हुई (गाड़ी ${v.plate}) और उन्होंने सुरक्षित पहुँचने की पुष्टि नहीं की है। कृपया उनका हाल पूछ लें।`,
  },
};

const pick = (table, key, lang) => {
  const entry = table[key];
  if (!entry) throw new Error(`Unknown message "${key}"`);
  return entry[LANGUAGES.includes(lang) ? lang : 'en'];
};

/** [title, body] of a notification in a language. */
export const message = (lang, key, vars = {}) => pick(M, key, lang)(vars);
/** The text of an SMS in a language. */
export const smsText = (lang, key, vars = {}) => pick(SMS, key, lang)(vars);

export async function languageOf(userId) {
  return (await one('SELECT language FROM users WHERE id = $1', [userId]).catch(() => null))?.language ?? 'en';
}

/** Notifies someone in their own language. `vars` may be a function of the language (for times). */
export async function notifyIn(userId, key, vars = {}, link = null) {
  const lang = await languageOf(userId);
  const [title, body] = message(lang, key, typeof vars === 'function' ? vars(lang) : vars);
  return notify(userId, title, body, link);
}

/** Every message key, for tests that check each has both languages. */
export const MESSAGE_KEYS = Object.keys(M);
export const SMS_KEYS = Object.keys(SMS);
