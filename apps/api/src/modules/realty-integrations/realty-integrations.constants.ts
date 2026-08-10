import { RealtyIntegrationProvider } from '@prisma/client';

/**
 * BullMQ queue that drives the nightly Google Sheets export sweep across all
 * businesses with a connected sheet. Redis is configured globally in app.module.ts.
 */
export const REALTY_INTEGRATIONS_QUEUE = 'realty-integrations';

export const REALTY_INTEGRATIONS_JOBS = {
  /** Nightly export of every connected business's leads + inventory to Sheets. */
  NIGHTLY_SHEETS_EXPORT: 'nightly-sheets-export',
} as const;

/** Stable repeatable-job id so re-registration on boot never duplicates the schedule. */
export const NIGHTLY_SHEETS_EXPORT_JOB_ID = 'realty-integrations:sheets:nightly';

/** Nightly at 01:30 IST-friendly server time — a quiet window before the workday. */
export const NIGHTLY_SHEETS_EXPORT_CRON = '30 1 * * *';

/** The CRM providers that receive lead pushes (Google Sheets is export-only). */
export const CRM_PROVIDERS: RealtyIntegrationProvider[] = [
  RealtyIntegrationProvider.SELLDO,
  RealtyIntegrationProvider.LEADSQUARED,
  RealtyIntegrationProvider.PRIVYR,
];

/** Worksheet (tab) names used in the exported Google Sheet. */
export const SHEET_TABS = {
  LEADS: 'Leads',
  INVENTORY: 'Inventory',
} as const;

/**
 * Column headers for the Leads worksheet — every BLTC field plus stage,
 * temperature, source, and assigned agent (business plan §5 export contract).
 */
export const LEADS_SHEET_HEADERS = [
  'Lead ID',
  'Name',
  'WhatsApp (व्हाट्सएप)',
  'Alt Phone',
  'Email',
  'Source (स्रोत)',
  'Sub Source',
  'Listing Ref',
  'Budget Min (₹)',
  'Budget Max (₹)',
  'Localities (इलाका)',
  'Timeline (महीने)',
  'Config',
  'Purpose',
  'Financing',
  'Qual Score',
  'Temperature',
  'Stage (चरण)',
  'Assigned Agent',
  'Opt Out',
  'Next Follow-up',
  'Last Activity',
  'Created At',
] as const;

/**
 * Column headers for the Inventory worksheet — project details, unit
 * availability, and pricing.
 */
export const INVENTORY_SHEET_HEADERS = [
  'Unit ID',
  'Project (परियोजना)',
  'Developer',
  'Locality (इलाका)',
  'RERA No.',
  'Config',
  'Carpet (sqft)',
  'Floor',
  'Facing',
  'Base Price (₹)',
  'All-in Price (₹)',
  'Availability (उपलब्धता)',
  'Fresh (24h)',
  'Possession',
  'Project Status',
] as const;
