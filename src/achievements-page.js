'use strict';

// The Achievements page (src/achievements.js): every achievement by stage, the
// player's unlocks, and each new one marked as the game announces it.
(() => {
  // Game order; the list's own stages come after any not named here.
  const STAGE_ORDER = ['Delfino Airstrip', 'Delfino Plaza', 'Bianco Hills', 'Ricco Harbor', 'Gelato Beach', 'Pinna Park',
    'Sirena Beach', 'Noki Bay', 'Pianta Village', 'Corona Mountain', 'Anywhere'];
  let state = { supported: false, achievements: [], unlocked: 0, total: 0 };
  let icons = {}, iconsLoaded = false, filter = 'all', loadedFor = null;
  const fresh = new Set();

  const date = time => new Date(time * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function groups() {
    const byStage = new Map();
    for (const item of state.achievements) {
      if (!byStage.has(item.stage)) byStage.set(item.stage, []);
      byStage.get(item.stage).push(item);
    }
    const rank = stage => { const at = STAGE_ORDER.indexOf(stage); return at < 0 ? STAGE_ORDER.length : at; };
    return [...byStage].sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  function card(item) {
    const element = document.createElement('article');
    element.className = `achievement${item.unlockedAt ? '' : ' locked'}${fresh.has(item.id) ? ' fresh' : ''}`;
    element.dataset.id = item.id;
    const icon = icons[item.id] ? document.createElement('img') : document.createElement('span');
    if (icons[item.id]) { icon.src = icons[item.id]; icon.alt = ''; } else icon.className = 'achievement-no-icon';
    const text = document.createElement('div');
    text.className = 'achievement-text';
    const title = document.createElement('strong'); title.textContent = item.title;
    const description = document.createElement('p'); description.textContent = item.description;
    const when = document.createElement('small');
    when.textContent = item.unlockedAt ? `Unlocked ${date(item.unlockedAt)}` : 'Locked';
    text.append(title, description, when);
    element.append(icon, text);
    return element;
  }

  function render() {
    const { achievements, unlocked, total } = state;
    $('achievements-count').textContent = `${unlocked} of ${total} unlocked`;
    $('achievements-percent').textContent = `${total ? Math.floor(unlocked * 100 / total) : 0}%`;
    $('achievements-ring').style.setProperty('--done', total ? String(unlocked / total) : '0');
    const latest = achievements.filter(item => item.unlockedAt).sort((a, b) => b.unlockedAt - a.unlockedAt)[0];
    $('achievements-latest').textContent = latest ? `Latest: ${latest.title}` : 'None unlocked yet';
    for (const button of document.querySelectorAll('[data-achievement-filter]')) {
      const on = button.dataset.achievementFilter === filter;
      button.classList.toggle('active', on);
      button.setAttribute('aria-checked', String(on));
    }

    const container = $('achievement-groups'), stages = $('achievement-stages');
    container.replaceChildren();
    stages.replaceChildren();
    for (const [stage, items] of groups()) {
      const done = items.filter(item => item.unlockedAt).length;
      const shown = items.filter(item => filter === 'all' || (filter === 'unlocked') === Boolean(item.unlockedAt));
      const jump = document.createElement('button');
      jump.className = done === items.length ? 'complete' : '';
      jump.textContent = stage;
      const count = document.createElement('small'); count.textContent = `${done}/${items.length}`;
      jump.append(count);
      jump.disabled = !shown.length;
      stages.append(jump);
      if (!shown.length) continue;
      const group = document.createElement('section');
      group.className = 'achievement-group';
      const head = document.createElement('div');
      head.className = 'achievement-group-head';
      const name = document.createElement('h2'); name.textContent = stage;
      const tally = document.createElement('span'); tally.textContent = `${done} of ${items.length}`;
      const bar = document.createElement('i'), fill = document.createElement('b');
      fill.style.width = `${done * 100 / items.length}%`;
      bar.append(fill);
      head.append(name, tally, bar);
      const grid = document.createElement('div');
      grid.className = 'achievement-grid';
      // Unlocked first, newest first; the rest in the list's order.
      const sorted = [...shown].sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0) || a.id - b.id);
      grid.append(...sorted.map(card));
      group.append(head, grid);
      container.append(group);
      jump.addEventListener('click', () => group.scrollIntoView({ block: 'start' }));
    }
    const empty = $('achievements-empty');
    empty.hidden = Boolean(container.childElementCount);
    empty.textContent = filter === 'unlocked' ? 'Nothing unlocked yet. Play to earn your first achievement.'
      : 'Every achievement is unlocked. Nice work!';
  }

  async function load() {
    try { state = await window.sms.achievements(); } catch (_) { return; }
    $('nav-achievements').hidden = !state.supported;
    if (!state.supported && page === 'achievements') showPage('play');
    if (state.supported && !iconsLoaded) {
      iconsLoaded = true;
      try { icons = await window.sms.achievementIcons(); } catch (_) { icons = {}; }
    }
    if (page === 'achievements') render();
  }

  for (const button of document.querySelectorAll('[data-achievement-filter]')) button.addEventListener('click', () => {
    filter = button.dataset.achievementFilter;
    render();
  });
  onPage('achievements', { show: () => { render(); load(); }, hide: () => fresh.clear() });

  // The game folder or Eclipse switch decides the list.
  window.smsAchievementsRefresh = data => {
    const key = `${data.config.repo}|${Boolean(data.config.settings.eclipse)}`;
    if (key === loadedFor) return;
    loadedFor = key;
    iconsLoaded = false;
    load();
  };
  // null: the icons were (re)installed.
  window.sms.onAchievement(unlock => {
    if (!unlock) iconsLoaded = false;
    else fresh.add(unlock.id);
    load();
  });
})();
