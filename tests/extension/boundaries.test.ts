// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { READ_OPTIONS } from '../../src/extension/content/boundaries';
import { applyEdits, readBlocks } from '@shared/html-text';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const authored = (html: string) =>
  readBlocks(parse(html).body, READ_OPTIONS)
    .map((block) => block.text)
    .join(' / ');

describe('the writer\'s own text', () => {
  it('reads a new message with no markers in full', () => {
    expect(authored('<div>Hello wrold.</div><div>Second line.</div>')).toBe('Hello wrold. / Second line.');
  });

  it('stops at an Outlook on the web reply', () => {
    const html =
      '<div>My reply.</div><div id="Signature"><p>Steve</p></div><div id="appendonsend"></div><hr>' +
      '<div id="divRplyFwdMsg"><b>From:</b> A</div><div>Old text.</div>';
    expect(authored(html)).toBe('My reply.');
  });

  it('stops at the reply header when appendonsend is missing', () => {
    const html = '<div>My reply.</div><hr tabindex="-1"><div id="divRplyFwdMsg"><b>From:</b> A</div><div>Old.</div>';
    expect(authored(html)).toBe('My reply.');
  });

  it('stops at a separator nested below the reply, as Word writes it', () => {
    const html =
      '<div class="WordSection1"><p class="MsoNormal">My reply.<o:p></o:p></p>' +
      '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">' +
      '<p class="MsoNormal"><b>From:</b> A</p></div></div><p>Old.</p></div>';
    expect(authored(html)).toBe('My reply.');
  });

  it('stops at Word\'s bookmark before a quote', () => {
    expect(authored('<p class="MsoNormal">My reply.</p><a name="_MailOriginal"></a><p>Old.</p>')).toBe('My reply.');
  });

  it('stops at Gmail\'s quoted thread', () => {
    const html =
      '<div>My reply.</div><div class="gmail_quote gmail_quote_container">' +
      '<div class="gmail_attr">On Monday, A wrote:</div><blockquote class="gmail_quote">Old.</blockquote></div>';
    expect(authored(html)).toBe('My reply.');
  });

  it('stops at the older Gmail wrapper and at other mailers\' quotes', () => {
    expect(authored('<div>Mine.</div><div class="gmail_extra">Old.</div>')).toBe('Mine.');
    expect(authored('<div>Mine.</div><blockquote type="cite">Old.</blockquote>')).toBe('Mine.');
    expect(authored('<div>Mine.</div><div class="yahoo_quoted">Old.</div>')).toBe('Mine.');
    expect(authored('<div>Mine.</div><div class="moz-cite-prefix">On Monday:</div><p>Old.</p>')).toBe('Mine.');
  });

  it('leaves out a signature but keeps text after it', () => {
    expect(authored('<p>Body text.</p><div id="Signature">Steve</div><p>PS line.</p>')).toBe('Body text. / PS line.');
  });

  it('leaves out a Gmail signature, its dashes, and the wrapper Gmail tags it with', () => {
    const html =
      '<div>Body text.</div><span class="gmail_signature_prefix">-- </span><br>' +
      '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div>Steve</div></div>';
    expect(authored(html)).toBe('Body text.');
    expect(authored('<div>Body.</div><div data-smartmail="gmail_signature">Steve</div>')).toBe('Body.');
  });

  it('keeps reading after a quote made with Gmail\'s Quote button', () => {
    const html = '<div>Before.</div><blockquote class="gmail_quote">A quote.</blockquote><div>After.</div>';
    expect(authored(html)).toBe('Before. / After.');
  });

  it('leaves out islands that cannot be edited', () => {
    expect(authored('<div>Hello <span contenteditable="false">@Sam Smith</span> there.</div>')).toBe('Hello there.');
  });

  it('does not stop at ids and classes that merely look similar', () => {
    expect(authored('<div class="gmail_quoted">One.</div><div id="SignatureBox">Two.</div>')).toBe('One. / Two.');
  });
});

describe('editing above the boundary', () => {
  it('leaves the quoted thread and inline images exactly as they were', () => {
    const doc = parse(
      '<div>Teh <b>report</b> is here.</div><div id="appendonsend"></div><hr>' +
        '<div id="divRplyFwdMsg">From: A</div><div>Teh old text <img src="cid:image001.png@01DC"></div>',
    );
    const [block] = readBlocks(doc.body, READ_OPTIONS);
    expect(applyEdits(block, [{ from: 0, to: 3, text: 'The' }])).toBe(true);
    const html = doc.body.innerHTML;
    expect(html.startsWith('<div>The <b>report</b>')).toBe(true);
    expect(html).toContain('Teh old text');
    expect(html).toContain('src="cid:image001.png@01DC"');
  });
});
