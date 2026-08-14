/**
 * The CSV lead-import page.
 *
 * Almost all of this page is one pure function — the parser — and it decides
 * what gets written into the lead book, so that is where the tests concentrate.
 * A header the broker's CRM spelled "Mobile" or "Phone Number" has to land on
 * `phone`; a row with no phone must be dropped rather than imported as a
 * nameless blank, because merging is keyed on phone and a blank key would fold
 * unrelated buyers into one history; and a quoted field containing a comma —
 * which is exactly how a project name with a locality arrives — must survive
 * as one value instead of shifting every column after it.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvImportResult, CsvImportRow } from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

const importMut = {
  mutate: vi.fn(),
  isPending: false,
  data: undefined as CsvImportResult | undefined,
};
let role: Role = 'STAFF';

vi.mock('@/hooks/use-realty', () => ({ useImportCsv: () => importMut }));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import ImportPage from './page';

const paste = (csv: string) => {
  render(<ImportPage />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: csv } });
};

/** The rows the Import button would send, read out of the preview table. */
function parsedRows(): CsvImportRow[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => {
      const [phone, name, email, source, listingRef] = within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent ?? '');
      return { phone, name, email, source, listingRef } as CsvImportRow;
    });
}

beforeEach(() => {
  importMut.isPending = false;
  importMut.data = undefined;
  role = 'STAFF';
  vi.clearAllMocks();
});

describe('the empty state', () => {
  it('explains what a valid CSV looks like before anything is pasted', () => {
    render(<ImportPage />);
    expect(screen.getByText('Import your existing leads')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says what is wrong when the pasted text parses to nothing', () => {
    paste('just some text with no header');
    expect(screen.getByText(/no valid rows found/i)).toBeInTheDocument();
    expect(screen.queryByText('Import your existing leads')).not.toBeInTheDocument();
  });

  it('needs more than a header line alone', () => {
    paste('phone,name');
    expect(screen.getByText(/no valid rows found/i)).toBeInTheDocument();
  });
});

describe('the parser', () => {
  it('maps a straightforward header row', () => {
    paste('phone,name,email,source,subSource,listingRef\n+919876543210,Priya,p@e.in,PORTAL,99acres,Lakeside 3BHK');
    expect(parsedRows()).toEqual([
      {
        phone: '+919876543210',
        name: 'Priya',
        email: 'p@e.in',
        source: 'PORTAL',
        listingRef: 'Lakeside 3BHK',
      },
    ]);
  });

  it.each([
    ['mobile', 'Mobile'],
    ['phonenumber', 'Phone Number'],
    ['contact', 'Contact'],
    ['whatsapp', 'WhatsApp'],
  ])('accepts %s as the phone column', (_alias, header) => {
    paste(`${header},name\n9811122233,Amit`);
    expect(parsedRows()[0].phone).toBe('9811122233');
  });

  it.each([
    ['Full Name', 'name'],
    ['Email ID', 'email'],
    ['Project', 'listingRef'],
    ['Listing Ref', 'listingRef'],
  ])('folds the %s column onto its canonical field', (header, field) => {
    paste(`phone,${header}\n9811122233,VALUE`);
    expect((parsedRows()[0] as Record<string, string>)[field]).toBe('VALUE');
  });

  it('routes Campaign to subSource, which the preview does not show', () => {
    paste('phone,Campaign\n9811122233,diwali-2026');
    // Recognised (so not rendered as an unknown column) but not a listing.
    expect(parsedRows()[0].listingRef).toBe('—');
    fireEvent.click(screen.getByRole('button', { name: /import 1 leads/i }));
    expect(importMut.mutate).toHaveBeenCalledWith([
      { phone: '9811122233', subSource: 'diwali-2026' },
    ]);
  });

  it('ignores a column it does not recognise instead of failing the row', () => {
    paste('phone,name,loyalty_tier\n9811122233,Amit,GOLD');
    expect(parsedRows()).toEqual([
      { phone: '9811122233', name: 'Amit', email: '—', source: 'CSV', listingRef: '—' },
    ]);
  });

  it('drops a row with no phone rather than importing a blank key', () => {
    paste('phone,name\n9811122233,Amit\n,Nobody\n9800000000,Priya');
    expect(parsedRows().map((r) => r.phone)).toEqual(['9811122233', '9800000000']);
  });

  it('keeps a quoted comma inside one field instead of shifting the columns', () => {
    paste('phone,name,listingRef\n9811122233,Amit,"Prestige Lakeside, Whitefield"');
    expect(parsedRows()[0].listingRef).toBe('Prestige Lakeside, Whitefield');
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    paste('phone,listingRef\n9811122233,"The ""Grand"" Tower"');
    expect(parsedRows()[0].listingRef).toBe('The "Grand" Tower');
  });

  it('trims the padding a hand-edited sheet leaves behind', () => {
    paste('  phone , name \n 9811122233 , Amit ');
    expect(parsedRows()[0]).toMatchObject({ phone: '9811122233', name: 'Amit' });
  });

  it('skips blank lines anywhere in the file', () => {
    paste('phone,name\n\n9811122233,Amit\n\n\n9800000000,Priya\n');
    expect(parsedRows()).toHaveLength(2);
  });

  it('handles CRLF line endings from a Windows export', () => {
    paste('phone,name\r\n9811122233,Amit\r\n');
    expect(parsedRows()[0].name).toBe('Amit');
  });

  it('leaves a short row’s missing cells empty rather than shifting them up', () => {
    paste('phone,name,email\n9811122233,Amit');
    expect(parsedRows()[0]).toMatchObject({ name: 'Amit', email: '—' });
  });

  it('defaults the source column when the sheet has none', () => {
    paste('phone,name\n9811122233,Amit');
    expect(parsedRows()[0].source).toBe('CSV');
  });
});

describe('the preview', () => {
  const manyRows = (n: number) =>
    ['phone,name', ...Array.from({ length: n }, (_, i) => `98000000${i + 10},Lead ${i}`)].join('\n');

  it('counts every parsed row', () => {
    paste(manyRows(3));
    expect(screen.getByText('3 rows parsed')).toBeInTheDocument();
  });

  it('caps the table at fifty rows and says how many were held back', () => {
    paste(manyRows(60));
    expect(screen.getAllByRole('row')).toHaveLength(51); // header + 50
    expect(screen.getByText('Showing first 50 of 60 rows')).toBeInTheDocument();
  });

  it('shows no cap note at exactly fifty rows', () => {
    paste(manyRows(50));
    expect(screen.queryByText(/showing first 50/i)).not.toBeInTheDocument();
  });
});

describe('the import', () => {
  const csv = 'phone,name\n9811122233,Amit\n9800000000,Priya';

  it('sends every parsed row, not only the previewed ones', () => {
    const rows = ['phone,name', ...Array.from({ length: 60 }, (_, i) => `98000000${i + 10},L${i}`)].join('\n');
    paste(rows);
    fireEvent.click(screen.getByRole('button', { name: /import 60 leads/i }));
    expect(importMut.mutate.mock.calls[0][0]).toHaveLength(60);
  });

  it('sends the parsed objects rather than the raw text', () => {
    paste(csv);
    fireEvent.click(screen.getByRole('button', { name: /import 2 leads/i }));
    expect(importMut.mutate).toHaveBeenCalledWith([
      { phone: '9811122233', name: 'Amit' },
      { phone: '9800000000', name: 'Priya' },
    ]);
  });

  it('is not offered to a VIEWER, who can still preview', () => {
    role = 'VIEWER';
    paste(csv);
    expect(screen.getByText('2 rows parsed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import 2 leads/i })).not.toBeInTheDocument();
  });

  it('reports the outcome once the import lands', () => {
    importMut.data = { total: 10, created: 6, merged: 3, skipped: 1, errors: [] };
    render(<ImportPage />);
    expect(screen.getByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText('10 total')).toBeInTheDocument();
    expect(screen.getByText('6 created')).toBeInTheDocument();
    expect(screen.getByText('3 merged')).toBeInTheDocument();
    expect(screen.getByText('1 skipped')).toBeInTheDocument();
  });

  it('names the rows it refused and why', () => {
    importMut.data = {
      total: 2,
      created: 1,
      merged: 0,
      skipped: 1,
      errors: [{ row: 2, reason: 'Invalid phone number' }],
    };
    render(<ImportPage />);
    expect(screen.getByText('Row 2: Invalid phone number')).toBeInTheDocument();
  });

  it('lists at most twenty skipped rows', () => {
    importMut.data = {
      total: 30,
      created: 0,
      merged: 0,
      skipped: 30,
      errors: Array.from({ length: 30 }, (_, i) => ({ row: i + 1, reason: 'Invalid phone' })),
    };
    render(<ImportPage />);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
  });

  it('omits the skipped-rows block when nothing was refused', () => {
    importMut.data = { total: 3, created: 3, merged: 0, skipped: 0, errors: [] };
    render(<ImportPage />);
    expect(screen.queryByText('Skipped rows')).not.toBeInTheDocument();
  });

  it('keeps the result visible instead of falling back to the empty state', () => {
    importMut.data = { total: 3, created: 3, merged: 0, skipped: 0, errors: [] };
    render(<ImportPage />);
    expect(screen.queryByText('Import your existing leads')).not.toBeInTheDocument();
  });
});

describe('file input and sample download', () => {
  it('reads a dropped file into the textarea', async () => {
    const { container } = render(<ImportPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['phone,name\n9811122233,Amit'], 'leads.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    expect(await screen.findByText('1 rows parsed')).toBeInTheDocument();
  });

  it('does nothing when the picker is dismissed without a file', () => {
    const { container } = render(<ImportPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [] });
    fireEvent.change(input);
    expect(screen.getByText('Import your existing leads')).toBeInTheDocument();
  });

  it('opens the picker from the Upload button', () => {
    const { container } = render(<ImportPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /upload \.csv/i }));
    expect(click).toHaveBeenCalled();
  });

  it('hands the sample CSV to the browser as a download and releases the blob', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:sample');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    render(<ImportPage />);
    fireEvent.click(screen.getByRole('button', { name: /sample csv/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample');
  });

  it('offers the sample to a VIEWER too, since it writes nothing', () => {
    role = 'VIEWER';
    render(<ImportPage />);
    expect(screen.getByRole('button', { name: /sample csv/i })).toBeInTheDocument();
  });
});
