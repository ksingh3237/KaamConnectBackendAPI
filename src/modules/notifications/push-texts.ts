/**
 * The words of every push and inbox notification, in the three languages a person can choose in the app
 * (`users.language`). Each function returns the English text as `title` / `body` (what tests and logs read) plus the
 * Hindi and Punjabi versions; NotificationsService picks the one matching each recipient.
 *
 * Only our own words are translated. What people typed (a job title, a worker's name, a cancellation note) is shown
 * as written; a cancellation reason the app picked from the list is translated through REASON_LABELS.
 */
import type { Language } from '../../generated/prisma/enums.js';

export interface PushCopy {
  title: string;
  body: string;
}

export interface LocalizedCopy extends PushCopy {
  translations: Record<Exclude<Language, 'en'>, PushCopy>;
}

type Copies = Record<Language, PushCopy>;

const localized = (copies: Copies): LocalizedCopy => ({
  ...copies.en,
  translations: { hi: copies.hi, pa: copies.pa },
});

/** The cancellation reason labels of cancel-reasons.ts (and the no-show label), as the other person reads them. */
const REASON_LABELS: Record<string, { hi: string; pa: string }> = {
  'Vehicle problem': { hi: 'गाड़ी में खराबी', pa: 'ਗੱਡੀ ਵਿੱਚ ਖ਼ਰਾਬੀ' },
  'Personal emergency': { hi: 'निजी आपात स्थिति', pa: 'ਨਿੱਜੀ ਐਮਰਜੈਂਸੀ' },
  'Double-booked': { hi: 'एक ही समय पर दो काम', pa: 'ਇੱਕੋ ਸਮੇਂ ਦੋ ਕੰਮ' },
  'Too far to reach in time': {
    hi: 'समय पर पहुँचने के लिए बहुत दूर',
    pa: 'ਸਮੇਂ ਸਿਰ ਪਹੁੰਚਣ ਲਈ ਬਹੁਤ ਦੂਰ',
  },
  'Cannot do this work': {
    hi: 'यह काम नहीं कर सकते',
    pa: 'ਇਹ ਕੰਮ ਨਹੀਂ ਕਰ ਸਕਦੇ',
  },
  'Customer is not answering': {
    hi: 'ग्राहक जवाब नहीं दे रहे',
    pa: 'ਗਾਹਕ ਜਵਾਬ ਨਹੀਂ ਦੇ ਰਹੇ',
  },
  'Address is wrong or cannot be found': {
    hi: 'पता गलत है या नहीं मिला',
    pa: 'ਪਤਾ ਗ਼ਲਤ ਹੈ ਜਾਂ ਨਹੀਂ ਮਿਲਿਆ',
  },
  'Customer asked me to cancel': {
    hi: 'ग्राहक ने रद्द करने को कहा',
    pa: 'ਗਾਹਕ ਨੇ ਰੱਦ ਕਰਨ ਲਈ ਕਿਹਾ',
  },
  'Could not agree on the price': {
    hi: 'कीमत पर सहमति नहीं बनी',
    pa: 'ਕੀਮਤ ’ਤੇ ਸਹਿਮਤੀ ਨਹੀਂ ਬਣੀ',
  },
  'The location felt unsafe': {
    hi: 'जगह असुरक्षित लगी',
    pa: 'ਥਾਂ ਅਸੁਰੱਖਿਅਤ ਲੱਗੀ',
  },
  'Other reason': { hi: 'अन्य कारण', pa: 'ਹੋਰ ਕਾਰਨ' },
  'Changed my mind': { hi: 'मन बदल गया', pa: 'ਮਨ ਬਦਲ ਗਿਆ' },
  'Found another worker': {
    hi: 'दूसरा कारीगर मिल गया',
    pa: 'ਹੋਰ ਕਾਰੀਗਰ ਮਿਲ ਗਿਆ',
  },
  'The worker is taking too long': {
    hi: 'कारीगर बहुत देर कर रहा है',
    pa: 'ਕਾਰੀਗਰ ਬਹੁਤ ਦੇਰ ਕਰ ਰਿਹਾ ਹੈ',
  },
  'Cannot reach the worker': {
    hi: 'कारीगर से संपर्क नहीं हो रहा',
    pa: 'ਕਾਰੀਗਰ ਨਾਲ ਸੰਪਰਕ ਨਹੀਂ ਹੋ ਰਿਹਾ',
  },
  'Posted by mistake': { hi: 'गलती से पोस्ट हुआ', pa: 'ਗ਼ਲਤੀ ਨਾਲ ਪੋਸਟ ਹੋਇਆ' },
  'The price is too high': {
    hi: 'कीमत बहुत ज़्यादा है',
    pa: 'ਕੀਮਤ ਬਹੁਤ ਜ਼ਿਆਦਾ ਹੈ',
  },
  'The worker did not arrive in time': {
    hi: 'कारीगर समय पर नहीं पहुँचा',
    pa: 'ਕਾਰੀਗਰ ਸਮੇਂ ਸਿਰ ਨਹੀਂ ਪਹੁੰਚਿਆ',
  },
};

/** A reason in the reader's language: a listed label is translated, typed words stay as written. */
function reasonIn(lang: Language, text: string | null): string | null {
  // An old app that sent no reason stores this marker; it is not words to show anyone.
  if (!text || text === 'BACKED_OUT') return null;
  if (lang === 'en') return text;
  return REASON_LABELS[text]?.[lang] ?? text;
}

export const PushTexts = {
  workerEnRoute: (): LocalizedCopy =>
    localized({
      en: {
        title: 'Your worker is on the way',
        body: 'Track them live and keep your arrival code ready.',
      },
      hi: {
        title: 'आपका कारीगर रास्ते में है',
        body: 'उन्हें लाइव देखें और अपना आगमन कोड तैयार रखें।',
      },
      pa: {
        title: 'ਤੁਹਾਡਾ ਕਾਰੀਗਰ ਰਸਤੇ ਵਿੱਚ ਹੈ',
        body: 'ਉਹਨਾਂ ਨੂੰ ਲਾਈਵ ਵੇਖੋ ਅਤੇ ਆਪਣਾ ਆਗਮਨ ਕੋਡ ਤਿਆਰ ਰੱਖੋ।',
      },
    }),

  workerArrived: (): LocalizedCopy =>
    localized({
      en: {
        title: 'Your worker has arrived',
        body: 'They will share the bill for your approval before starting.',
      },
      hi: {
        title: 'आपका कारीगर पहुँच गया है',
        body: 'काम शुरू करने से पहले वे बिल आपकी मंज़ूरी के लिए भेजेंगे।',
      },
      pa: {
        title: 'ਤੁਹਾਡਾ ਕਾਰੀਗਰ ਪਹੁੰਚ ਗਿਆ ਹੈ',
        body: 'ਕੰਮ ਸ਼ੁਰੂ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ ਉਹ ਬਿੱਲ ਤੁਹਾਡੀ ਮਨਜ਼ੂਰੀ ਲਈ ਭੇਜਣਗੇ।',
      },
    }),

  workCompleted: (): LocalizedCopy =>
    localized({
      en: {
        title: 'Work completed',
        body: 'Please review the bill and pay your worker directly.',
      },
      hi: {
        title: 'काम पूरा हो गया',
        body: 'कृपया बिल देखें और कारीगर को सीधे भुगतान करें।',
      },
      pa: {
        title: 'ਕੰਮ ਪੂਰਾ ਹੋ ਗਿਆ',
        body: 'ਕਿਰਪਾ ਕਰਕੇ ਬਿੱਲ ਵੇਖੋ ਅਤੇ ਕਾਰੀਗਰ ਨੂੰ ਸਿੱਧਾ ਭੁਗਤਾਨ ਕਰੋ।',
      },
    }),

  newLead: (jobTitle: string): LocalizedCopy =>
    localized({
      en: { title: 'New job near you', body: jobTitle },
      hi: { title: 'आपके पास नया काम', body: jobTitle },
      pa: { title: 'ਤੁਹਾਡੇ ਨੇੜੇ ਨਵਾਂ ਕੰਮ', body: jobTitle },
    }),

  directRequest: (jobTitle: string): LocalizedCopy =>
    localized({
      en: { title: 'A customer asked for you', body: jobTitle },
      hi: { title: 'एक ग्राहक ने आपको बुलाया है', body: jobTitle },
      pa: { title: 'ਇੱਕ ਗਾਹਕ ਨੇ ਤੁਹਾਨੂੰ ਬੁਲਾਇਆ ਹੈ', body: jobTitle },
    }),

  directDeclined: (jobTitle: string): LocalizedCopy =>
    localized({
      en: {
        title: 'The worker cannot take your request',
        body: `${jobTitle}: please choose another worker.`,
      },
      hi: {
        title: 'कारीगर आपका काम नहीं ले सकता',
        body: `${jobTitle}: कृपया दूसरा कारीगर चुनें।`,
      },
      pa: {
        title: 'ਕਾਰੀਗਰ ਤੁਹਾਡਾ ਕੰਮ ਨਹੀਂ ਲੈ ਸਕਦਾ',
        body: `${jobTitle}: ਕਿਰਪਾ ਕਰਕੇ ਹੋਰ ਕਾਰੀਗਰ ਚੁਣੋ।`,
      },
    }),

  directExpired: (jobTitle: string): LocalizedCopy =>
    localized({
      en: {
        title: 'The worker did not answer',
        body: `${jobTitle}: please choose another worker.`,
      },
      hi: {
        title: 'कारीगर ने जवाब नहीं दिया',
        body: `${jobTitle}: कृपया दूसरा कारीगर चुनें।`,
      },
      pa: {
        title: 'ਕਾਰੀਗਰ ਨੇ ਜਵਾਬ ਨਹੀਂ ਦਿੱਤਾ',
        body: `${jobTitle}: ਕਿਰਪਾ ਕਰਕੇ ਹੋਰ ਕਾਰੀਗਰ ਚੁਣੋ।`,
      },
    }),

  bookingConfirmed: (): LocalizedCopy =>
    localized({
      en: {
        title: 'Booking confirmed',
        body: 'A customer chose you. Open the job to head over.',
      },
      hi: {
        title: 'बुकिंग पक्की हो गई',
        body: 'एक ग्राहक ने आपको चुना है। काम खोलें और रवाना हों।',
      },
      pa: {
        title: 'ਬੁਕਿੰਗ ਪੱਕੀ ਹੋ ਗਈ',
        body: 'ਇੱਕ ਗਾਹਕ ਨੇ ਤੁਹਾਨੂੰ ਚੁਣਿਆ ਹੈ। ਕੰਮ ਖੋਲ੍ਹੋ ਅਤੇ ਰਵਾਨਾ ਹੋਵੋ।',
      },
    }),

  billReady: (total: number): LocalizedCopy =>
    localized({
      en: {
        title: 'Your bill is ready',
        body: `Total ₹${total}. Review it and approve to start the work.`,
      },
      hi: {
        title: 'आपका बिल तैयार है',
        body: `कुल ₹${total}। इसे देखें और काम शुरू करने के लिए मंज़ूरी दें।`,
      },
      pa: {
        title: 'ਤੁਹਾਡਾ ਬਿੱਲ ਤਿਆਰ ਹੈ',
        body: `ਕੁੱਲ ₹${total}। ਇਸਨੂੰ ਵੇਖੋ ਅਤੇ ਕੰਮ ਸ਼ੁਰੂ ਕਰਨ ਲਈ ਮਨਜ਼ੂਰੀ ਦਿਓ।`,
      },
    }),

  newQuote: (
    workerName: string,
    visitFee: number,
    etaMinutes: number,
  ): LocalizedCopy =>
    localized({
      en: {
        title: 'New quote received',
        body: `${workerName} quoted ₹${visitFee}, arriving in ${etaMinutes} min.`,
      },
      hi: {
        title: 'नया कोटेशन आया',
        body: `${workerName} ने ₹${visitFee} बताया, ${etaMinutes} मिनट में पहुँचेंगे।`,
      },
      pa: {
        title: 'ਨਵਾਂ ਕੋਟੇਸ਼ਨ ਆਇਆ',
        body: `${workerName} ਨੇ ₹${visitFee} ਦੱਸਿਆ, ${etaMinutes} ਮਿੰਟ ਵਿੱਚ ਪਹੁੰਚਣਗੇ।`,
      },
    }),

  cancelledByCustomer: (
    jobTitle: string,
    reason: string | null,
    visitFeeDue: number | null,
  ): LocalizedCopy => {
    const fee = visitFeeDue !== null && visitFeeDue > 0 ? visitFeeDue : null;
    const why = (lang: Language) => {
      const r = reasonIn(lang, reason);
      return r ? `: ${r}` : '';
    };
    return localized({
      en: {
        title: 'The customer cancelled the job',
        body: `${jobTitle}${why('en')}.${fee ? ` The visit fee of ₹${fee} is payable to you directly.` : ''}`,
      },
      hi: {
        title: 'ग्राहक ने काम रद्द कर दिया',
        body: `${jobTitle}${why('hi')}।${fee ? ` ₹${fee} की विज़िट फ़ीस आपको सीधे दी जाएगी।` : ''}`,
      },
      pa: {
        title: 'ਗਾਹਕ ਨੇ ਕੰਮ ਰੱਦ ਕਰ ਦਿੱਤਾ',
        body: `${jobTitle}${why('pa')}।${fee ? ` ₹${fee} ਦੀ ਵਿਜ਼ਿਟ ਫ਼ੀਸ ਤੁਹਾਨੂੰ ਸਿੱਧੀ ਦਿੱਤੀ ਜਾਵੇਗੀ।` : ''}`,
      },
    });
  },

  cancelledByWorker: (
    jobTitle: string,
    reason: string | null,
    reopened: boolean,
    visitFeeDue: number | null,
  ): LocalizedCopy => {
    const fee = visitFeeDue !== null && visitFeeDue > 0 ? visitFeeDue : null;
    const r = (lang: Language) => reasonIn(lang, reason);
    const en = r('en');
    const hi = r('hi');
    const pa = r('pa');
    return localized({
      en: {
        title: reopened
          ? 'Your worker cannot make it'
          : 'Your worker cancelled the job',
        body: reopened
          ? `${jobTitle}: your request is open again, so you can choose another quote.${en ? ` Reason: ${en}.` : ''}`
          : `${jobTitle}.${en ? ` Reason: ${en}.` : ''}${fee ? ` The visit fee of ₹${fee} is payable to the worker directly.` : ''}`,
      },
      hi: {
        title: reopened
          ? 'आपका कारीगर नहीं आ पाएगा'
          : 'आपके कारीगर ने काम रद्द कर दिया',
        body: reopened
          ? `${jobTitle}: आपका अनुरोध फिर से खुला है, आप दूसरा कोटेशन चुन सकते हैं।${hi ? ` कारण: ${hi}।` : ''}`
          : `${jobTitle}।${hi ? ` कारण: ${hi}।` : ''}${fee ? ` ₹${fee} की विज़िट फ़ीस कारीगर को सीधे देनी है।` : ''}`,
      },
      pa: {
        title: reopened
          ? 'ਤੁਹਾਡਾ ਕਾਰੀਗਰ ਨਹੀਂ ਆ ਸਕੇਗਾ'
          : 'ਤੁਹਾਡੇ ਕਾਰੀਗਰ ਨੇ ਕੰਮ ਰੱਦ ਕਰ ਦਿੱਤਾ',
        body: reopened
          ? `${jobTitle}: ਤੁਹਾਡੀ ਬੇਨਤੀ ਫਿਰ ਖੁੱਲ੍ਹੀ ਹੈ, ਤੁਸੀਂ ਹੋਰ ਕੋਟੇਸ਼ਨ ਚੁਣ ਸਕਦੇ ਹੋ।${pa ? ` ਕਾਰਨ: ${pa}।` : ''}`
          : `${jobTitle}।${pa ? ` ਕਾਰਨ: ${pa}।` : ''}${fee ? ` ₹${fee} ਦੀ ਵਿਜ਼ਿਟ ਫ਼ੀਸ ਕਾਰੀਗਰ ਨੂੰ ਸਿੱਧੀ ਦੇਣੀ ਹੈ।` : ''}`,
      },
    });
  },

  workerLate: (jobTitle: string, at: string): LocalizedCopy =>
    localized({
      en: {
        title: 'Your worker is running late',
        body: `${jobTitle}: they have not arrived yet. You can keep waiting or cancel. If they have not arrived by ${at}, the request is released automatically.`,
      },
      hi: {
        title: 'आपका कारीगर देर से आ रहा है',
        body: `${jobTitle}: वे अभी तक नहीं पहुँचे। आप इंतज़ार कर सकते हैं या रद्द कर सकते हैं। अगर ${at} तक नहीं पहुँचे, तो अनुरोध अपने आप छोड़ दिया जाएगा।`,
      },
      pa: {
        title: 'ਤੁਹਾਡਾ ਕਾਰੀਗਰ ਦੇਰ ਨਾਲ ਆ ਰਿਹਾ ਹੈ',
        body: `${jobTitle}: ਉਹ ਅਜੇ ਨਹੀਂ ਪਹੁੰਚੇ। ਤੁਸੀਂ ਉਡੀਕ ਕਰ ਸਕਦੇ ਹੋ ਜਾਂ ਰੱਦ ਕਰ ਸਕਦੇ ਹੋ। ਜੇ ${at} ਤੱਕ ਨਹੀਂ ਪਹੁੰਚੇ, ਤਾਂ ਬੇਨਤੀ ਆਪਣੇ ਆਪ ਛੱਡ ਦਿੱਤੀ ਜਾਵੇਗੀ।`,
      },
    }),

  youAreLate: (jobTitle: string, at: string): LocalizedCopy =>
    localized({
      en: {
        title: 'You are late for a job',
        body: `${jobTitle}: the customer is waiting. If you have not arrived by ${at} the job is released, and that counts as a cancellation.`,
      },
      hi: {
        title: 'आप एक काम के लिए देर से हैं',
        body: `${jobTitle}: ग्राहक इंतज़ार कर रहे हैं। अगर आप ${at} तक नहीं पहुँचे तो काम छोड़ दिया जाएगा, और इसे रद्दीकरण गिना जाएगा।`,
      },
      pa: {
        title: 'ਤੁਸੀਂ ਇੱਕ ਕੰਮ ਲਈ ਲੇਟ ਹੋ',
        body: `${jobTitle}: ਗਾਹਕ ਉਡੀਕ ਕਰ ਰਹੇ ਹਨ। ਜੇ ਤੁਸੀਂ ${at} ਤੱਕ ਨਹੀਂ ਪਹੁੰਚੇ ਤਾਂ ਕੰਮ ਛੱਡ ਦਿੱਤਾ ਜਾਵੇਗਾ, ਅਤੇ ਇਸਨੂੰ ਰੱਦ ਕਰਨਾ ਗਿਣਿਆ ਜਾਵੇਗਾ।`,
      },
    }),

  noShowCustomer: (jobTitle: string, reopened: boolean): LocalizedCopy =>
    localized({
      en: {
        title: 'Your worker did not arrive',
        body: reopened
          ? `${jobTitle}: your request is open again, so you can choose another quote.`
          : `${jobTitle}: this request was closed. You can post it again.`,
      },
      hi: {
        title: 'आपका कारीगर नहीं पहुँचा',
        body: reopened
          ? `${jobTitle}: आपका अनुरोध फिर से खुला है, आप दूसरा कोटेशन चुन सकते हैं।`
          : `${jobTitle}: यह अनुरोध बंद हो गया। आप इसे फिर से पोस्ट कर सकते हैं।`,
      },
      pa: {
        title: 'ਤੁਹਾਡਾ ਕਾਰੀਗਰ ਨਹੀਂ ਪਹੁੰਚਿਆ',
        body: reopened
          ? `${jobTitle}: ਤੁਹਾਡੀ ਬੇਨਤੀ ਫਿਰ ਖੁੱਲ੍ਹੀ ਹੈ, ਤੁਸੀਂ ਹੋਰ ਕੋਟੇਸ਼ਨ ਚੁਣ ਸਕਦੇ ਹੋ।`
          : `${jobTitle}: ਇਹ ਬੇਨਤੀ ਬੰਦ ਹੋ ਗਈ। ਤੁਸੀਂ ਇਸਨੂੰ ਫਿਰ ਪੋਸਟ ਕਰ ਸਕਦੇ ਹੋ।`,
      },
    }),

  noShowWorker: (jobTitle: string): LocalizedCopy =>
    localized({
      en: {
        title: 'The job was released',
        body: `${jobTitle}: you did not arrive in time, so it went back to the customer. This counts as a cancellation on your record.`,
      },
      hi: {
        title: 'काम छोड़ दिया गया',
        body: `${jobTitle}: आप समय पर नहीं पहुँचे, इसलिए यह ग्राहक के पास वापस चला गया। इसे आपके रिकॉर्ड में रद्दीकरण गिना जाएगा।`,
      },
      pa: {
        title: 'ਕੰਮ ਛੱਡ ਦਿੱਤਾ ਗਿਆ',
        body: `${jobTitle}: ਤੁਸੀਂ ਸਮੇਂ ਸਿਰ ਨਹੀਂ ਪਹੁੰਚੇ, ਇਸ ਲਈ ਇਹ ਗਾਹਕ ਕੋਲ ਵਾਪਸ ਚਲਾ ਗਿਆ। ਇਸਨੂੰ ਤੁਹਾਡੇ ਰਿਕਾਰਡ ਵਿੱਚ ਰੱਦ ਕਰਨਾ ਗਿਣਿਆ ਜਾਵੇਗਾ।`,
      },
    }),
};
