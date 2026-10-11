// Source: KaamConnect/constants/mockData.ts (SERVICE_CATEGORIES). Ids are the app's stable keys
// and must never be renamed. `baseVisitFee` is the app's "₹200 visit" string as whole INR.
export interface ServiceCategorySeed {
  id: string;
  titleEn: string;
  titleHi: string;
  titlePa: string;
  iconKey: string;
  color: string;
  bgColor: string;
  baseVisitFee: number;
  /** Typical visit length in minutes (15-480). Leave out to use BOOKING_DEFAULT_DURATION_MIN (90). */
  defaultDurationMin?: number;
  examples: string;
}

// Array order is the display order (sortOrder = index).
export const SERVICE_CATEGORIES: ServiceCategorySeed[] = [
  {
    id: 'electrician',
    titleEn: 'Electrician',
    titleHi: 'विद्युत कारीगर',
    titlePa: 'ਬਿਜਲੀ ਮਿਸਤਰੀ',
    iconKey: 'Zap',
    color: '#F59E0B',
    bgColor: '#FEF3C7',
    baseVisitFee: 200,
    examples: 'Short Circuit, Fan, MCB Trip, Switchboards',
  },
  {
    id: 'plumber',
    titleEn: 'Plumber',
    titleHi: 'प्लंबर / नलसाज',
    titlePa: 'ਪਲੰਬਰ',
    iconKey: 'Droplet',
    color: '#0284C7',
    bgColor: '#E0F2FE',
    baseVisitFee: 200,
    examples: 'Pipe Leakage, Tap, Geyser, Motor, Tank',
  },
  {
    id: 'ac_repair',
    titleEn: 'AC & Cooling',
    titleHi: 'एसी रिपेयर',
    titlePa: 'ਏਸੀ ਰਿਪੇਅਰ',
    iconKey: 'Wind',
    color: '#00B074',
    bgColor: '#D1FAE5',
    baseVisitFee: 299,
    examples: 'Gas Refill, Service, PCB, Installation',
  },
  {
    id: 'carpenter',
    titleEn: 'Carpenter',
    titleHi: 'बढ़ई / लकड़ी काम',
    titlePa: 'ਤਰਖਾਣ',
    iconKey: 'Hammer',
    color: '#B45309',
    bgColor: '#FDE68A',
    baseVisitFee: 250,
    examples: 'Door locks, Hinges, Modular kitchen, Furniture',
  },
  {
    id: 'painter',
    titleEn: 'Painter & Polish',
    titleHi: 'पेंटर व पुट्टी',
    titlePa: 'ਪੇਂਟਰ',
    iconKey: 'Paintbrush',
    color: '#8B5CF6',
    bgColor: '#EDE9FE',
    baseVisitFee: 300,
    examples: 'Touchup, Waterproofing, Wall texture',
  },
  {
    id: 'cleaner',
    titleEn: 'Deep Cleaning',
    titleHi: 'सफाई सेवा',
    titlePa: 'ਸਫ਼ਾਈ ਸੇਵਾ',
    iconKey: 'Sparkles',
    color: '#EC4899',
    bgColor: '#FCE7F3',
    baseVisitFee: 350,
    examples: 'Kitchen, Bathroom, Sofa, Water tank',
  },
  {
    id: 'appliance',
    titleEn: 'Appliances',
    titleHi: 'उपकरण रिपेयर',
    titlePa: 'ਘਰੇਲੂ ਉਪਕਰਣ',
    iconKey: 'Tv',
    color: '#6366F1',
    bgColor: '#EEF2FF',
    baseVisitFee: 250,
    examples: 'Washing Machine, RO Water, Microwave, Fridge',
  },
  {
    id: 'car_wash',
    titleEn: 'Car & Bike Wash',
    titleHi: 'वाहन धुलाई',
    titlePa: 'ਵਾਹਨ ਸਫ਼ਾਈ',
    iconKey: 'Truck',
    color: '#0D9488',
    bgColor: '#CCFBF1',
    baseVisitFee: 199,
    examples: 'Doorstep Foam Wash, Interior Detailing',
  },
];
