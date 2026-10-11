# Feature Doc: DoAide Desk Landing Page Redesign

**Product:** DoAide Desk (desk.doaide.com)
**Author:** Claude Opus 4.6
**Date:** 2026-10-01
**Status:** Draft — awaiting approval

---

## Problem

The current landing page is text-heavy with no way to sign up or log in without navigating to a separate page. This adds friction for new users and slows onboarding.

## Proposal

Redesign the landing page with an embedded signup/login form for immediate onboarding, animated product showcase, and mobile-first responsive layout.

## Design

### Desktop Layout (≥768px)
- **Left side (55%):** Animated product showcase
  - DoAide robot logo with floating animation
  - "DoAide Desk" title with amber accent
  - Tagline: "AI lead manager for real estate"
  - 3-4 animated feature highlights (icons with subtle entrance animations)
  - Particle background with floating orbs (consistent with doaide.com branding)

- **Right side (45%):** Auth form card
  - Toggle between Sign Up / Log In tabs
  - Sign Up: Name, Email, Password, "Create Account" button
  - Log In: Email, Password, "Sign In" button
  - "Forgot password?" link
  - Dark card with subtle border glow

### Mobile Layout (<768px)
- **Stacked vertically, form first:**
  1. Compact logo + title header
  2. Auth form (signup by default) — user sees this immediately without scrolling
  3. Feature highlights below the fold (scrollable)

### Visual Style
- Dark theme: #0A0A0B background, #F0B429 amber accents (matches doaide.com)
- Fonts: Instrument Serif (headings), Schibsted Grotesk (body), IBM Plex Mono (mono)
- Animations: floating robot, particle background, card shine on hover, staggered feature entrance
- No text walls — features shown as icon + short label pairs

### Animations
- Robot logo: gentle float (translateY) + glow pulse
- Feature icons: staggered fade-in from left on scroll
- Auth card: subtle border glow pulse
- Background: floating amber particles
- Form transitions: smooth tab switch between signup/login

## Technical Approach

This is a Next.js page change in `apps/web/app/page.tsx` (or equivalent landing route). The auth form will call the existing API endpoints:
- POST `/api/auth/register` for signup
- POST `/api/auth/login` for login

No new backend work needed — just a frontend page redesign.

## Out of Scope
- OAuth/social login (can be added later)
- Email verification flow changes
- Backend API changes

## Success Metrics
- Reduced clicks to first signup (from 2+ to 0)
- Mobile-friendly (passes Lighthouse mobile audit)
