import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const inAddin = (path: string) => fileURLToPath(new URL(`../../src/addin/${path}`, import.meta.url));
const read = (path: string) => readFileSync(inAddin(path), 'utf8');

const office = read('manifest/manifest-office.xml');
const outlook = read('manifest/manifest-outlook.xml');

const render = (xml: string, base = 'https://example.test/pane/') =>
  xml.replaceAll('__ADDIN_BASE_URL__', base).replaceAll('__ADDIN_ORIGIN__', new URL(base).origin);

/** A strict check that every tag closes, in order. A browser's parser would mend a mistake instead. */
function expectWellFormed(xml: string) {
  const stack: string[] = [];
  const tags = xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:.]+)((?:\s+[\w:.]+="[^"<]*")*)\s*(\/?)>/g);
  let covered = 0;
  for (const [text, closing, name, , selfClosing] of tags) {
    covered += text.length;
    if (closing) expect(stack.pop(), `closing ${name}`).toBe(name);
    else if (!selfClosing) stack.push(name);
  }
  expect(stack).toEqual([]);
  // Whatever the pattern did not match has to be plain text, or a tag is malformed.
  expect(xml.replace(/<\?xml[^>]*\?>/, '').match(/</g)?.length).toBe(
    [...xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:.]+)((?:\s+[\w:.]+="[^"<]*")*)\s*(\/?)>/g)].length,
  );
  expect(covered).toBeGreaterThan(0);
}

const attributes = (xml: string, name: string) => [...xml.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const topLevelOrder = (xml: string) => {
  const body = xml.slice(xml.indexOf('>', xml.indexOf('<OfficeApp')) + 1);
  const names: string[] = [];
  let depth = 0;
  for (const [, closing, name, selfClosing] of body.matchAll(/<(\/?)([\w:.]+)(?:\s[^>]*?)?(\/?)>/g)) {
    if (closing) depth--;
    else {
      if (depth === 0) names.push(name);
      if (!selfClosing) depth++;
    }
  }
  return names.filter((name) => name !== 'OfficeApp');
};

describe.each([
  ['manifest-office.xml', office],
  ['manifest-outlook.xml', outlook],
])('%s', (_name, xml) => {
  it('is well formed', () => {
    expectWellFormed(xml);
    expectWellFormed(render(xml));
  });

  it('resolves every resource reference, within the length Office allows', () => {
    const defined = new Set([...xml.matchAll(/<bt:(?:Image|Url|String) id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set(attributes(xml, 'resid'));
    for (const id of used) expect(defined, `${id} should be defined`).toContain(id);
    for (const id of defined) expect(used, `${id} should be used`).toContain(id);
    for (const id of [...defined, ...used]) expect(id.length).toBeLessThanOrEqual(32);
  });

  it('points only at the base URL, which the build fills in', () => {
    const rendered = render(xml);
    expect(rendered).not.toContain('__ADDIN');
    expect(rendered).not.toContain('localhost');
    const urls = [...rendered.matchAll(/DefaultValue="(https:[^"]+)"/g)].map((m) => m[1]);
    const own = urls.filter((url) => !url.includes('github.com'));
    expect(own.length).toBeGreaterThan(3);
    for (const url of own) expect(url.startsWith('https://example.test/pane/')).toBe(true);
    expect(rendered).toContain('<AppDomain>https://example.test</AppDomain>');
  });

  it('names an icon that exists for every icon URL', () => {
    const icons = [...xml.matchAll(/__ADDIN_BASE_URL__(icon-\d+\.png)/g)].map((m) => m[1]);
    expect(icons.length).toBeGreaterThan(3);
    for (const icon of icons) expect(existsSync(inAddin(`assets/${icon}`)), icon).toBe(true);
  });

  it('points at the page the build produces', () => {
    const pages = [...xml.matchAll(/__ADDIN_BASE_URL__([\w.-]+\.html)/g)].map((m) => m[1]);
    expect(new Set(pages)).toEqual(new Set(['taskpane.html']));
    expect(existsSync(inAddin('taskpane.html'))).toBe(true);
  });

  it('has a four-part version and a GUID id', () => {
    expect(xml).toMatch(/<Version>\d+\.\d+\.\d+\.\d+<\/Version>/);
    expect(xml).toMatch(/<Id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}<\/Id>/);
  });
});

describe('the two manifests together', () => {
  it('have different ids, so Office treats them as two add-ins', () => {
    const id = (xml: string) => /<Id>(.+)<\/Id>/.exec(xml)?.[1];
    expect(id(office)).not.toBe(id(outlook));
  });

  it('agree on the version', () => {
    const version = (xml: string) => /<Version>(.+)<\/Version>/.exec(xml)?.[1];
    expect(version(office)).toBe(version(outlook));
  });
});

describe('the Word, PowerPoint, and Excel manifest', () => {
  it('is a task pane add-in for those three', () => {
    expect(office).toContain('xsi:type="TaskPaneApp"');
    expect(attributes(office, 'Name').filter((name) => name !== 'Mailbox')).toEqual(['Document', 'Presentation', 'Workbook']);
  });

  it('keeps the elements in schema order', () => {
    expect(topLevelOrder(office)).toEqual([
      'Id',
      'Version',
      'ProviderName',
      'DefaultLocale',
      'DisplayName',
      'Description',
      'IconUrl',
      'HighResolutionIconUrl',
      'SupportUrl',
      'AppDomains',
      'Hosts',
      'DefaultSettings',
      'Permissions',
      'VersionOverrides',
    ]);
  });

  it('adds a ribbon button in each application', () => {
    expect([...office.matchAll(/<Host xsi:type="(\w+)">/g)].map((m) => m[1])).toEqual(['Document', 'Presentation', 'Workbook']);
    expect(office.match(/xsi:type="ShowTaskpane"/g)).toHaveLength(3);
    expect(office.match(/<OfficeTab id="TabHome">/g)).toHaveLength(3);
  });

  it('names no application-specific requirement set, which would hide it from the other two', () => {
    expect(office).not.toContain('<Requirements>');
  });
});

describe('the Outlook manifest', () => {
  it('is a mail add-in for messages being written', () => {
    expect(outlook).toContain('xsi:type="MailApp"');
    expect(outlook).toContain('<Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>');
    expect(outlook).toContain('<Form xsi:type="ItemEdit">');
    expect(outlook).toContain('xsi:type="MessageComposeCommandSurface"');
  });

  it('keeps the elements in schema order', () => {
    expect(topLevelOrder(outlook)).toEqual([
      'Id',
      'Version',
      'ProviderName',
      'DefaultLocale',
      'DisplayName',
      'Description',
      'IconUrl',
      'HighResolutionIconUrl',
      'SupportUrl',
      'AppDomains',
      'Hosts',
      'Requirements',
      'FormSettings',
      'Permissions',
      'Rule',
      'VersionOverrides',
    ]);
  });

  it('can be pinned, which needs the 1.1 overrides and the Mailbox 1.5 set', () => {
    expect(outlook).toMatch(/<Action xsi:type="ShowTaskpane">\s*<SourceLocation resid="Pane.Url"\/>\s*<SupportsPinning>true<\/SupportsPinning>/);
    expect(outlook).toContain('xsi:type="VersionOverridesV1_1"');
    expect(outlook).toContain('<Set Name="Mailbox" MinVersion="1.5"/>');
  });

  it('follows Microsoft\'s published order inside the overrides', () => {
    const inOrder = (xml: string, names: string[]) => {
      const places = names.map((name) => xml.indexOf(name));
      expect(places.every((place) => place !== -1), names.join(' ')).toBe(true);
      expect(places).toEqual([...places].sort((a, b) => a - b));
    };
    const overrides = outlook.slice(outlook.indexOf('xsi:type="VersionOverridesV1_1"'));
    inOrder(overrides, ['<Requirements>', '<Hosts>', '<Resources>']);
    inOrder(overrides, ['<FunctionFile', '<ExtensionPoint', '<OfficeTab']);
    inOrder(overrides, ['<Group', '<Label', '<Control']);
    inOrder(overrides.slice(overrides.indexOf('<Control')), ['<Label', '<Supertip>', '<Icon>', '<Action']);
    inOrder(overrides, ['<bt:Images>', '<bt:Urls>', '<bt:ShortStrings>', '<bt:LongStrings>']);
  });

  it('asks for no more access than writing to the current item', () => {
    expect(outlook).toContain('<Permissions>ReadWriteItem</Permissions>');
  });
});

describe('the page', () => {
  const html = read('taskpane.html');
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  const directive = (name: string) => policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';

  it('loads Office.js from Microsoft, before the app', () => {
    const library = html.indexOf('https://officeapis.public.onecdn.static.microsoft/1/office.js');
    expect(library).toBeGreaterThan(html.indexOf('<head>'));
    expect(library).toBeLessThan(html.indexOf('</head>'));
    expect(library).toBeLessThan(html.indexOf('./main.tsx'));
  });

  it('allows Office.js, the worker, and WebAssembly', () => {
    expect(directive('script-src')).toContain('https://appsforoffice.microsoft.com');
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
    expect(directive('worker-src')).toContain("'self'");
  });

  it('gives the page nowhere to send text', () => {
    expect(policy).toContain("default-src 'none'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });
});
