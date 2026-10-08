import { h, Fragment } from 'preact';
// Ported from the TypeScript messageParts/MessageText renderer. Never render model HTML.
export function MessageText({ text = '' }) {
  const parts = [],
    links = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(links)) {
    parts.push(text.slice(offset, match.index));
    try {
      const url = new URL(match[2]);
      if (url.username || url.password) throw Error('Invalid link');
      parts.push(
        <a href={url.href} target="_blank" rel="noopener noreferrer">
          {match[1]}
        </a>,
      );
    } catch {
      parts.push(match[0]);
    }
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
