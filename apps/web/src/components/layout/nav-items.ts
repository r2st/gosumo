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

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Leads', href: '/leads', icon: Target },
  { label: 'Inventory', href: '/inventory', icon: Building2 },
  { label: 'Site Visits', href: '/sitevisits', icon: CalendarCheck },
  { label: 'Import', href: '/import', icon: Upload },
  { label: 'Broker Console', href: '/broker', icon: SlidersHorizontal },
  { label: 'Approvals', href: '/approvals', icon: CheckSquare },
  { label: 'Cadences', href: '/cadences', icon: Repeat },
  { label: 'Conversations', href: '/conversations', icon: MessagesSquare },
  { label: 'Clients', href: '/clients', icon: Users },
  { label: 'Catalog', href: '/catalog', icon: Package },
  { label: 'Orders', href: '/orders', icon: ShoppingCart },
  { label: 'Bookings', href: '/bookings', icon: CalendarClock },
  { label: 'Payments', href: '/payments', icon: CreditCard },
  { label: 'Analytics', href: '/analytics', icon: BarChart3 },
  { label: 'Settings', href: '/settings', icon: Settings },
];
