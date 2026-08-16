import {
  extractVariableNames,
  reconcileVariables,
  renderTemplate,
} from './template-variables.util';

describe('extractVariableNames', () => {
  it('finds every placeholder, tolerating whitespace', () => {
    expect(
      extractVariableNames('Hi {{customerName}}, your order {{ orderId }} ships {{when}}'),
    ).toEqual(['customerName', 'orderId', 'when']);
  });

  it('dedupes while keeping first-appearance order', () => {
    expect(extractVariableNames('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });

  it('supports dot paths', () => {
    expect(extractVariableNames('{{order.total}}')).toEqual(['order.total']);
  });

  it('ignores things that are not placeholders', () => {
    expect(extractVariableNames('50% off {a} {{ }} {{1abc}} plain text')).toEqual([]);
  });

  it('handles an empty body', () => {
    expect(extractVariableNames('')).toEqual([]);
  });
});

describe('reconcileVariables', () => {
  it('treats the body as the authority for which variables exist', () => {
    // Metadata for a variable the content does not contain is dropped — the
    // silent drift this prevents leaves a required variable declared for a
    // placeholder that no longer exists.
    const specs = reconcileVariables('Hi {{name}}', [
      { name: 'name' },
      { name: 'removedFromBody', required: false },
    ]);

    expect(specs.map((s) => s.name)).toEqual(['name']);
  });

  it('gives an undeclared variable a required default', () => {
    // The safe default stops a half-filled message rather than letting it
    // through quietly.
    expect(reconcileVariables('{{amount}}')).toEqual([{ name: 'amount', required: true }]);
  });

  it('honours an explicit optional declaration', () => {
    expect(reconcileVariables('{{nickname}}', [{ name: 'nickname', required: false }])).toEqual(
      [{ name: 'nickname', required: false }],
    );
  });

  it('keeps labels and defaults', () => {
    expect(
      reconcileVariables('{{n}}', [
        { name: 'n', label: 'Customer name', defaultValue: 'there', required: false },
      ]),
    ).toEqual([
      { name: 'n', required: false, label: 'Customer name', defaultValue: 'there' },
    ]);
  });

  it('preserves an empty-string default rather than discarding it as falsy', () => {
    const specs = reconcileVariables('{{x}}', [{ name: 'x', defaultValue: '' }]);
    expect(specs[0]).toHaveProperty('defaultValue', '');
  });
});

describe('renderTemplate', () => {
  const specs = [
    { name: 'customerName', required: true },
    { name: 'amount', required: true },
    { name: 'nickname', required: false },
  ];

  it('substitutes supplied values', () => {
    const result = renderTemplate(
      'Hi {{customerName}}, your refund of {{amount}} is done.',
      { customerName: 'Asha', amount: '₹1,299' },
      specs,
    );

    expect(result.content).toBe('Hi Asha, your refund of ₹1,299 is done.');
    expect(result.missingRequired).toEqual([]);
  });

  it('leaves a missing required variable as its placeholder, not as a blank', () => {
    // "your refund of  is done" is a sentence the agent did not write. Leaving
    // the placeholder makes the omission visible instead of subtle.
    const result = renderTemplate(
      'Your refund of {{amount}} is done.',
      {},
      [{ name: 'amount', required: true }],
    );

    expect(result.content).toBe('Your refund of {{amount}} is done.');
    expect(result.missingRequired).toEqual(['amount']);
  });

  it('renders a missing optional variable as empty', () => {
    const result = renderTemplate('Hi {{nickname}}!', {}, specs);
    expect(result.content).toBe('Hi !');
    expect(result.missingRequired).toEqual([]);
  });

  it('falls back to a declared default and says so', () => {
    const result = renderTemplate('Hi {{name}}!', {}, [
      { name: 'name', required: true, defaultValue: 'there' },
    ]);

    expect(result.content).toBe('Hi there!');
    expect(result.missingRequired).toEqual([]);
    expect(result.usedDefaults).toEqual(['name']);
  });

  it('prefers a supplied value over the default', () => {
    const result = renderTemplate('Hi {{name}}!', { name: 'Asha' }, [
      { name: 'name', required: true, defaultValue: 'there' },
    ]);

    expect(result.content).toBe('Hi Asha!');
    expect(result.usedDefaults).toEqual([]);
  });

  it('treats an empty supplied value as unsupplied', () => {
    // An agent who tabbed past the field has not answered it.
    const result = renderTemplate('{{amount}}', { amount: '' }, [
      { name: 'amount', required: true },
    ]);
    expect(result.missingRequired).toEqual(['amount']);
  });

  it('treats an undeclared variable as required', () => {
    // Most likely a typo in the body, and a typo that renders empty is invisible.
    const result = renderTemplate('Hi {{custmerName}}', { customerName: 'Asha' }, specs);

    expect(result.missingRequired).toEqual(['custmerName']);
    expect(result.content).toContain('{{custmerName}}');
  });

  it('substitutes numbers', () => {
    const result = renderTemplate('{{n}} items', { n: 3 }, [{ name: 'n', required: true }]);
    expect(result.content).toBe('3 items');
  });

  it('substitutes every occurrence of a repeated variable', () => {
    const result = renderTemplate('{{a}} and {{a}}', { a: 'x' }, [
      { name: 'a', required: true },
    ]);
    expect(result.content).toBe('x and x');
  });

  it('reports a repeated missing variable once', () => {
    const result = renderTemplate('{{a}} {{a}}', {}, [{ name: 'a', required: true }]);
    expect(result.missingRequired).toEqual(['a']);
  });

  it('does not re-interpolate a value that itself looks like a placeholder', () => {
    // A value is data. If it could inject a placeholder, an agent typing
    // "{{amount}}" into the name field would make the template render its own
    // internals — or loop.
    const result = renderTemplate(
      'Hi {{name}}, your total is {{amount}}.',
      { name: '{{amount}}', amount: '₹500' },
      [
        { name: 'name', required: true },
        { name: 'amount', required: true },
      ],
    );

    expect(result.content).toBe('Hi {{amount}}, your total is ₹500.');
    expect(result.missingRequired).toEqual([]);
  });

  it('leaves a body with no variables untouched', () => {
    expect(renderTemplate('No variables here.', {}, []).content).toBe('No variables here.');
  });
});
