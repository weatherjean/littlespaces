const cards = document.querySelector('.cards');
function reset() {
  cards.classList.remove('focused');
  document.querySelectorAll('.card').forEach((card) => card.classList.remove('expanded'));
  document.querySelectorAll('.focus').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = 'Explore direction <span aria-hidden="true">＋</span>';
  });
}
document.querySelectorAll('.focus').forEach((button) =>
  button.addEventListener('click', () => {
    const active = button.getAttribute('aria-pressed') === 'true';
    reset();
    if (!active) {
      const card = document.getElementById(button.dataset.card);
      cards.classList.add('focused');
      card.classList.add('expanded');
      button.setAttribute('aria-pressed', 'true');
      button.innerHTML = 'Back to all five <span aria-hidden="true">−</span>';
      card.scrollIntoView({ block: 'start' });
    }
  }),
);
document.querySelectorAll('.jump a').forEach((link) => link.addEventListener('click', reset));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') reset();
});

const previewColors = {
  pink: ['Pink', '#F5CBE0', '#E7AFCE'],
  sage: ['Sage', '#DCE7CB', '#C5D6AF'],
  sky: ['Sky', '#CEDFF4', '#B3CDEB'],
  butter: ['Butter', '#F4E4AF', '#E4CE87'],
  lilac: ['Lilac', '#DDD3F1', '#C6B4E5'],
  chalk: ['Chalk', '#EAE7E1', '#D8D2C8'],
};
document.querySelectorAll('.theme-choice').forEach((button) => {
  button.addEventListener('click', () => {
    const [name, paper, soft] = previewColors[button.dataset.theme];
    const card = document.getElementById('emoji');
    card.style.setProperty('--paper', paper);
    card.style.setProperty('--soft', soft);
    card.querySelector('.theme-current strong').textContent = name;
    card
      .querySelectorAll('.theme-choice')
      .forEach((choice) => choice.setAttribute('aria-pressed', String(choice === button)));
  });
});
