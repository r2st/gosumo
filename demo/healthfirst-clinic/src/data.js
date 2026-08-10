export const services = [
  {
    title: 'General Medicine',
    desc: 'Comprehensive primary care for fever, infections, lifestyle disorders and everyday health concerns.',
    icon: 'stethoscope',
  },
  {
    title: 'Cardiology',
    desc: 'Heart health check-ups, ECG, 2D echo and expert management of blood pressure and cardiac conditions.',
    icon: 'heart',
  },
  {
    title: 'Pediatrics',
    desc: 'Gentle, child-friendly care including vaccinations, growth monitoring and newborn wellness.',
    icon: 'baby',
  },
  {
    title: 'Orthopedics',
    desc: 'Bone, joint and spine care, sports injuries, fracture management and physiotherapy.',
    icon: 'bone',
  },
  {
    title: 'Gynecology',
    desc: 'Women’s health, prenatal care, fertility guidance and routine screenings in a safe space.',
    icon: 'female',
  },
  {
    title: 'Diagnostics & Lab',
    desc: 'NABL-accredited pathology, digital X-ray and ultrasound with same-day reports.',
    icon: 'flask',
  },
]

export const doctors = [
  {
    name: 'Dr. Ananya Sharma',
    specialty: 'Cardiologist',
    qualifications: 'MBBS, MD, DM (Cardiology)',
    experience: '15+ years',
    initials: 'AS',
    color: 'from-sky-500 to-sky-700',
  },
  {
    name: 'Dr. Rajesh Iyer',
    specialty: 'General Physician',
    qualifications: 'MBBS, MD (Internal Medicine)',
    experience: '18+ years',
    initials: 'RI',
    color: 'from-brand-500 to-brand-700',
  },
  {
    name: 'Dr. Priya Menon',
    specialty: 'Pediatrician',
    qualifications: 'MBBS, DCH, MD (Pediatrics)',
    experience: '12+ years',
    initials: 'PM',
    color: 'from-sky-500 to-brand-600',
  },
  {
    name: 'Dr. Vikram Reddy',
    specialty: 'Orthopedic Surgeon',
    qualifications: 'MBBS, MS (Ortho)',
    experience: '20+ years',
    initials: 'VR',
    color: 'from-brand-600 to-sky-700',
  },
]

export const packages = [
  {
    name: 'Basic Health Check',
    price: 1499,
    cadence: 'one-time',
    highlight: false,
    tests: '32 tests',
    features: [
      'Complete Blood Count (CBC)',
      'Blood Sugar (Fasting)',
      'Lipid Profile',
      'Urine Routine',
      'Doctor Consultation',
    ],
  },
  {
    name: 'Comprehensive Care',
    price: 3999,
    cadence: 'one-time',
    highlight: true,
    tests: '68 tests',
    features: [
      'Everything in Basic, plus:',
      'Liver & Kidney Function Tests',
      'Thyroid Profile (T3, T4, TSH)',
      'Vitamin D & B12',
      'ECG + Chest X-ray',
      'Free Follow-up Consultation',
    ],
  },
  {
    name: 'Senior Citizen Plus',
    price: 5999,
    cadence: 'annual',
    highlight: false,
    tests: '90 tests',
    features: [
      'Everything in Comprehensive, plus:',
      '2D Echo & Cardiac Screening',
      'Bone Density (DEXA) Scan',
      'Diabetic Retinopathy Check',
      'Quarterly Health Reviews',
    ],
  },
]

export const testimonials = [
  {
    name: 'Meera Krishnan',
    location: 'Bengaluru',
    text: 'Booking an appointment was effortless and the doctors genuinely listened. The AI chat even reminded me about my follow-up — felt truly cared for.',
    rating: 5,
    initials: 'MK',
  },
  {
    name: 'Arjun Nair',
    location: 'Kochi',
    text: 'Got my entire family’s health check-up done in one visit. Reports came the same day on WhatsApp. Highly professional and clean facility.',
    rating: 5,
    initials: 'AN',
  },
  {
    name: 'Sunita Deshpande',
    location: 'Pune',
    text: 'The senior citizen package is excellent value. The staff treated my parents with so much patience and warmth. Strongly recommended.',
    rating: 5,
    initials: 'SD',
  },
]

export const stats = [
  { value: '50,000+', label: 'Patients Treated' },
  { value: '40+', label: 'Specialist Doctors' },
  { value: '15+', label: 'Years of Trust' },
  { value: '4.9★', label: 'Patient Rating' },
]

export const departments = [
  'General Medicine',
  'Cardiology',
  'Pediatrics',
  'Orthopedics',
  'Gynecology',
  'Dermatology',
  'ENT',
  'Diagnostics & Lab',
]
