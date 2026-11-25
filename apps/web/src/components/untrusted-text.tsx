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
    <div className="space-y-2 break-words text-body [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-code [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-input [&_pre]:border [&_pre]:border-line-subtle [&_pre]:bg-sunken [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-code [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown allowedElements={ALLOWED} unwrapDisallowed skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
