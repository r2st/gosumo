// DoAide Desk — dashboard UI internationalization (English + Hindi).
//
// The dashboard is built for Indian real-estate brokers, so every shared UI label
// ships with a Hindi (Devanagari) translation alongside English. Page-specific copy
// on the fully-bilingual surfaces (Intelligence, Privacy) also lives here so the two
// languages stay side-by-side and never drift.
//
// Hindi glyphs render via Noto Sans Devanagari (configured in the root layout); the
// font stack falls through to it automatically for any Devanagari codepoints.

export type UiLang = 'en' | 'hi';

export const UI_LANGUAGES: UiLang[] = ['en', 'hi'];

/** Native language names for the switcher (each shown in its own script). */
export const UI_LANGUAGE_LABELS: Record<UiLang, string> = {
  en: 'English',
  hi: 'हिंदी',
};

/** localStorage key + cookie name the UI-language preference is persisted under. */
export const LANG_STORAGE_KEY = 'desk-lang';
const LEGACY_LANG_KEY = 'gosumo-lang';

function migrateLangKey(): void {
  if (typeof window === 'undefined') return;
  const old = window.localStorage.getItem(LEGACY_LANG_KEY);
  if (old && !window.localStorage.getItem(LANG_STORAGE_KEY)) {
    window.localStorage.setItem(LANG_STORAGE_KEY, old);
    window.localStorage.removeItem(LEGACY_LANG_KEY);
  }
}
migrateLangKey();

/**
 * Flat, dot-namespaced translation table. English is the source of truth and the
 * fallback; a missing Hindi entry falls back to English, and a missing key falls
 * back to the key itself (so a typo is visible, never a blank).
 */
type Dict = Record<string, string>;

const en: Dict = {
  // ── Navigation ──────────────────────────────────────────────────────────────
  'nav.dashboard': 'Dashboard',
  'nav.leads': 'Leads',
  'nav.inventory': 'Inventory',
  'nav.sitevisits': 'Site Visits',
  'nav.cadences': 'Cadences',
  'nav.broker': 'Broker Console',
  'nav.exchange': 'Exchange',
  'nav.approvals': 'Approvals',
  'nav.import': 'Import',
  'nav.intelligence': 'Intelligence',
  'nav.catalog': 'Catalog',
  'nav.orders': 'Orders',
  'nav.payments': 'Payments',
  'nav.conversations': 'Conversations',
  'nav.clients': 'Clients',
  'nav.bookings': 'Bookings',
  'nav.analytics': 'Analytics',
  'nav.settings': 'Settings',

  // ── Nav section headers ─────────────────────────────────────────────────────
  'section.Realty': 'Realty',
  'section.Commerce': 'Commerce',
  'section.Engagement': 'Engagement',
  'section.Insights': 'Insights',

  // ── Common buttons / states ─────────────────────────────────────────────────
  'common.save': 'Save',
  'common.saveChanges': 'Save changes',
  'common.cancel': 'Cancel',
  'common.submit': 'Submit',
  'common.saved': 'Saved',
  'common.retry': 'Try again',
  'common.loading': 'Loading…',
  'common.search': 'Search',
  'common.all': 'All',
  'common.export': 'Export',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.optIn': 'Opt in',
  'common.optOut': 'Opt out',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.language': 'Language',

  // ── Lead stages ─────────────────────────────────────────────────────────────
  'stage.NEW': 'New',
  'stage.CONTACTED': 'Contacted',
  'stage.QUALIFIED': 'Qualified',
  'stage.VISIT_BOOKED': 'Visit Booked',
  'stage.VISITED': 'Visited',
  'stage.NEGOTIATING': 'Negotiating',
  'stage.CLOSED_WON': 'Closed Won',
  'stage.CLOSED_LOST': 'Closed Lost',
  'stage.DORMANT': 'Dormant',

  // ── Lead temperatures ───────────────────────────────────────────────────────
  'temp.HOT': 'Hot',
  'temp.WARM': 'Warm',
  'temp.COLD': 'Cold',
  'temp.JUNK': 'Junk',

  // ── Settings labels ─────────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.business': 'Business',
  'settings.setup': 'Setup Wizard',
  'settings.team': 'Team',
  'settings.channels': 'Channels',
  'settings.ai': 'AI',
  'settings.notifications': 'Notifications',
  'settings.billing': 'Billing',
  'settings.apiKeys': 'API Keys',
  'settings.integrations': 'Integrations',
  'settings.privacy': 'Privacy & DPDPA',

  // ── Intelligence (micro-market) page ────────────────────────────────────────
  'intel.title': 'Micro-Market Intelligence',
  'intel.subtitle': 'Corridor demand, price bands and objection trends across your localities.',
  'intel.corridor': 'Corridor',
  'intel.microMarket': 'Micro-market',
  'intel.selectCorridor': 'Select a corridor',
  'intel.allCorridors': 'All corridors',
  'intel.demandTrend': 'Demand trend',
  'intel.priceBand': 'Price band',
  'intel.recommendedBand': 'Recommended anchor band',
  'intel.popularConfigs': 'Popular configurations',
  'intel.supplyDemandGap': 'Supply–demand gap',
  'intel.topObjections': 'Common objections',
  'intel.sourceQuality': 'Lead source quality',
  'intel.conversionRate': 'Site-visit conversion',
  'intel.medianDays': 'Median days to visit',
  'intel.sampleSize': 'Sample size',
  'intel.buyers': 'buyers',
  'intel.leads': 'leads',
  'intel.qualifiedRate': 'Qualified rate',
  'intel.visitRate': 'Visit rate',
  'intel.avgScore': 'Avg. score',
  'intel.optInTitle': 'Contribute to the network',
  'intel.optInDesc':
    'Share anonymized, aggregated corridor patterns so every broker’s AI gets smarter. Never shares individual leads — only statistics above the privacy threshold.',
  'intel.optedIn': 'Contributing anonymized patterns',
  'intel.optedOut': 'Not contributing',
  'intel.noData': 'No corridor intelligence yet',
  'intel.noDataDesc':
    'Aggregates build nightly from your leads once a corridor has enough activity. Check back after more leads flow in.',
  'intel.narrative': 'What this means',
  'intel.month': 'Month',
  'intel.leadsInflow': 'Lead inflow',
  'intel.conversions': 'Conversions',
  'intel.share': 'share',

  // ── Privacy / DPDPA page ────────────────────────────────────────────────────
  'privacy.title': 'Privacy & DPDPA',
  'privacy.subtitle': 'Data-principal rights, consent and retention under India’s DPDP Act, 2023.',
  'privacy.noticeTitle': 'DPDPA compliance notice',
  'privacy.noticeBody':
    'Under the Digital Personal Data Protection Act, 2023, your buyers are data principals with the right to access, correct and erase their personal data. Your brokerage is the data fiduciary; DoAide Desk is the data processor.',
  'privacy.rightsTitle': 'Data-principal rights',
  'privacy.rightsDesc': 'Look up, correct or erase all personal data held for a buyer by phone number.',
  'privacy.buyerPhone': 'Buyer phone number',
  'privacy.lookup': 'Look up data',
  'privacy.access': 'Right of access',
  'privacy.correction': 'Right to correction',
  'privacy.erasure': 'Right to erasure',
  'privacy.consent': 'Consent history',
  'privacy.noDataForPhone': 'No data held for this phone number.',
  'privacy.collectedData': 'Collected data',
  'privacy.messages': 'Messages',
  'privacy.requestCorrection': 'Request correction',
  'privacy.requestErasure': 'Request erasure',
  'privacy.erasureConfirm':
    'This anonymizes all personal data held for this buyer and cannot be undone. Continue?',
  'privacy.erased': 'Personal data erased.',
  'privacy.corrected': 'Buyer data corrected.',
  'privacy.retentionTitle': 'Retention policy',
  'privacy.retentionDesc': 'Inactive buyer data is automatically erased after the retention window.',
  'privacy.retentionMonths': 'Retention window (months)',
  'privacy.processorAgreement': 'Data-processor agreement accepted',
  'privacy.processorAgreementDesc': 'Confirms your brokerage has accepted DoAide Desk as its data processor.',
  'privacy.lastRun': 'Last retention sweep',
  'privacy.runRetention': 'Run retention sweep now',
  'privacy.consentTitle': 'Network intelligence consent',
  'privacy.consentDesc':
    'Consent to contribute anonymized corridor statistics to the network. You can revoke this at any time.',
  'privacy.granted': 'Granted',
  'privacy.revoked': 'Revoked',
  'privacy.name': 'Name',
  'privacy.email': 'Email',
  'privacy.altPhone': 'Alternate phone',
  'privacy.stage': 'Stage',
  'privacy.source': 'Source',
  'privacy.never': 'Never',
};

const hi: Dict = {
  // ── Navigation ──────────────────────────────────────────────────────────────
  'nav.dashboard': 'डैशबोर्ड',
  'nav.leads': 'लीड्स',
  'nav.inventory': 'इन्वेंटरी',
  'nav.sitevisits': 'साइट विज़िट',
  'nav.cadences': 'फ़ॉलो-अप',
  'nav.broker': 'ब्रोकर कंसोल',
  'nav.exchange': 'को-ब्रोकिंग',
  'nav.approvals': 'स्वीकृतियाँ',
  'nav.import': 'इम्पोर्ट',
  'nav.intelligence': 'इंटेलिजेंस',
  'nav.catalog': 'कैटलॉग',
  'nav.orders': 'ऑर्डर',
  'nav.payments': 'भुगतान',
  'nav.conversations': 'बातचीत',
  'nav.clients': 'ग्राहक',
  'nav.bookings': 'बुकिंग',
  'nav.analytics': 'एनालिटिक्स',
  'nav.settings': 'सेटिंग्स',

  // ── Nav section headers ─────────────────────────────────────────────────────
  'section.Realty': 'रियल्टी',
  'section.Commerce': 'कॉमर्स',
  'section.Engagement': 'एंगेजमेंट',
  'section.Insights': 'इनसाइट्स',

  // ── Common buttons / states ─────────────────────────────────────────────────
  'common.save': 'सेव करें',
  'common.saveChanges': 'बदलाव सेव करें',
  'common.cancel': 'रद्द करें',
  'common.submit': 'सबमिट करें',
  'common.saved': 'सेव हो गया',
  'common.retry': 'फिर से कोशिश करें',
  'common.loading': 'लोड हो रहा है…',
  'common.search': 'खोजें',
  'common.all': 'सभी',
  'common.export': 'एक्सपोर्ट',
  'common.close': 'बंद करें',
  'common.confirm': 'पुष्टि करें',
  'common.optIn': 'शामिल हों',
  'common.optOut': 'बाहर हों',
  'common.enabled': 'सक्षम',
  'common.disabled': 'अक्षम',
  'common.language': 'भाषा',

  // ── Lead stages ─────────────────────────────────────────────────────────────
  'stage.NEW': 'नया',
  'stage.CONTACTED': 'संपर्क किया',
  'stage.QUALIFIED': 'योग्य',
  'stage.VISIT_BOOKED': 'विज़िट बुक',
  'stage.VISITED': 'विज़िट हुई',
  'stage.NEGOTIATING': 'बातचीत जारी',
  'stage.CLOSED_WON': 'डील पक्की',
  'stage.CLOSED_LOST': 'डील खोई',
  'stage.DORMANT': 'निष्क्रिय',

  // ── Lead temperatures ───────────────────────────────────────────────────────
  'temp.HOT': 'गर्म',
  'temp.WARM': 'सामान्य',
  'temp.COLD': 'ठंडा',
  'temp.JUNK': 'बेकार',

  // ── Settings labels ─────────────────────────────────────────────────────────
  'settings.title': 'सेटिंग्स',
  'settings.business': 'व्यवसाय',
  'settings.setup': 'सेटअप विज़ार्ड',
  'settings.team': 'टीम',
  'settings.channels': 'चैनल',
  'settings.ai': 'एआई',
  'settings.notifications': 'सूचनाएँ',
  'settings.billing': 'बिलिंग',
  'settings.apiKeys': 'एपीआई की',
  'settings.integrations': 'इंटीग्रेशन',
  'settings.privacy': 'गोपनीयता व DPDPA',

  // ── Intelligence (micro-market) page ────────────────────────────────────────
  'intel.title': 'माइक्रो-मार्केट इंटेलिजेंस',
  'intel.subtitle': 'आपकी लोकैलिटीज़ में कॉरिडोर मांग, मूल्य बैंड और आपत्ति रुझान।',
  'intel.corridor': 'कॉरिडोर',
  'intel.microMarket': 'माइक्रो-मार्केट',
  'intel.selectCorridor': 'कॉरिडोर चुनें',
  'intel.allCorridors': 'सभी कॉरिडोर',
  'intel.demandTrend': 'मांग रुझान',
  'intel.priceBand': 'मूल्य बैंड',
  'intel.recommendedBand': 'सुझाया गया मूल्य बैंड',
  'intel.popularConfigs': 'लोकप्रिय कॉन्फ़िगरेशन',
  'intel.supplyDemandGap': 'आपूर्ति–मांग अंतर',
  'intel.topObjections': 'आम आपत्तियाँ',
  'intel.sourceQuality': 'लीड स्रोत गुणवत्ता',
  'intel.conversionRate': 'साइट-विज़िट कन्वर्ज़न',
  'intel.medianDays': 'विज़िट तक औसत दिन',
  'intel.sampleSize': 'सैंपल आकार',
  'intel.buyers': 'खरीदार',
  'intel.leads': 'लीड्स',
  'intel.qualifiedRate': 'योग्यता दर',
  'intel.visitRate': 'विज़िट दर',
  'intel.avgScore': 'औसत स्कोर',
  'intel.optInTitle': 'नेटवर्क में योगदान दें',
  'intel.optInDesc':
    'गुमनाम, समेकित कॉरिडोर पैटर्न साझा करें ताकि हर ब्रोकर का एआई बेहतर बने। कभी भी अलग-अलग लीड साझा नहीं होते — केवल गोपनीयता सीमा से ऊपर के आँकड़े।',
  'intel.optedIn': 'गुमनाम पैटर्न में योगदान जारी',
  'intel.optedOut': 'योगदान नहीं दे रहे',
  'intel.noData': 'अभी कोई कॉरिडोर इंटेलिजेंस नहीं',
  'intel.noDataDesc':
    'किसी कॉरिडोर में पर्याप्त गतिविधि होने पर आँकड़े हर रात आपकी लीड्स से बनते हैं। अधिक लीड आने के बाद फिर देखें।',
  'intel.narrative': 'इसका मतलब',
  'intel.month': 'महीना',
  'intel.leadsInflow': 'लीड आवक',
  'intel.conversions': 'कन्वर्ज़न',
  'intel.share': 'हिस्सा',

  // ── Privacy / DPDPA page ────────────────────────────────────────────────────
  'privacy.title': 'गोपनीयता व DPDPA',
  'privacy.subtitle': 'भारत के DPDP अधिनियम, 2023 के तहत डेटा-प्रिंसिपल अधिकार, सहमति व प्रतिधारण।',
  'privacy.noticeTitle': 'DPDPA अनुपालन सूचना',
  'privacy.noticeBody':
    'डिजिटल पर्सनल डेटा प्रोटेक्शन एक्ट, 2023 के तहत आपके खरीदार डेटा-प्रिंसिपल हैं, जिन्हें अपने व्यक्तिगत डेटा तक पहुँच, सुधार व मिटाने का अधिकार है। आपकी ब्रोकरेज डेटा-फ़िड्यूशियरी है; DoAide Desk डेटा-प्रोसेसर है।',
  'privacy.rightsTitle': 'डेटा-प्रिंसिपल अधिकार',
  'privacy.rightsDesc': 'फ़ोन नंबर से किसी खरीदार का सारा व्यक्तिगत डेटा देखें, सुधारें या मिटाएँ।',
  'privacy.buyerPhone': 'खरीदार का फ़ोन नंबर',
  'privacy.lookup': 'डेटा खोजें',
  'privacy.access': 'पहुँच का अधिकार',
  'privacy.correction': 'सुधार का अधिकार',
  'privacy.erasure': 'मिटाने का अधिकार',
  'privacy.consent': 'सहमति इतिहास',
  'privacy.noDataForPhone': 'इस फ़ोन नंबर के लिए कोई डेटा नहीं है।',
  'privacy.collectedData': 'एकत्रित डेटा',
  'privacy.messages': 'संदेश',
  'privacy.requestCorrection': 'सुधार का अनुरोध',
  'privacy.requestErasure': 'मिटाने का अनुरोध',
  'privacy.erasureConfirm':
    'यह इस खरीदार का सारा व्यक्तिगत डेटा गुमनाम कर देगा और इसे पूर्ववत नहीं किया जा सकता। जारी रखें?',
  'privacy.erased': 'व्यक्तिगत डेटा मिटा दिया गया।',
  'privacy.corrected': 'खरीदार डेटा सुधारा गया।',
  'privacy.retentionTitle': 'प्रतिधारण नीति',
  'privacy.retentionDesc': 'निष्क्रिय खरीदार डेटा प्रतिधारण अवधि के बाद स्वतः मिटा दिया जाता है।',
  'privacy.retentionMonths': 'प्रतिधारण अवधि (महीने)',
  'privacy.processorAgreement': 'डेटा-प्रोसेसर समझौता स्वीकृत',
  'privacy.processorAgreementDesc': 'पुष्टि करता है कि आपकी ब्रोकरेज ने DoAide Desk को डेटा-प्रोसेसर स्वीकार किया है।',
  'privacy.lastRun': 'अंतिम प्रतिधारण सफ़ाई',
  'privacy.runRetention': 'अभी प्रतिधारण सफ़ाई चलाएँ',
  'privacy.consentTitle': 'नेटवर्क इंटेलिजेंस सहमति',
  'privacy.consentDesc':
    'नेटवर्क में गुमनाम कॉरिडोर आँकड़ों का योगदान देने की सहमति। आप इसे कभी भी वापस ले सकते हैं।',
  'privacy.granted': 'दी गई',
  'privacy.revoked': 'वापस ली गई',
  'privacy.name': 'नाम',
  'privacy.email': 'ईमेल',
  'privacy.altPhone': 'वैकल्पिक फ़ोन',
  'privacy.stage': 'चरण',
  'privacy.source': 'स्रोत',
  'privacy.never': 'कभी नहीं',
};

export const TRANSLATIONS: Record<UiLang, Dict> = { en, hi };

/** Look up a key for a language, falling back en → key. */
export function translate(lang: UiLang, key: string): string {
  return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}
