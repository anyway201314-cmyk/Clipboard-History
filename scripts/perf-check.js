'use strict';

// 阶段 5 性能检查（开发用，需以 --remote-debugging-port=9222 启动应用）。
// 输出首屏渲染、查询耗时、搜索耗时、分页加载数量、内存与 CPU 参考值。

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
      // 重试
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
  output.initialDom = await cdp.evaluate(
    `({ cards: document.querySelectorAll('.card').length, sections: [...document.querySelectorAll('.section-title')].map((el) => el.textContent.trim()) })`
  );

  output.queryApi = await cdp.evaluate(
    `(async () => { const start = performance.now(); const result = await window.api.queryItems({ offset: 0, limit: 100 }); return { ms: Math.round((performance.now() - start) * 10) / 10, total: result.total, returned: result.items.length }; })()`
  );

  output.searchApi = await cdp.evaluate(
    `(async () => { const start = performance.now(); const result = await window.api.queryItems({ search: '种子', offset: 0, limit: 100 }); return { ms: Math.round((performance.now() - start) * 10) / 10, total: result.total, returned: result.items.length }; })()`
  );

  output.uiSearch = await cdp.evaluate(
    `(() => new Promise((resolve) => {
      const list = document.getElementById('list');
      const input = document.getElementById('search');
      const start = performance.now();
      let done = false;
      const observer = new MutationObserver(() => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve({ ms: Math.round((performance.now() - start) * 10) / 10, cards: document.querySelectorAll('.card').length, sections: [...document.querySelectorAll('.section-title')].map((el) => el.textContent.trim()) });
      });
      observer.observe(list, { childList: true, subtree: true });
      input.value = '种子';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        if (!done) {
          observer.disconnect();
          resolve({ ms: -1, cards: document.querySelectorAll('.card').length, sections: [] });
        }
      }, 8000);
    }))()`
  );

  await cdp.evaluate(
    `(() => { const input = document.getElementById('search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
  );
  await sleep(800);
  output.afterClear = await cdp.evaluate(`({ cards: document.querySelectorAll('.card').length })`);

  await cdp.evaluate(
    `(() => { const list = document.getElementById('list'); list.scrollTop = list.scrollHeight; return true; })()`
  );
  await sleep(900);
  output.afterScroll = await cdp.evaluate(`({ cards: document.querySelectorAll('.card').length })`);

  output.thumbnail = await cdp.evaluate(
    `(() => { const img = document.querySelector('.card.image img'); return img ? { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight } : null; })()`
  );

  output.status = await cdp.evaluate(`window.api.getStatus()`);
  console.log(JSON.stringify(output, null, 2));
  cdp.close();
})().catch((err) => {
  console.error('性能检查失败：', err && err.message ? err.message : err);
  process.exit(1);
});
