<script lang="ts">
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
    image: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M16 7h.01',
    camera: 'M4 6h4l2-3h4l2 3h4v15H4zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    chevron: 'm6 9 6 6 6-6',
    back: 'm12 5-7 7 7 7M5 12h15',
    settings:
      'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    book: 'M12 5v16M12 5C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-2-1-6-2-10 1Z',
    plus: 'M12 5v14M5 12h14',
    reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    send: 'm5 12 7-7 7 7M12 5v14',
    mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    leaf: 'M20 4C9 2 2 7 5 15s17 6 15-11ZM5 20 15 10',
    chat: 'M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4ZM8 10h8M8 14h5',
    history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
    stop: 'M6 6h12v12H6z',
    close: 'm6 6 12 12M6 18 18 6',
    check: 'm5 12 4 4L19 6',
    spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] || paths.grid} /></svg
>
