import { useEffect, useRef, useState } from 'preact/hooks';
const merge = (older, newer, key) => {
  const replacements = new Map(newer.map((item) => [item[key], item]));
  const result = older.map((item) => replacements.get(item[key]) || item);
  const known = new Set(older.map((item) => item[key]));
  return [...result, ...newer.filter((item) => !known.has(item[key]))];
};
export function useHistory(
  api,
  setMessages,
  setConversations,
  conversationRef,
  setError,
  authenticated,
) {
  const cache = useRef(new Map());
  const chats = useRef(null);
  const [messageCursor, setMessageCursor] = useState(null);
  const [conversationCursor, setConversationCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!authenticated) {
      cache.current.clear();
      chats.current = null;
      setMessageCursor(null);
      setConversationCursor(null);
    }
  }, [authenticated]);
  async function read(id) {
    const page = await api(`/api/conversations/${id}?page=true`);
    const previous = cache.current.get(id);
    const saved = {
      items: merge(previous?.items || [], page.items, 'messageId'),
      nextCursor: previous ? previous.nextCursor : page.nextCursor,
    };
    cache.current.set(id, saved);
    while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value);
    if (conversationRef.current === id) setMessageCursor(saved.nextCursor);
    return saved.items;
  }
  async function list() {
    const page = await api('/api/conversations?page=true');
    chats.current = {
      items: merge(page.items, chats.current?.items || [], 'id').map(
        (item) => page.items.find((v) => v.id === item.id) || item,
      ),
      nextCursor: chats.current ? chats.current.nextCursor : page.nextCursor,
    };
    setConversationCursor(chats.current.nextCursor);
    return chats.current.items;
  }
  async function olderMessages() {
    if (busy) return;
    const id = conversationRef.current;
    const saved = cache.current.get(id);
    if (!saved?.nextCursor) return;
    setBusy(true);
    try {
      const page = await api(`/api/conversations/${id}?page=true&before=${saved.nextCursor}`);
      const latest = cache.current.get(id);
      const value = {
        items: merge(page.items, latest.items, 'messageId'),
        nextCursor: page.nextCursor,
      };
      cache.current.set(id, value);
      if (conversationRef.current === id) {
        setMessages(value.items);
        setMessageCursor(value.nextCursor);
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function olderConversations() {
    if (busy || !chats.current?.nextCursor) return;
    setBusy(true);
    try {
      const page = await api(`/api/conversations?page=true&before=${chats.current.nextCursor}`);
      chats.current = {
        items: merge(chats.current.items, page.items, 'id'),
        nextCursor: page.nextCursor,
      };
      setConversations(chats.current.items);
      setConversationCursor(page.nextCursor);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return { read, list, olderMessages, olderConversations, messageCursor, conversationCursor, busy };
}
