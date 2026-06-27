'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ImageOff, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCreateCatalogItem, useUpdateCatalogItem } from '@/hooks/use-catalog';
import { paiseToRupeesInput, rupeesToPaise } from '@/lib/money';
import type { CatalogCategory, CreateCatalogItemRequest, VariantDraft } from '@/lib/commerce-types';
import type { CatalogItem, CatalogItemType } from '@/lib/types';

const TYPE_OPTIONS = [
  { label: 'Product', value: 'PRODUCT' },
  { label: 'Service', value: 'SERVICE' },
  { label: 'Package', value: 'PACKAGE' },
  { label: 'Digital', value: 'DIGITAL' },
];

interface FormState {
  name: string;
  type: CatalogItemType;
  categoryId: string;
  shortDescription: string;
  description: string;
  basePrice: string;
  discountPrice: string;
  sku: string;
  unit: string;
  taxRate: string;
  tags: string;
  imageUrls: string[];
  isActive: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity: string;
  lowStockThreshold: string;
  variants: VariantDraft[];
}

function emptyForm(): FormState {
  return {
    name: '',
    type: 'PRODUCT',
    categoryId: '',
    shortDescription: '',
    description: '',
    basePrice: '',
    discountPrice: '',
    sku: '',
    unit: '',
    taxRate: '',
    tags: '',
    imageUrls: [],
    isActive: true,
    isAvailable: true,
    trackInventory: false,
    stockQuantity: '',
    lowStockThreshold: '',
    variants: [],
  };
}

function fromItem(item: CatalogItem): FormState {
  return {
    name: item.name,
    type: item.type,
    categoryId: item.categoryId ?? '',
    shortDescription: item.shortDescription ?? '',
    description: item.description ?? '',
    basePrice: paiseToRupeesInput(item.basePrice),
    discountPrice: paiseToRupeesInput(item.discountPrice),
    sku: item.sku ?? '',
    unit: item.unit ?? '',
    taxRate: item.taxRate != null ? String(item.taxRate) : '',
    tags: item.tags.join(', '),
    imageUrls: item.imageUrls ?? [],
    isActive: item.isActive,
    isAvailable: item.isAvailable,
    trackInventory: item.trackInventory,
    stockQuantity: item.stockQuantity != null ? String(item.stockQuantity) : '',
    lowStockThreshold: item.lowStockThreshold != null ? String(item.lowStockThreshold) : '',
    variants: item.variants.map((v) => ({
      name: v.name,
      sku: v.sku,
      price: v.price,
      discountPrice: v.discountPrice,
      stockQuantity: v.stockQuantity,
      isActive: v.isActive,
      attributes: v.attributes,
      imageUrl: v.imageUrl,
    })),
  };
}

export function ProductFormModal({
  open,
  onClose,
  item,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  item?: CatalogItem | null;
  categories: CatalogCategory[];
}) {
  const create = useCreateCatalogItem();
  const update = useUpdateCatalogItem();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [newImage, setNewImage] = useState('');

  const editing = !!item;
  const pending = create.isPending || update.isPending;
  const isError = create.isError || update.isError;

  // Reset the form whenever the modal opens (for a new or different item).
  useEffect(() => {
    if (open) {
      setForm(item ? fromItem(item) : emptyForm());
      setNewImage('');
    }
  }, [open, item]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addImage = () => {
    const url = newImage.trim();
    if (!url) return;
    set('imageUrls', [...form.imageUrls, url]);
    setNewImage('');
  };

  const addVariant = () =>
    set('variants', [
      ...form.variants,
      { name: '', price: rupeesToPaise(form.basePrice), isActive: true, attributes: {} },
    ]);

  const updateVariant = (idx: number, patch: Partial<VariantDraft>) =>
    set(
      'variants',
      form.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    );

  const removeVariant = (idx: number) =>
    set('variants', form.variants.filter((_, i) => i !== idx));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: CreateCatalogItemRequest = {
      type: form.type,
      name: form.name.trim(),
      categoryId: form.categoryId || undefined,
      shortDescription: form.shortDescription.trim() || undefined,
      description: form.description.trim() || undefined,
      basePrice: rupeesToPaise(form.basePrice),
      discountPrice: form.discountPrice ? rupeesToPaise(form.discountPrice) : undefined,
      sku: form.sku.trim() || undefined,
      unit: form.unit.trim() || undefined,
      taxRate: form.taxRate ? Number(form.taxRate) : undefined,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      imageUrls: form.imageUrls,
      isActive: form.isActive,
      isAvailable: form.isAvailable,
      trackInventory: form.trackInventory,
      stockQuantity: form.trackInventory && form.stockQuantity ? Number(form.stockQuantity) : undefined,
      lowStockThreshold: form.trackInventory && form.lowStockThreshold ? Number(form.lowStockThreshold) : undefined,
      variants: form.variants.map((v) => ({ ...v, name: v.name.trim() })),
    };

    const onSuccess = () => onClose();
    if (editing && item) update.mutate({ id: item.id, body }, { onSuccess });
    else create.mutate(body, { onSuccess });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit item' : 'Add item'}
      description="Products, services, packages and digital goods in your catalog."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" loading={pending} disabled={!form.name.trim() || !form.basePrice}>
            {editing ? 'Save changes' : 'Create item'}
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit} className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Margherita Pizza" required />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => set('type', e.target.value as CatalogItemType)} options={TYPE_OPTIONS} />
          </Field>
          <Field label="Category">
            <Select
              value={form.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              options={[{ label: 'Uncategorised', value: '' }, ...categories.map((c) => ({ label: c.name, value: c.id }))]}
            />
          </Field>
        </div>

        <Field label="Short description">
          <Input value={form.shortDescription} onChange={(e) => set('shortDescription', e.target.value)} placeholder="One-line summary" />
        </Field>
        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={3}
            placeholder="Full details shown to customers"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Price (₹)">
            <Input type="number" min="0" step="0.01" value={form.basePrice} onChange={(e) => set('basePrice', e.target.value)} required />
          </Field>
          <Field label="Discount (₹)">
            <Input type="number" min="0" step="0.01" value={form.discountPrice} onChange={(e) => set('discountPrice', e.target.value)} />
          </Field>
          <Field label="Tax rate (%)">
            <Input type="number" min="0" step="0.1" value={form.taxRate} onChange={(e) => set('taxRate', e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={form.unit} onChange={(e) => set('unit', e.target.value)} placeholder="piece, kg, hour" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="SKU">
            <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} placeholder="SKU-001" />
          </Field>
          <Field label="Tags" hint="Comma-separated">
            <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="bestseller, vegan" />
          </Field>
        </div>

        {/* Images */}
        <Field label="Images" hint="Paste an image URL and add it.">
          <div className="flex gap-2">
            <Input
              value={newImage}
              onChange={(e) => setNewImage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addImage();
                }
              }}
              placeholder="https://…/image.jpg"
            />
            <Button type="button" variant="outline" onClick={addImage}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          {form.imageUrls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {form.imageUrls.map((url, idx) => (
                <div key={idx} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => set('imageUrls', form.imageUrls.filter((_, i) => i !== idx))}
                    className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove image"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Field>

        {/* Inventory */}
        <div className="rounded-lg border border-border p-4">
          <Switch
            checked={form.trackInventory}
            onChange={(v) => set('trackInventory', v)}
            label="Track inventory"
            description="Show stock counts and low-stock warnings."
          />
          {form.trackInventory && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Field label="Stock quantity">
                <Input type="number" min="0" value={form.stockQuantity} onChange={(e) => set('stockQuantity', e.target.value)} />
              </Field>
              <Field label="Low-stock threshold">
                <Input type="number" min="0" value={form.lowStockThreshold} onChange={(e) => set('lowStockThreshold', e.target.value)} />
              </Field>
            </div>
          )}
        </div>

        {/* Variants */}
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Variants</p>
              <p className="text-xs text-muted-foreground">Sizes, colours or session lengths with their own price.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addVariant}>
              <Plus className="h-4 w-4" /> Variant
            </Button>
          </div>
          {form.variants.length > 0 && (
            <div className="mt-3 space-y-2">
              {form.variants.map((v, idx) => (
                <div key={idx} className="flex items-end gap-2">
                  <Field label={idx === 0 ? 'Name' : undefined} className="flex-1">
                    <Input value={v.name} onChange={(e) => updateVariant(idx, { name: e.target.value })} placeholder="Large" />
                  </Field>
                  <Field label={idx === 0 ? 'Price (₹)' : undefined} className="w-28">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={paiseToRupeesInput(v.price)}
                      onChange={(e) => updateVariant(idx, { price: rupeesToPaise(e.target.value) })}
                    />
                  </Field>
                  <Field label={idx === 0 ? 'Stock' : undefined} className="w-20">
                    <Input
                      type="number"
                      min="0"
                      value={v.stockQuantity != null ? String(v.stockQuantity) : ''}
                      onChange={(e) => updateVariant(idx, { stockQuantity: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </Field>
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeVariant(idx)} aria-label="Remove variant">
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} label="Active" description="Listed in your catalog." />
          <Switch
            checked={form.isAvailable}
            onChange={(v) => set('isAvailable', v)}
            label="Available to buy"
            description="Customers can order this right now."
          />
        </div>

        {form.imageUrls.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageOff className="h-3.5 w-3.5" /> No images yet — items look better with at least one.
          </p>
        )}
        {isError && <p className="text-sm text-danger">Couldn’t save the item. Please try again.</p>}
      </form>
    </Modal>
  );
}
