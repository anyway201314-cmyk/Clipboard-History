'use strict';

// 阶段 3 界面自动化检查（开发用，需以 --remote-debugging-port=9222 启动应用）。
// 通过 Chrome DevTools Protocol 调用窗口内的 API 并读取 DOM，验证：
// 置顶、搜索过滤（中文/图片隐藏）、清空搜索、缩略图协议、删除联动。
// 结果以 JSON 输出到终端。

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function findPageTarget() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/list');
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && /index\.html/.test(target.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      // 继续重试
    }
    await sleep(200);
  }
  throw new Error('未找到可调试页面（请确认应用以 --remote-debugging-port=9222 启动）');
}

class CDP {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const handlers = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) handlers.reject(new Error(message.error.message));
        else handlers.resolve(message.result);
      }
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception && details.exception.description ? details.exception.description : '页面表达式执行失败');
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    this.socket.close();
  }
}

(async () => {
  const target = await findPageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();

  const output = {};
  output.initial = await cdp.evaluate(
    `({ cards: document.querySelectorAll('.card').length, title: document.title })`
  );
  output.items = await cdp.evaluate(`window.api.queryItems({ offset: 0, limit: 20 })`);

  const items = (output.items && output.items.items) || [];
  const pinTarget = items.find((item) => item.type === 'text' && !item.pinned);
  if (!pinTarget) throw new Error('没有可置顶的文字条目');

  output.pin = await cdp.evaluate(`window.api.pinItem(${JSON.stringify(pinTarget.id)}, true)`);
  await sleep(500);
  output.afterPin = await cdp.evaluate(
    `({ cards: document.querySelectorAll('.card').length, pinnedCards: document.querySelectorAll('.card.pinned').length, sections: [...document.querySelectorAll('.section-title')].map((el) => el.textContent.trim()) })`
  );

  output.theme = await cdp.evaluate(
    `(() => { const style = getComputedStyle(document.body); return { background: style.backgroundColor, color: style.color }; })()`
  );
  output.searchToggle = await cdp.evaluate(
    `(() => { const toggle = document.getElementById('search-toggle'); toggle.click(); return { expanded: document.getElementById('search-wrap').classList.contains('expanded'), aria: toggle.getAttribute('aria-expanded') }; })()`
  );
  await sleep(250);

  await cdp.evaluate(
    `(() => { const el = document.getElementById('search'); el.value = 'PERSIST'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
  );
  await sleep(800);
  output.search = await cdp.evaluate(
    `({ cards: document.querySelectorAll('.card').length, imageCards: document.querySelectorAll('.card.image').length, sections: [...document.querySelectorAll('.section-title')].map((el) => el.textContent.trim()) })`
  );

  await cdp.evaluate(
    `(() => { const el = document.getElementById('search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
  );
  await sleep(800);
  output.afterClear = await cdp.evaluate(
    `({ cards: document.querySelectorAll('.card').length, sections: [...document.querySelectorAll('.section-title')].map((el) => el.textContent.trim()) })`
  );

  output.thumbnail = await cdp.evaluate(
    `(() => { const img = document.querySelector('.card.image img'); return img ? { src: img.src, complete: img.complete, width: img.naturalWidth, height: img.naturalHeight } : null; })()`
  );

  const removeTarget = items.find((item) => item.type === 'text' && !item.pinned && item.id !== pinTarget.id);
  if (removeTarget) {
    output.remove = await cdp.evaluate(`window.api.removeItem(${JSON.stringify(removeTarget.id)})`);
    await sleep(500);
    output.afterRemove = await cdp.evaluate(`({ cards: document.querySelectorAll('.card').length })`);
    output.removedId = removeTarget.id;
  }

  output.searchCollapse = await cdp.evaluate(
    `(() => { const toggle = document.getElementById('search-toggle'); toggle.click(); return { expanded: document.getElementById('search-wrap').classList.contains('expanded'), aria: toggle.getAttribute('aria-expanded') }; })()`
  );

  output.pinnedId = pinTarget.id;
  console.log(JSON.stringify(output, null, 2));
  cdp.close();
})().catch((err) => {
  console.error('UI 自动化检查失败：', err && err.message ? err.message : err);
  process.exit(1);
});
