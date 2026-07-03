// GoSumo Realty — DPDPA compliance types (backend `compliance` module).
// Kept local so the web app builds independently (see apps/web/CLAUDE.md).

export type ConsentType = 'PROCESSING' | 'MARKETING' | 'EXCHANGE';

/** Raw consent-ledger row as the API returns it (Prisma snake_case, Dates → ISO). */
export interface ConsentLog {
  id: string;
  phone: string;
  consent_type: ConsentType;
  granted_at: string;
  revoked_at: string | null;
  channel: string;
  source: string | null;
  created_at: string;
}

/** GET /compliance/data-request/:phone — everything held for a buyer. */
export interface DataAccessResult {
  found: boolean;
  phone: string;
  lead: {
    id: string;
    name: string | null;
    email: string | null;
    whatsappPhone: string;
    stage: string;
    source: string;
    extractedFacts: unknown;
    objections: unknown;
    promises: unknown;
    optOut: boolean;
    createdAt: string;
  } | null;
  messages: Array<{
    id: string;
    direction: string;
    senderType: string;
    textContent: string | null;
    createdAt: string;
  }>;
  consents: ConsentLog[];
}

/** GET /compliance/consent/:phone */
export interface ConsentHistoryResponse {
  phone: string;
  consents: ConsentLog[];
}

/** POST /compliance/erasure */
export interface ErasureResult {
  erased: boolean;
  leadId: string | null;
  messagesAnonymized: number;
  consentsRevoked: number;
}

/** GET/PUT /compliance/settings */
export interface ComplianceSettings {
  retentionMonths: number;
  dataProcessorAgreement: boolean;
  dataProcessorAgreedAt: string | null;
  lastRetentionRunAt: string | null;
}

export interface CorrectionInput {
  phone: string;
  name?: string;
  email?: string;
  altPhone?: string;
}

/** POST /compliance/retention/run */
export interface RetentionRunResult {
  businessId: string;
  retentionMonths: number;
  cutoff: string;
  leadsAnonymized: number;
  messagesAnonymized: number;
}
