import { LEADS_SHEET_HEADERS, INVENTORY_SHEET_HEADERS } from '../realty-integrations.constants';
import type { LeadResponseDto } from '../../realty-leads/realty-leads.service';
import type {
  ProjectResponseDto,
  UnitResponseDto,
} from '../../realty-inventory/realty-inventory.service';

/** A single cell value written to a Google Sheet. */
export type SheetCell = string | number;
export type SheetRow = SheetCell[];

/** Convert integer paise to a plain rupee string (2 dp). Empty for null. */
export function paiseToRupeeCell(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  return (paise / 100).toFixed(2);
}

function isoDateCell(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/**
 * Map one lead to a Leads-worksheet row. Column order MUST match
 * {@link LEADS_SHEET_HEADERS}. Pure — no I/O, fully unit-tested.
 */
export function leadToRow(lead: LeadResponseDto): SheetRow {
  return [
    lead.id,
    lead.name ?? '',
    lead.whatsappPhone,
    lead.altPhone ?? '',
    lead.email ?? '',
    lead.source,
    lead.subSource ?? '',
    lead.listingRef ?? '',
    paiseToRupeeCell(lead.bltc.budgetMinPaise),
    paiseToRupeeCell(lead.bltc.budgetMaxPaise),
    (lead.bltc.localities ?? []).join(', '),
    lead.bltc.timelineMonths ?? '',
    lead.bltc.config ?? '',
    lead.bltc.purpose ?? '',
    lead.bltc.financing ?? '',
    lead.qualScore,
    lead.temperature,
    lead.stage,
    lead.assignedAgentId ?? '',
    lead.optOut ? 'YES' : 'NO',
    isoDateCell(lead.nextFollowupAt),
    isoDateCell(lead.lastActivityAt),
    isoDateCell(lead.createdAt),
  ];
}

/** Build the full Leads worksheet (header + one row per lead). */
export function buildLeadsSheet(leads: LeadResponseDto[]): SheetRow[] {
  return [[...LEADS_SHEET_HEADERS], ...leads.map(leadToRow)];
}

/**
 * Map one unit (joined to its project) to an Inventory-worksheet row. Column
 * order MUST match {@link INVENTORY_SHEET_HEADERS}. Pure — no I/O.
 */
export function unitToRow(unit: UnitResponseDto, project: ProjectResponseDto): SheetRow {
  return [
    unit.id,
    project.name,
    project.developer ?? '',
    project.locality,
    project.reraNumber ?? '',
    unit.config,
    unit.carpetSqft ?? '',
    unit.floor ?? '',
    unit.facing ?? '',
    paiseToRupeeCell(unit.basePricePaise),
    paiseToRupeeCell(unit.allInPricePaise),
    unit.availability,
    unit.isFresh ? 'YES' : 'NO',
    isoDateCell(project.possessionDate),
    project.status,
  ];
}

/** Build the full Inventory worksheet from project→units pairs. */
export function buildInventorySheet(
  entries: Array<{ project: ProjectResponseDto; units: UnitResponseDto[] }>,
): SheetRow[] {
  const rows: SheetRow[] = [[...INVENTORY_SHEET_HEADERS]];
  for (const { project, units } of entries) {
    for (const unit of units) {
      rows.push(unitToRow(unit, project));
    }
  }
  return rows;
}
