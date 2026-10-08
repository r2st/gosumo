'use client';

import { useMemo, useRef, useState } from 'react';
import { Upload, Download, FileUp } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/states';
import { useImportCsv } from '@/hooks/use-realty';
import type { CsvImportRow } from '@/lib/realty-types';

const SAMPLE_CSV = `phone,name,email,source,subSource,listingRef
+919876543210,Priya Sharma,priya@example.com,PORTAL,99acres,Prestige Lakeside 3BHK
9811122233,Amit Verma,,CSV,walk-in,Green Acres 2BHK
`;

const HEADER_ALIASES: Record<string, keyof CsvImportRow> = {
  phone: 'phone',
  mobile: 'phone',
  phonenumber: 'phone',
  contact: 'phone',
  whatsapp: 'phone',
  name: 'name',
  fullname: 'name',
  email: 'email',
  emailid: 'email',
  source: 'source',
  subsource: 'subSource',
  campaign: 'subSource',
  listing: 'listingRef',
  listingref: 'listingRef',
  property: 'listingRef',
  project: 'listingRef',
};

/**
 * Largest file this page will read into the tab.
 *
 * `file.text()` buffers the whole thing, `parseCsv` builds a row object per
 * line, and React then renders a preview — three copies of whatever was picked,
 * in the operator's browser. The `accept` attribute on the input is a filter in
 * the file dialog and nothing more: it is trivially bypassed by switching the
 * dialog to "All files" or by dropping a file, so a mis-picked video became a
 * frozen or killed tab with no explanation. 5 MB is roughly ten times the
 * largest import the API will accept.
 */
export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Rows the API accepts in one import (`CsvImportDto`'s `@ArrayMaxSize`).
 *
 * Enforced here as well so an over-long file is reported as "too many rows"
 * before the request, rather than coming back as a validation error listing
 * every offending index.
 */
export const MAX_IMPORT_ROWS = 5000;

/** Extensions/MIME types a CSV may plausibly arrive as, across browsers and OSes. */
const CSV_MIME_TYPES = ['text/csv', 'application/csv', 'text/plain', ''];

/** Whether `file` looks like a CSV — by extension first, since MIME types vary wildly. */
export function isCsvFile(file: { name: string; type: string }): boolean {
  if (file.name.toLowerCase().endsWith('.csv')) return true;
  return CSV_MIME_TYPES.includes(file.type);
}

/** Minimal, quoted-field-aware CSV line splitter. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function parseCsv(text: string): CsvImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]!).map(
    (h) => HEADER_ALIASES[h.toLowerCase().replace(/[\s_]+/g, '')] ?? null,
  );
  const rows: CsvImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!);
    const row: Partial<CsvImportRow> = {};
    headers.forEach((field, idx) => {
      if (field && cells[idx]) row[field] = cells[idx];
    });
    if (row.phone) rows.push(row as CsvImportRow);
  }
  return rows;
}

export default function ImportPage() {
  const [text, setText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importMut = useImportCsv();
  // POST /realty/leads/import is an undecorated write — STAFF and above. The
  // sample-CSV download is generated client-side and stays available to all.
  const { canWrite } = usePermissions();

  const rows = useMemo(() => parseCsv(text), [text]);
  const tooManyRows = rows.length > MAX_IMPORT_ROWS;
  const result = importMut.data;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isCsvFile(file)) {
      setFileError(`"${file.name}" is not a CSV. Export the sheet as .csv and try again.`);
      return;
    }
    if (file.size > MAX_CSV_FILE_BYTES) {
      setFileError(
        `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ` +
          `${MAX_CSV_FILE_BYTES / 1024 / 1024} MB. Split it into smaller files.`,
      );
      return;
    }
    setFileError(null);
    setText(await file.text());
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'desk-leads-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Import Contacts"
        description="Bulk-import leads from a CSV. Duplicates merge on phone number — one buyer, one history."
        actions={
          <Button variant="secondary" onClick={downloadSample}>
            <Download className="h-4 w-4" /> Sample CSV
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <FileUp className="h-4 w-4" /> Upload .csv
            </Button>
            <span className="text-xs text-muted-foreground">or paste CSV below</span>
          </div>

          {fileError && (
            <p role="alert" className="text-xs text-danger">
              {fileError}
            </p>
          )}

          <Textarea
            rows={8}
            placeholder={SAMPLE_CSV}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono text-xs"
          />

          {rows.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{rows.length} rows parsed</p>
                {canWrite && (
                  <Button
                    loading={importMut.isPending}
                    disabled={tooManyRows}
                    onClick={() => importMut.mutate(rows)}
                  >
                    <Upload className="h-4 w-4" /> Import {rows.length} leads
                  </Button>
                )}
              </div>

              {tooManyRows && (
                <p role="alert" className="text-xs text-danger">
                  {rows.length} rows is over the {MAX_IMPORT_ROWS}-row limit for one import.
                  Split the file and import it in batches.
                </p>
              )}

              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Phone</TH>
                      <TH>Name</TH>
                      <TH>Email</TH>
                      <TH>Source</TH>
                      <TH>Listing</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.slice(0, 50).map((r, i) => (
                      <TR key={i}>
                        <TD>{r.phone}</TD>
                        <TD>{r.name ?? '—'}</TD>
                        <TD>{r.email ?? '—'}</TD>
                        <TD>{r.source ?? 'CSV'}</TD>
                        <TD>{r.listingRef ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {rows.length > 50 && (
                  <p className="p-2 text-center text-xs text-muted-foreground">
                    Showing first 50 of {rows.length} rows
                  </p>
                )}
              </div>
            </>
          ) : (
            text.trim().length > 0 && (
              <p className="text-xs text-muted-foreground">
                No valid rows found. Ensure the first line is a header with a <code>phone</code>{' '}
                column.
              </p>
            )
          )}

          {result && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold">Import complete</h3>
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">{result.total} total</Badge>
                <Badge tone="success">{result.created} created</Badge>
                <Badge tone="info">{result.merged} merged</Badge>
                <Badge tone="warning">{result.skipped} skipped</Badge>
              </div>
              {result.errors.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-semibold text-muted-foreground">Skipped rows</p>
                  <ul className="flex flex-col gap-0.5">
                    {result.errors.slice(0, 20).map((e, i) => (
                      <li key={i} className="text-xs text-muted-foreground">
                        Row {e.row}: {e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {rows.length === 0 && text.trim().length === 0 && !result && (
            <EmptyState
              icon={Upload}
              title="Import your existing leads"
              description="Upload or paste a CSV with a phone column. Optional columns: name, email, source, subSource, listingRef."
            />
          )}
        </div>
      </div>
    </div>
  );
}
