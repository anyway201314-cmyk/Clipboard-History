'use strict';

(() => {
  const ICONS = {
    pin:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 17v5"/><path d="M9 4h6l-1 5 4 4H6l4-4-1-5z"/></svg>',
    trash:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
    clipboard:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.5h6V4"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>',
  };

  const listEl = document.getElementById('list');
  const searchInput = document.getElementById('search');
  const searchClear = document.getElementById('search-clear');
  const bannerEl = document.getElementById('banner');
  const toastEl = document.getElementById('toast');
  const closeBtn = document.getElementById('btn-close');

  if (!window.api) {
    document.body.textContent = '界面初始化失败：预加载脚本未就绪。';
    return;
  }

  const state = {
    items: [],
    total: 0,
    query: '',
    loading: false,
    loadSeq: 0,
    composing: false,
    searchTimer: null,
    changeTimer: null,
  };
  let toastTimer = null;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 1500);
  }

  function showBanner(text) {
    if (!text) return;
    bannerEl.textContent = text;
    bannerEl.classList.remove('hidden');
  }

  function formatTime(timestamp) {
    if (window.TimeUtils && typeof window.TimeUtils.formatRelativeTime === 'function') {
      return window.TimeUtils.formatRelativeTime(timestamp);
    }
    return '';
  }

  function updateClearButton() {
    searchClear.classList.toggle('hidden', searchInput.value.length === 0);
  }

  function createActionButton(svg, label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action-btn${className ? ` ${className}` : ''}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = svg;
    return button;
  }

  async function copyItem(item) {
    try {
      const result = await window.api.copyItem(item.id);
      if (result && result.ok) showToast('已复制');
      else showToast((result && result.error) || '复制失败，请重试');
    } catch {
      showToast('复制失败，请重试');
    }
  }

  function createCard(item) {
    const card = document.createElement('div');
    card.className = `card${item.type === 'image' ? ' image' : ''}${item.pinned ? ' pinned' : ''}`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', item.type === 'text' ? '文字记录，点击复制' : '图片记录，点击复制');

    if (item.type === 'text') {
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = item.previewText;
      card.appendChild(preview);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      if (item.thumbUrl) {
        const img = document.createElement('img');
        img.alt = '图片记录';
        img.draggable = false;
        img.addEventListener('error', () => {
          wrap.textContent = '';
          const missing = document.createElement('div');
          missing.className = 'thumb-missing';
          missing.textContent = '图片缩略图不可用';
          wrap.appendChild(missing);
        });
        img.src = item.thumbUrl;
        wrap.appendChild(img);
      } else {
        const missing = document.createElement('div');
        missing.className = 'thumb-missing';
        missing.textContent = '图片缩略图不可用';
        wrap.appendChild(missing);
      }
      card.appendChild(wrap);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';

    const metaLeft = document.createElement('span');
    metaLeft.className = 'meta-left';
    if (item.pinned) {
      const flag = document.createElement('span');
      flag.className = 'pin-flag';
      flag.innerHTML = ICONS.pin;
      metaLeft.appendChild(flag);
    }
    const detail = item.type === 'text' ? `${item.chars} 字` : `${item.image.width}×${item.image.height}`;
    const timeText = document.createElement('span');
    timeText.textContent = `${formatTime(item.createdAt)} · ${detail}`;
    metaLeft.appendChild(timeText);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const pinButton = createActionButton(ICONS.pin, item.pinned ? '取消置顶' : '置顶', item.pinned ? 'active' : '');
    pinButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        const result = await window.api.pinItem(item.id, !item.pinned);
        if (result && result.ok) showToast(item.pinned ? '已取消置顶' : '已置顶');
        else showToast((result && result.error) || '操作失败');
      } catch {
        showToast('操作失败');
      }
    });

    const deleteButton = createActionButton(ICONS.trash, '删除', 'danger');
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        const result = await window.api.removeItem(item.id);
        if (result && result.cancelled) return;
        if (result && result.removed) showToast('已删除');
        else if (result && result.error) showToast(result.error);
      } catch {
        showToast('删除失败，请重试');
      }
    });

    actions.append(pinButton, deleteButton);
    meta.append(metaLeft, actions);
    card.appendChild(meta);

    card.addEventListener('click', () => copyItem(item));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        copyItem(item);
      }
    });

    return card;
  }

  function appendSection(title, sectionItems, withPinIcon) {
    const header = document.createElement('div');
    header.className = 'section-title';
    if (withPinIcon) {
      const icon = document.createElement('span');
      icon.className = 'section-pin';
      icon.innerHTML = ICONS.pin;
      header.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = title;
    header.appendChild(label);
    listEl.appendChild(header);

    for (const item of sectionItems) {
      listEl.appendChild(createCard(item));
    }
  }

  function renderEmpty() {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.innerHTML = ICONS.clipboard;
    const hint = document.createElement('div');
    hint.textContent = state.query ? '没有找到相关内容' : '还没有记录，复制点什么试试';
    empty.append(icon, hint);
    listEl.appendChild(empty);
  }

  function render({ keepScroll = true } = {}) {
    const scrollTop = listEl.scrollTop;
    listEl.textContent = '';

    if (state.total === 0) {
      renderEmpty();
      listEl.scrollTop = 0;
      return;
    }

    const pinnedItems = state.items.filter((item) => item.pinned);
    const normalItems = state.items.filter((item) => !item.pinned);

    if (pinnedItems.length > 0) appendSection('置顶', pinnedItems, true);
    if (normalItems.length > 0) appendSection(state.query ? '搜索结果' : '全部记录', normalItems, false);

    if (keepScroll) listEl.scrollTop = scrollTop;
  }

  async function load({ reset = false, limitOverride = null, toTop = false } = {}) {
    const seq = ++state.loadSeq;
    const offset = reset ? 0 : state.items.length;
    const limit = limitOverride || 100;
    state.loading = true;

    try {
      const result = await window.api.queryItems({ search: state.query, offset, limit });
      if (seq !== state.loadSeq) return;

      state.items = reset ? result.items : state.items.concat(result.items);
      state.total = result.total;
      render({ keepScroll: !reset });
      if (toTop) listEl.scrollTop = 0;
      setTimeout(maybeLoadMore, 0);
    } catch {
      if (seq === state.loadSeq) showToast('加载历史记录失败');
    } finally {
      if (seq === state.loadSeq) state.loading = false;
    }
  }

  function maybeLoadMore() {
    if (state.loading) return;
    if (state.items.length >= state.total) return;
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 160;
    if (nearBottom) load({ reset: false });
  }

  function scheduleSearch() {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(applySearch, 200);
  }

  function applySearch() {
    state.searchTimer = null;
    state.query = searchInput.value.trim();
    load({ reset: true, toTop: true });
  }

  function clearSearch() {
    searchInput.value = '';
    updateClearButton();
    state.query = '';
    load({ reset: true, toTop: true });
  }

  function scheduleRefresh() {
    if (state.changeTimer) clearTimeout(state.changeTimer);
    state.changeTimer = setTimeout(() => {
      state.changeTimer = null;
      const limit = Math.min(Math.max(state.items.length, 100), 200);
      load({ reset: true, limitOverride: limit });
    }, 120);
  }

  async function initWarnings() {
    try {
      const status = await window.api.getStatus();
      if (status && Array.isArray(status.warnings)) {
        for (const warning of status.warnings) {
          if (warning) {
            showBanner(warning);
            break;
          }
        }
      }
    } catch {
      // 状态读取失败时忽略
    }
  }

  closeBtn.addEventListener('click', () => window.api.hideWindow());

  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      if (searchInput.value.length > 0) {
        clearSearch();
        searchInput.focus();
      } else {
        window.api.hideWindow();
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  searchInput.addEventListener('input', () => {
    updateClearButton();
    if (state.composing) return;
    scheduleSearch();
  });
  searchInput.addEventListener('compositionstart', () => {
    state.composing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    state.composing = false;
    updateClearButton();
    scheduleSearch();
  });
  searchClear.addEventListener('click', () => {
    clearSearch();
    searchInput.focus();
  });

  listEl.addEventListener('scroll', maybeLoadMore);

  window.api.onItemsChanged(scheduleRefresh);
  window.api.onError((payload) => {
    if (payload && payload.message) {
      showToast(payload.message);
      showBanner(payload.message);
    }
  });

  updateClearButton();
  load({ reset: true, toTop: true });
  initWarnings();
  setInterval(() => render({ keepScroll: true }), 30000);
})();
