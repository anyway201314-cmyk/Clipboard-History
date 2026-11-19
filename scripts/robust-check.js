'use strict';

// 阶段 5 安全与边界检查（开发用，需 --remote-debugging-port=9222）。
// 验证渲染层隔离、CSP、IPC 参数校验、外部导航/新窗口拦截。

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
  throw new Error('未找到可调试页面');
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
  output.rendererGlobals = await cdp.evaluate(
    `({ process: typeof process, require: typeof require, module: typeof module, api: Object.keys(window.api || {}) })`
  );
  output.csp = await cdp.evaluate(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`
  );

  output.invalidLimit = await cdp.evaluate(
    `(async () => { const result = await window.api.queryItems({ offset: 0, limit: 99999 }); return { returned: result.items.length, total: result.total }; })()`
  );
  output.invalidSettings = await cdp.evaluate(`window.api.updateSettings({ retentionDays: 0 })`);
  output.invalidPin = await cdp.evaluate(`window.api.pinItem('missing-id', true)`);
  output.invalidRemove = await cdp.evaluate(`window.api.removeItem('missing-id')`);

  output.windowOpen = await cdp.evaluate(
    `(() => { try { return String(window.open('https://example.com')); } catch (error) { return 'threw:' + error.message; } })()`
  );

  output.beforeNavigate = await cdp.evaluate(`location.href`);
  try {
    await cdp.evaluate(`(() => { location.href = 'https://example.com/'; return true; })()`);
  } catch {
    // 阻止导航时可能抛错，忽略
  }
  await sleep(800);
  try {
    output.afterNavigate = await cdp.evaluate(`location.href`);
  } catch (error) {
    output.afterNavigate = `evaluate failed: ${error.message}`;
  }
  output.banner = await cdp.evaluate(`document.getElementById('banner') ? document.getElementById('banner').textContent : null`);
  output.status = await cdp.evaluate(`window.api.getStatus()`);

  console.log(JSON.stringify(output, null, 2));
  cdp.close();
})().catch((err) => {
  console.error('安全边界检查失败：', err && err.message ? err.message : err);
  process.exit(1);
});
