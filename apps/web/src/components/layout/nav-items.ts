import {
  BarChart3,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckSquare,
  CreditCard,
  Handshake,
  LayoutDashboard,
  LineChart,
  MessagesSquare,
  Package,
  Repeat,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Target,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** i18n key (see src/lib/i18n.ts); the sidebar renders t(labelKey) with `label` as fallback. */
  labelKey: string;
}

export interface NavSection {
  label: string;
  /** i18n key for the section header. */
  labelKey: string;
  items: NavItem[];
}

/** Standalone entry rendered above the grouped sections (no section header). */
export const NAV_TOP: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Realty',
    labelKey: 'section.Realty',
    items: [
      { label: 'Leads', href: '/leads', icon: Target, labelKey: 'nav.leads' },
      { label: 'Inventory', href: '/inventory', icon: Building2, labelKey: 'nav.inventory' },
      { label: 'Site Visits', href: '/sitevisits', icon: CalendarCheck, labelKey: 'nav.sitevisits' },
      { label: 'Cadences', href: '/cadences', icon: Repeat, labelKey: 'nav.cadences' },
      { label: 'Broker Console', href: '/broker', icon: SlidersHorizontal, labelKey: 'nav.broker' },
      { label: 'Exchange', href: '/exchange', icon: Handshake, labelKey: 'nav.exchange' },
      { label: 'Intelligence', href: '/intelligence', icon: LineChart, labelKey: 'nav.intelligence' },
      { label: 'Approvals', href: '/approvals', icon: CheckSquare, labelKey: 'nav.approvals' },
      { label: 'Import', href: '/import', icon: Upload, labelKey: 'nav.import' },
    ],
  },
  {
    label: 'Commerce',
    labelKey: 'section.Commerce',
    items: [
      { label: 'Catalog', href: '/catalog', icon: Package, labelKey: 'nav.catalog' },
      { label: 'Orders', href: '/orders', icon: ShoppingCart, labelKey: 'nav.orders' },
      { label: 'Payments', href: '/payments', icon: CreditCard, labelKey: 'nav.payments' },
    ],
  },
  {
    label: 'Engagement',
    labelKey: 'section.Engagement',
    items: [
      { label: 'Conversations', href: '/conversations', icon: MessagesSquare, labelKey: 'nav.conversations' },
      { label: 'Clients', href: '/clients', icon: Users, labelKey: 'nav.clients' },
      { label: 'Bookings', href: '/bookings', icon: CalendarClock, labelKey: 'nav.bookings' },
    ],
  },
  {
    label: 'Insights',
    labelKey: 'section.Insights',
    items: [
      { label: 'Analytics', href: '/analytics', icon: BarChart3, labelKey: 'nav.analytics' },
      { label: 'Settings', href: '/settings', icon: Settings, labelKey: 'nav.settings' },
    ],
  },
];

/** Flat list of every nav entry, in render order. */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_TOP,
  ...NAV_SECTIONS.flatMap((section) => section.items),
];
