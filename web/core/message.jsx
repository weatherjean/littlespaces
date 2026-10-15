import { h, Fragment } from 'preact';
import { marked } from 'marked';

// Parse Markdown, then create only trusted Preact elements; never insert model HTML.
function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function plain(text = '') {
  return text.replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, (entity) => {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = entity;
    return decoder.value;
  });
}
function tokens(nodes = []) {
  return nodes.map((t) => {
    const children = () => tokens(t.tokens);
    switch (t.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        return h(`h${t.depth}`, {}, children());
      case 'paragraph':
        return <p>{children()}</p>;
      case 'text':
        return t.tokens ? children() : plain(t.text);
      case 'escape':
        return plain(t.text);
      case 'html':
        return t.raw;
      case 'strong':
        return <strong>{children()}</strong>;
      case 'em':
        return <em>{children()}</em>;
      case 'del':
        return <del>{children()}</del>;
      case 'codespan':
        return <code>{t.text}</code>;
      case 'code':
        return (
          <pre>
            <code>{t.text}</code>
          </pre>
        );
      case 'br':
        return <br />;
      case 'hr':
        return <hr />;
      case 'blockquote':
        return <blockquote>{children()}</blockquote>;
      case 'link': {
        const href = safeLink(plain(t.href));
        return href ? (
          <a href={href} title={t.title} target="_blank" rel="noopener noreferrer">
            {children()}
          </a>
        ) : (
          children()
        );
      }
      // Remote images are links, so reading a reply doesn't load external tracking assets.
      case 'image': {
        const href = safeLink(plain(t.href));
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {plain(t.text) || 'View image'}
          </a>
        ) : (
          plain(t.text)
        );
      }
      case 'list':
        return h(
          t.ordered ? 'ol' : 'ul',
          t.ordered ? { start: t.start } : {},
          t.items.map((item) => (
            <li>
              {item.task && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled
                  aria-label={item.checked ? 'Completed task' : 'Incomplete task'}
                />
              )}
              {tokens(item.tokens)}
            </li>
          )),
        );
      case 'table':
        return (
          <div class="markdown-table" tabIndex="0" role="region" aria-label="Table">
            <table>
              <thead>
                <tr>
                  {t.header.map((cell, i) => (
                    <th style={{ textAlign: t.align[i] }}>{tokens(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((row) => (
                  <tr>
                    {row.map((cell, i) => (
                      <td style={{ textAlign: t.align[i] }}>{tokens(cell.tokens)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return t.text || t.raw || '';
    }
  });
}
export function MessageText({ text = '' }) {
  return (
    <div class="markdown-content">{tokens(marked.lexer(text, { gfm: true, breaks: true }))}</div>
  );
}
