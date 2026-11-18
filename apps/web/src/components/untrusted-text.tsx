'use client';

import Markdown from 'react-markdown';

// Text that came from outside this system's code: incident descriptions,
// model notes, statements of operators, names and parameters recorded in the
// source. It is DATA. It is rendered as text — React escapes it — or as a
// small subset of Markdown: no raw HTML (react-markdown does not render it
// unless a plugin is added, and none is), no images, no links, no scripts.

const ALLOWED = ['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'br'];

export function UntrustedText({ text }: { readonly text: string }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

export function UntrustedMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="space-y-1 break-words text-sm [&_code]:rounded [&_code]:bg-stone-100 [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown allowedElements={ALLOWED} unwrapDisallowed skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
