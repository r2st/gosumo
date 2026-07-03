// GoSumo Realty — frontend types mirroring the API DTOs (apps/api realty modules).

export type LeadStage =
  | 'NEW'
  | 'CONTACTED'
  | 'QUALIFIED'
  | 'VISIT_BOOKED'
  | 'VISITED'
  | 'NEGOTIATING'
  | 'CLOSED_WON'
  | 'CLOSED_LOST'
  | 'DORMANT';

export type LeadTemperature = 'HOT' | 'WARM' | 'COLD' | 'JUNK';

export type LeadSource =
  | 'PORTAL'
  | 'META_LEAD_AD'
  | 'CTWA'
  | 'IVR'
  | 'REFERRAL'
  | 'CSV'
  | 'WALK_IN'
  | 'EXCHANGE_INBOUND'
  | 'MANUAL';

export type LeadPurpose = 'END_USE' | 'INVEST';
export type FinancingStatus = 'CASH' | 'PREAPPROVED' | 'NEEDS_LOAN';

export interface BltcProfile {
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  localities: string[];
  timelineMonths: number | null;
  config: string | null;
  purpose: LeadPurpose | null;
  financing: FinancingStatus | null;
}

export interface LeadMemoryEntry {
  text: string;
  at: string;
  messageId?: string;
}

export interface Lead {
  id: string;
  businessId: string;
  assignedAgentId: string | null;
  conversationId: string | null;
  clientId: string | null;
  whatsappPhone: string;
  altPhone: string | null;
  email: string | null;
  name: string | null;
  languagePref: string;
  source: LeadSource;
  subSource: string | null;
  listingRef: string | null;
  firstTouchAt: string;
  bltc: BltcProfile;
  qualScore: number;
  temperature: LeadTemperature;
  stage: LeadStage;
  matchedUnitIds: string[];
  extractedFacts: LeadMemoryEntry[];
  objections: LeadMemoryEntry[];
  promises: LeadMemoryEntry[];
  optOut: boolean;
  shareConsent: boolean;
  exchangeStatus: string;
  nextFollowupAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadBoardColumn {
  stage: LeadStage;
  count: number;
}

export type ProjectStatus = 'PRELAUNCH' | 'UC' | 'RTM';
export type NetworkVisibility = 'PRIVATE' | 'EXCHANGE';

export interface RealtyProject {
  id: string;
  businessId: string;
  name: string;
  developer: string | null;
  locality: string;
  reraNumber: string | null;
  possessionDate: string | null;
  status: ProjectStatus;
  amenities: string[];
  priceBandMinPaise: number | null;
  priceBandMaxPaise: number | null;
  factSheetDocId: string | null;
  networkVisibility: NetworkVisibility;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UnitMatch {
  unitId: string;
  projectId: string;
  projectName: string;
  config: string;
  allInPricePaise: number;
  locality: string;
  fitScore: number;
  reasons: string[];
}

export const LEAD_STAGES: LeadStage[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'VISIT_BOOKED',
  'VISITED',
  'NEGOTIATING',
  'CLOSED_WON',
  'CLOSED_LOST',
  'DORMANT',
];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  VISIT_BOOKED: 'Visit Booked',
  VISITED: 'Visited',
  NEGOTIATING: 'Negotiating',
  CLOSED_WON: 'Closed Won',
  CLOSED_LOST: 'Closed Lost',
  DORMANT: 'Dormant',
};
