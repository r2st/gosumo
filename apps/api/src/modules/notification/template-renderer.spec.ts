import { TemplateRenderer } from './template-renderer';

describe('TemplateRenderer', () => {
  let renderer: TemplateRenderer;

  beforeEach(() => {
    renderer = new TemplateRenderer();
  });

  it('substitutes simple and dot-path variables', () => {
    const result = renderer.render(
      { subject: 'Hi {{ name }}', text: 'Order {{ order.id }} is {{ order.status }}' },
      { name: 'Asha', order: { id: 'ORD-1', status: 'shipped' } },
    );
    expect(result.subject).toBe('Hi Asha');
    expect(result.text).toBe('Order ORD-1 is shipped');
    expect(result.missingVariables).toEqual([]);
  });

  it('renders unknown variables as empty and reports them', () => {
    const result = renderer.render(
      { text: 'Hello {{ name }}, code {{ otp }}' },
      { name: 'Ravi' },
    );
    expect(result.text).toBe('Hello Ravi, code ');
    expect(result.missingVariables).toEqual(['otp']);
  });

  it('defaults text to empty string and keeps null for absent fields', () => {
    const result = renderer.render({ text: undefined }, {});
    expect(result.text).toBe('');
    expect(result.subject).toBeNull();
    expect(result.html).toBeNull();
  });

  it('coerces numbers and tolerates whitespace in placeholders', () => {
    const result = renderer.render(
      { text: 'Total: {{  amount  }}' },
      { amount: 4999 },
    );
    expect(result.text).toBe('Total: 4999');
  });

  it('extractVariables lists every referenced variable across fields', () => {
    const vars = renderer.extractVariables({
      subject: 'Hi {{ name }}',
      title: '{{ name }}',
      text: '{{ order.id }} {{ amount }}',
      html: '<b>{{ amount }}</b>',
    });
    expect(vars.sort()).toEqual(['amount', 'name', 'order.id'].sort());
  });

  it('renderString substitutes a bare string', () => {
    expect(renderer.renderString('{{ a }}-{{ b }}', { a: 1, b: 2 })).toBe('1-2');
  });
});
