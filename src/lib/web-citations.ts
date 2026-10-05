/** Keep links as text in storage; render only safe HTTP(S) links, never model HTML. */
export function messageParts(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  const links = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    parts.push({ text: text.slice(offset, match.index) });
    try {
      const url = new URL(match[2]);
      if (url.username || url.password) throw Error('Invalid link');
      parts.push({ text: match[1], url: url.href });
    } catch {
      parts.push({ text: match[0] });
    }
    offset = match.index! + match[0].length;
  }
  parts.push({ text: text.slice(offset) });
  return parts;
}

export function speechText(text: string): string {
  return messageParts(text)
    .map((part) => (part.url ? '' : part.text))
    .join('')
    .replace(/cite[^]*/g, '')
    .trim();
}

/** Convert provider citation markers inside the JSON reply into durable links. */
export function citeWebReply(message: string, output: Record<string, unknown>[]): string {
  const added = new Set<string>();
  const remaining: string[] = [];
  for (const item of output) {
    if (item.type !== 'message' || (item.phase && item.phase !== 'final_answer')) continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (
        part.type !== 'output_text' ||
        typeof part.text !== 'string' ||
        !Array.isArray(part.annotations)
      )
        continue;
      for (const citation of part.annotations) {
        if (citation.type !== 'url_citation' || typeof citation.url !== 'string') continue;
        let url: URL;
        try {
          url = new URL(citation.url);
        } catch {
          continue;
        }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        const href = url.href.replaceAll('(', '%28').replaceAll(')', '%29');
        const title = String(citation.title || url.hostname)
          .replace(/[\[\]\r\n]/g, ' ')
          .slice(0, 180);
        const link = `[${title}](${href})`;
        const start = citation.start_index,
          end = citation.end_index;
        const span =
          Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
            ? part.text.slice(start, end)
            : '';
        const markers = span.match(/cite[^]*/g) || [];
        let placed = false;
        for (const marker of markers) {
          if (message.includes(marker)) {
            message = message.replace(marker, link);
            placed = true;
          }
        }
        if (!placed && !added.has(href) && !message.includes(href)) remaining.push(link);
        added.add(href);
      }
    }
  }
  message = message.replace(/cite[^]*/g, '');
  return remaining.length ? `${message}\n\nSources: ${remaining.join(' · ')}` : message;
}
