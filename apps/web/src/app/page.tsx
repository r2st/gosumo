import { redirect } from 'next/navigation';

// Render at request time instead of being statically prerendered. A static
// prerender of this redirect can be corrupted into a 307 with no Location
// header (a stale/poisoned .next cache produced exactly that and took the
// site down), leaving browsers with nowhere to navigate. Rendering per
// request always emits a correct redirect.
export const dynamic = 'force-dynamic';

export default function Home() {
  redirect('/dashboard');
}
