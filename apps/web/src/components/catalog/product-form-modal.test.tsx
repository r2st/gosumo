/**
 * The catalog item form and the category manager.
 *
 * This form is the main place an operator types money into GoSumo, so the
 * rupee→paise conversion at its boundary is the thing worth pinning: a price
 * that reaches the API a hundred times too small is a silent, expensive bug.
 * The rest of the coverage is about the form only sending what it means to —
 * blank optional fields must be omitted rather than sent as empty strings, and
 * inventory numbers must not leak through when tracking is off.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogCategory } from '@/lib/commerce-types';
import type { CatalogItem } from '@/lib/types';

const mutations = {
  create: vi.fn(),
  update: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
};

const flags = { saveError: false, deleteError: false };
const categoriesState = {
  data: undefined as { categories: CatalogCategory[] } | undefined,
  isLoading: false,
};

const asMutation = (mutate: ReturnType<typeof vi.fn>, isError = false) => ({
  mutate,
  isPending: false,
  isError,
});

vi.mock('@/hooks/use-catalog', () => ({
  useCreateCatalogItem: () => asMutation(mutations.create, flags.saveError),
  useUpdateCatalogItem: () => asMutation(mutations.update, flags.saveError),
  useCategories: () => categoriesState,
  useCreateCategory: () => asMutation(mutations.createCategory),
  useUpdateCategory: () => asMutation(mutations.updateCategory),
  useDeleteCategory: () => asMutation(mutations.deleteCategory, flags.deleteError),
}));

import { ProductFormModal } from './product-form-modal';
import { CategoryManager } from './category-manager';

const CATEGORIES: CatalogCategory[] = [
  { id: 'c1', name: 'Beverages', description: 'Drinks', itemCount: 3 } as CatalogCategory,
  { id: 'c2', name: 'Snacks', description: null, itemCount: 1 } as CatalogCategory,
];

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'item-1',
    businessId: 'b1',
    categoryId: 'c1',
    type: 'PRODUCT',
    name: 'Cold Brew',
    slug: 'cold-brew',
    description: 'House blend',
    shortDescription: 'Iced coffee',
    imageUrls: ['https://cdn.example/1.jpg'],
    basePrice: 25_000,
    currency: 'INR',
    discountPrice: 20_000,
    taxRate: 5,
    taxIncluded: false,
    sku: 'CB-01',
    unit: 'cup',
    isActive: true,
    isAvailable: true,
    trackInventory: true,
    stockQuantity: 12,
    lowStockThreshold: 3,
    tags: ['bestseller', 'vegan'],
    variants: [],
    metadata: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as CatalogItem;
}

/** Opens the form and fills the two fields the submit button requires. */
function renderForm(item?: CatalogItem | null) {
  const onClose = vi.fn();
  const utils = render(
    <ProductFormModal open onClose={onClose} item={item} categories={CATEGORIES} />,
  );
  return { onClose, ...utils };
}

const nameInput = () => screen.getByPlaceholderText('e.g. Margherita Pizza');
const priceInput = () => screen.getAllByRole('spinbutton')[0];
const saveButton = () => screen.getByRole('button', { name: /Create item|Save changes/ });

beforeEach(() => {
  flags.saveError = false;
  flags.deleteError = false;
  categoriesState.data = { categories: CATEGORIES };
  categoriesState.isLoading = false;
  vi.clearAllMocks();
});

describe('ProductFormModal open/close', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <ProductFormModal open={false} onClose={vi.fn()} categories={CATEGORIES} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('titles itself by whether it is creating or editing', () => {
    const { unmount } = renderForm();
    expect(screen.getByText('Add item')).toBeInTheDocument();
    unmount();

    renderForm(makeItem());
    expect(screen.getByText('Edit item')).toBeInTheDocument();
  });

  it('closes from Cancel without saving', () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(mutations.create).not.toHaveBeenCalled();
  });

  it('lists the categories plus an uncategorised option', () => {
    renderForm();
    const selects = screen.getAllByRole('combobox');
    const options = Array.from((selects[1] as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['Uncategorised', 'Beverages', 'Snacks']);
  });
});

describe('ProductFormModal validation', () => {
  it('needs both a name and a price before it can save', () => {
    renderForm();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    expect(saveButton()).toBeDisabled();

    fireEvent.change(priceInput(), { target: { value: '150' } });
    expect(saveButton()).toBeEnabled();
  });

  it('treats a whitespace-only name as no name', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    expect(saveButton()).toBeDisabled();
  });

  it('nudges when the item has no image', () => {
    renderForm();
    expect(screen.getByText(/No images yet/)).toBeInTheDocument();
  });

  it('reports a failed save', () => {
    flags.saveError = true;
    renderForm();
    expect(screen.getByText(/Couldn’t save the item/)).toBeInTheDocument();
  });
});

describe('ProductFormModal money conversion', () => {
  it('sends the price and discount to the API in paise', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    const [price, discount] = screen.getAllByRole('spinbutton');
    fireEvent.change(price, { target: { value: '150.50' } });
    fireEvent.change(discount, { target: { value: '99' } });
    fireEvent.click(saveButton());

    const body = mutations.create.mock.calls[0][0];
    expect(body.basePrice).toBe(15050);
    expect(body.discountPrice).toBe(9900);
  });

  it('omits the discount entirely rather than sending zero', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    fireEvent.click(saveButton());
    expect(mutations.create.mock.calls[0][0].discountPrice).toBeUndefined();
  });

  it('renders an existing item’s paise prices back as rupees', () => {
    renderForm(makeItem({ basePrice: 25_000, discountPrice: 20_000 }));
    expect(screen.getByDisplayValue('250')).toBeInTheDocument();
    expect(screen.getByDisplayValue('200')).toBeInTheDocument();
  });
});

describe('ProductFormModal payload shaping', () => {
  function fillMinimum() {
    fireEvent.change(nameInput(), { target: { value: '  Latte  ' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
  }

  it('trims the name and drops blank optional fields', () => {
    renderForm();
    fillMinimum();
    fireEvent.click(saveButton());

    const body = mutations.create.mock.calls[0][0];
    expect(body.name).toBe('Latte');
    expect(body.categoryId).toBeUndefined();
    expect(body.sku).toBeUndefined();
    expect(body.unit).toBeUndefined();
    expect(body.shortDescription).toBeUndefined();
    expect(body.taxRate).toBeUndefined();
  });

  it('splits the tag field on commas and drops the empties', () => {
    renderForm();
    fillMinimum();
    fireEvent.change(screen.getByPlaceholderText('bestseller, vegan'), {
      target: { value: ' bestseller , , vegan ' },
    });
    fireEvent.click(saveButton());
    expect(mutations.create.mock.calls[0][0].tags).toEqual(['bestseller', 'vegan']);
  });

  it('omits stock numbers while inventory tracking is off', () => {
    renderForm();
    fillMinimum();
    fireEvent.click(saveButton());
    const body = mutations.create.mock.calls[0][0];
    expect(body.trackInventory).toBe(false);
    expect(body.stockQuantity).toBeUndefined();
    expect(body.lowStockThreshold).toBeUndefined();
  });

  it('reveals and sends the stock fields once tracking is switched on', () => {
    renderForm();
    fillMinimum();
    fireEvent.click(screen.getAllByRole('switch')[0]);

    const numbers = screen.getAllByRole('spinbutton');
    // Price, discount, tax, then the two inventory inputs.
    fireEvent.change(numbers[3], { target: { value: '25' } });
    fireEvent.change(numbers[4], { target: { value: '5' } });
    fireEvent.click(saveButton());

    const body = mutations.create.mock.calls[0][0];
    expect(body.trackInventory).toBe(true);
    expect(body.stockQuantity).toBe(25);
    expect(body.lowStockThreshold).toBe(5);
  });

  it('sends the availability switches as booleans', () => {
    renderForm();
    fillMinimum();
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[switches.length - 1]);
    fireEvent.click(saveButton());

    const body = mutations.create.mock.calls[0][0];
    expect(body.isActive).toBe(true);
    expect(body.isAvailable).toBe(false);
  });

  it('updates instead of creating when editing an existing item', () => {
    const item = makeItem();
    renderForm(item);
    fireEvent.change(nameInput(), { target: { value: 'Cold Brew XL' } });
    fireEvent.click(saveButton());

    expect(mutations.create).not.toHaveBeenCalled();
    expect(mutations.update).toHaveBeenCalledWith(
      { id: 'item-1', body: expect.objectContaining({ name: 'Cold Brew XL' }) },
      expect.anything(),
    );
  });

  it('closes once the save succeeds', () => {
    const { onClose } = renderForm();
    fillMinimum();
    fireEvent.click(saveButton());
    act(() => mutations.create.mock.calls[0][1].onSuccess());
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ProductFormModal images', () => {
  it('adds a pasted URL and clears the box', () => {
    renderForm();
    const box = screen.getByPlaceholderText('https://…/image.jpg');
    fireEvent.change(box, { target: { value: ' https://cdn.example/a.jpg ' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));

    expect(box).toHaveValue('');
    expect(screen.queryByText(/No images yet/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(1);
  });

  it('adds on Enter without submitting the form', () => {
    renderForm();
    const box = screen.getByPlaceholderText('https://…/image.jpg');
    fireEvent.change(box, { target: { value: 'https://cdn.example/a.jpg' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(1);
    expect(mutations.create).not.toHaveBeenCalled();
  });

  it('refuses a blank URL', () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('https://…/image.jpg'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByText(/No images yet/)).toBeInTheDocument();
  });

  it('removes the image at the clicked index', () => {
    renderForm(makeItem({ imageUrls: ['https://a.jpg', 'https://b.jpg'] }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove image' })[0]);
    // The thumbnails are decorative (alt=""), so they carry no img role.
    const remaining = Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(remaining).toEqual(['https://b.jpg']);
  });
});

describe('ProductFormModal variants', () => {
  it('seeds a new variant at the item’s base price', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));
    fireEvent.click(saveButton());

    expect(mutations.create.mock.calls[0][0].variants).toEqual([
      { name: '', price: 15000, isActive: true, attributes: {} },
    ]);
  });

  it('edits one variant without touching its siblings', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));

    const [first, second] = screen.getAllByPlaceholderText('Large');
    fireEvent.change(first, { target: { value: 'Small' } });
    fireEvent.change(second, { target: { value: 'Large' } });
    fireEvent.click(saveButton());

    const variants = mutations.create.mock.calls[0][0].variants;
    expect(variants.map((v: { name: string }) => v.name)).toEqual(['Small', 'Large']);
  });

  it('removes the variant at the clicked index', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));
    fireEvent.change(screen.getAllByPlaceholderText('Large')[0], { target: { value: 'Small' } });

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove variant' })[0]);
    fireEvent.click(saveButton());
    expect(mutations.create.mock.calls[0][0].variants).toHaveLength(1);
    expect(mutations.create.mock.calls[0][0].variants[0].name).toBe('');
  });

  it('converts a variant price back to paise as it is typed', () => {
    renderForm();
    fireEvent.change(nameInput(), { target: { value: 'Latte' } });
    fireEvent.change(priceInput(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Variant/ }));

    const numbers = screen.getAllByRole('spinbutton');
    // Price, discount, tax, then the variant's price and stock.
    fireEvent.change(numbers[3], { target: { value: '199.99' } });
    fireEvent.change(numbers[4], { target: { value: '7' } });
    fireEvent.click(saveButton());

    const [variant] = mutations.create.mock.calls[0][0].variants;
    expect(variant.price).toBe(19999);
    expect(variant.stockQuantity).toBe(7);
  });
});

describe('CategoryManager', () => {
  function open() {
    const onClose = vi.fn();
    render(<CategoryManager open onClose={onClose} />);
    return onClose;
  }

  it('lists each category with a correctly pluralised item count', () => {
    open();
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('shows a loading state and an empty state', () => {
    categoriesState.data = undefined;
    categoriesState.isLoading = true;
    const { unmount } = render(<CategoryManager open onClose={vi.fn()} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();

    categoriesState.isLoading = false;
    categoriesState.data = { categories: [] };
    render(<CategoryManager open onClose={vi.fn()} />);
    expect(screen.getByText('No categories yet')).toBeInTheDocument();
  });

  it('creates a category, omitting a blank description', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('e.g. Beverages'), {
      target: { value: '  Desserts  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add category/ }));
    expect(mutations.createCategory).toHaveBeenCalledWith(
      { name: 'Desserts', description: undefined },
      expect.anything(),
    );
  });

  it('refuses a blank name', () => {
    open();
    const submit = screen.getByRole('button', { name: /Add category/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('e.g. Beverages'), { target: { value: '  ' } });
    expect(submit).toBeDisabled();
  });

  it('loads a category into the form for editing and updates it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Beverages' }));
    expect(screen.getByDisplayValue('Beverages')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Drinks')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Beverages'), { target: { value: 'Drinks & More' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutations.updateCategory).toHaveBeenCalledWith(
      { id: 'c1', body: { name: 'Drinks & More', description: 'Drinks' } },
      expect.anything(),
    );
    expect(mutations.createCategory).not.toHaveBeenCalled();
  });

  it('clears the edit and goes back to creating', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Beverages' }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel edit/ }));
    expect(screen.getByPlaceholderText('e.g. Beverages')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Add category/ })).toBeInTheDocument();
  });

  it('resets the form once a save succeeds', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('e.g. Beverages'), {
      target: { value: 'Desserts' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add category/ }));
    act(() => mutations.createCategory.mock.calls[0][1].onSuccess());
    expect(screen.getByPlaceholderText('e.g. Beverages')).toHaveValue('');
  });

  it('deletes by id and explains a refused delete', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Snacks' }));
    expect(mutations.deleteCategory).toHaveBeenCalledWith('c2');

    flags.deleteError = true;
    render(<CategoryManager open onClose={vi.fn()} />);
    expect(screen.getAllByText(/may still contain items/).length).toBeGreaterThan(0);
  });

  it('scopes each row’s controls to that category', () => {
    open();
    const row = screen.getByText('Snacks').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Delete Snacks' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete Beverages' })).toBeNull();
  });
});
