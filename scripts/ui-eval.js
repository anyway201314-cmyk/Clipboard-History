'use strict';

// 开发辅助：在运行中的应用渲染层执行一段表达式并输出结果（需 --remote-debugging-port=9222）。
// 用法：node scripts/ui-eval.js "document.querySelectorAll('.card').length"

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
  const expression = process.argv[2];
  if (!expression) {
    console.error('用法：node scripts/ui-eval.js "<表达式>"');
    process.exit(1);
  }
  const target = await findPageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  const value = await cdp.evaluate(expression);
  console.log(JSON.stringify(value, null, 2));
  cdp.close();
})().catch((err) => {
  console.error('执行失败：', err && err.message ? err.message : err);
  process.exit(1);
});
