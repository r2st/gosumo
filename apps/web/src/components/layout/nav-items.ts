import {
  BarChart3,
  Building2,
  CalendarCheck,
  CalendarClock,
  CheckSquare,
  CreditCard,
  LayoutDashboard,
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
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/** Standalone entry rendered above the grouped sections (no section header). */
export const NAV_TOP: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Realty',
    items: [
      { label: 'Leads', href: '/leads', icon: Target },
      { label: 'Inventory', href: '/inventory', icon: Building2 },
      { label: 'Site Visits', href: '/sitevisits', icon: CalendarCheck },
      { label: 'Cadences', href: '/cadences', icon: Repeat },
      { label: 'Broker Console', href: '/broker', icon: SlidersHorizontal },
      { label: 'Approvals', href: '/approvals', icon: CheckSquare },
      { label: 'Import', href: '/import', icon: Upload },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { label: 'Catalog', href: '/catalog', icon: Package },
      { label: 'Orders', href: '/orders', icon: ShoppingCart },
      { label: 'Payments', href: '/payments', icon: CreditCard },
    ],
  },
  {
    label: 'Engagement',
    items: [
      { label: 'Conversations', href: '/conversations', icon: MessagesSquare },
      { label: 'Clients', href: '/clients', icon: Users },
      { label: 'Bookings', href: '/bookings', icon: CalendarClock },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Analytics', href: '/analytics', icon: BarChart3 },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

/** Flat list of every nav entry, in render order. */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_TOP,
  ...NAV_SECTIONS.flatMap((section) => section.items),
];
