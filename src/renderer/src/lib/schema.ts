/**
 * The document model without an editor view, so that imports and exports read
 * and write documents exactly as the editor does.
 */
import { generateHTML, generateJSON, getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

export const documentExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } },
  }),
];

export const documentSchema = getSchema(documentExtensions);

/** Parse HTML into a document. Anything the schema has no place for, such as scripts, is left out. */
export const parseHtml = (html: string): JSONContent => generateJSON(html, documentExtensions);

/** Render a document as plain semantic HTML. */
export const renderHtml = (content: JSONContent): string => generateHTML(content, documentExtensions);
