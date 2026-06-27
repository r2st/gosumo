import {
  BarChart3,
  CalendarClock,
  CreditCard,
  LayoutDashboard,
  MessagesSquare,
  Package,
  Settings,
  ShoppingCart,
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
  { label: 'Conversations', href: '/conversations', icon: MessagesSquare },
  { label: 'Clients', href: '/clients', icon: Users },
  { label: 'Catalog', href: '/catalog', icon: Package },
  { label: 'Orders', href: '/orders', icon: ShoppingCart },
  { label: 'Bookings', href: '/bookings', icon: CalendarClock },
  { label: 'Payments', href: '/payments', icon: CreditCard },
  { label: 'Analytics', href: '/analytics', icon: BarChart3 },
  { label: 'Settings', href: '/settings', icon: Settings },
];
