'use strict';

(() => {
  const listEl = document.getElementById('list');
  const statusEl = document.getElementById('status');
  const bannerEl = document.getElementById('banner');
  const toastEl = document.getElementById('toast');
  const closeBtn = document.getElementById('btn-close');

  let items = [];
  let total = 0;
  let warnings = [];
  let toastTimer = null;

  if (!window.api) {
    document.body.textContent = '界面初始化失败：预加载脚本未就绪。';
    return;
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 1500);
  }

  function formatTime(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;

    const date = new Date(timestamp);
    const now = new Date();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');

    if (date.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hh}:${mm}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
  }

  function createCard(item) {
    const card = document.createElement('div');
    card.className = `card${item.type === 'image' ? ' image' : ''}${item.pinned ? ' pinned' : ''}`;

    if (item.type === 'text') {
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = item.previewText;
      card.appendChild(preview);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      if (item.thumbDataUrl) {
        const img = document.createElement('img');
        img.src = item.thumbDataUrl;
        img.alt = '图片记录';
        img.draggable = false;
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
    const time = document.createElement('span');
    time.textContent = `${item.pinned ? '置顶 · ' : ''}${formatTime(item.createdAt)}`;
    const detail = document.createElement('span');
    detail.textContent =
      item.type === 'text' ? `${item.chars} 字` : `${item.image.width}×${item.image.height}`;
    meta.append(time, detail);
    card.appendChild(meta);

    card.addEventListener('click', async () => {
      try {
        const result = await window.api.copyItem(item.id);
        if (result && result.ok) {
          showToast('已复制');
        } else {
          showToast((result && result.error) || '复制失败，请重试');
        }
      } catch {
        showToast('复制失败，请重试');
      }
    });

    return card;
  }

  function render() {
    const scrollTop = listEl.scrollTop;
    listEl.textContent = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = '📋';
      const text = document.createElement('div');
      text.textContent = '还没有记录，复制点什么试试';
      empty.append(icon, text);
      listEl.appendChild(empty);
    } else {
      for (const item of items) {
        listEl.appendChild(createCard(item));
      }
    }

    listEl.scrollTop = scrollTop;
  }

  function renderBanner() {
    if (warnings.length > 0) {
      bannerEl.textContent = warnings[0];
      bannerEl.classList.remove('hidden');
    } else {
      bannerEl.textContent = '';
      bannerEl.classList.add('hidden');
    }
  }

  async function loadItems() {
    try {
      const result = await window.api.queryItems({ offset: 0, limit: 100 });
      items = Array.isArray(result.items) ? result.items : [];
      total = result.total || 0;
      render();
    } catch {
      showToast('加载历史记录失败');
    }
  }

  async function refreshStatus() {
    try {
      const status = await window.api.getStatus();
      statusEl.textContent = '';
      statusEl.title = `数据目录：${status.dataDir}`;
      warnings = Array.isArray(status.warnings) ? status.warnings : [];
      renderBanner();

      const parts = [
        ['已保存', `${status.stored ? status.stored.total : 0} 条`],
        ['CPU', `${status.cpuPercent}%`],
        ['内存', `${status.memoryMB} MB`],
        ['本次文字', String(status.stats.texts)],
        ['本次图片', String(status.stats.images)],
        ['文件跳过', String(status.stats.skippedFiles)],
        ['格式', status.lastTypes && status.lastTypes.length ? status.lastTypes.join(', ') : '空'],
      ];

      for (const [label, value] of parts) {
        const span = document.createElement('span');
        span.className = 'item';
        span.append(`${label} `);
        const strong = document.createElement('b');
        strong.textContent = value;
        span.appendChild(strong);
        statusEl.appendChild(span);
      }
    } catch {
      // 状态读取失败时保持上一次显示
    }
  }

  closeBtn.addEventListener('click', () => window.api.hideWindow());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.api.hideWindow();
  });

  window.api.onItemsChanged(() => {
    loadItems();
  });
  window.api.onError((payload) => {
    if (payload && payload.message) showToast(payload.message);
  });

  loadItems();
  refreshStatus();
  setInterval(refreshStatus, 2000);
  setInterval(render, 30000);
})();
