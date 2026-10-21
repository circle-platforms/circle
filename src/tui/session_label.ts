// A shared title gets the start of the first reply, or the short id when that
// reply is shared too. The recent list and /resume use the same line, including
// a row that search left on its own.

export function shortSessionId(id: string): string {
  return id.startsWith('circle-') ? id.slice('circle-'.length) : id.slice(-8);
}

/** A reply preview with markdown marks removed, so `**title**` is not the hint. */
export function plainPreview(text: string, limit = 18): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  return plain.length <= limit ? plain : `${plain.slice(0, limit).trimEnd()}…`;
}

function replySnippet(
  store: {
    messages(id: string): {
      role: string;
      content?: string;
      display?: string;
      internal?: string;
    }[];
  },
  id: string,
): string {
  try {
    const reply = store
      .messages(id)
      .find(
        (message) =>
          message.role === 'assistant' &&
          !message.internal &&
          (message.display || message.content),
      );
    return plainPreview(reply?.display || reply?.content || '');
  } catch {
    return '';
  }
}

export function sessionRowLabel(
  session: { id: string; title: string },
  sessions: { id: string; title: string }[],
  store: {
    messages(id: string): {
      role: string;
      content?: string;
      display?: string;
      internal?: string;
    }[];
  },
): string {
  const title = session.title || '(untitled)';
  const duplicates = sessions.filter(
    (item) => (item.title || '(untitled)') === title,
  );
  if (duplicates.length < 2) return title;
  const hint = (item: { id: string }): string => {
    const snippet = replySnippet(store, item.id);
    return snippet
      ? `${title} · ${snippet}`
      : `${title} · ${shortSessionId(item.id)}`;
  };
  const mine = hint(session);
  const shared = duplicates.filter((item) => hint(item) === mine).length;
  if (shared < 2) return mine;
  return `${title} · ${shortSessionId(session.id)}`;
}
