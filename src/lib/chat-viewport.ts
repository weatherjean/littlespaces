/** Follow the visible screen above mobile browser chrome and the software keyboard. */
export function chatViewport(node: HTMLElement) {
  const viewport = window.visualViewport;
  const phone = window.matchMedia('(max-width: 700px)');
  let frame = 0;
  function update() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // Keep normal pinch zoom available; don't reflow to the zoomed viewport.
      if (phone.matches && viewport && Math.abs(viewport.scale - 1) < 0.01) {
        node.style.setProperty('--chat-viewport-height', `${viewport.height}px`);
        node.style.setProperty('--chat-viewport-top', `${viewport.offsetTop}px`);
        node.classList.toggle('chat-viewport-short', viewport.height < 500);
      } else {
        node.style.removeProperty('--chat-viewport-height');
        node.style.removeProperty('--chat-viewport-top');
        node.classList.remove('chat-viewport-short');
      }
    });
  }
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  phone.addEventListener('change', update);
  update();
  return {
    destroy() {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      phone.removeEventListener('change', update);
      node.style.removeProperty('--chat-viewport-height');
      node.style.removeProperty('--chat-viewport-top');
      node.classList.remove('chat-viewport-short');
    },
  };
}
