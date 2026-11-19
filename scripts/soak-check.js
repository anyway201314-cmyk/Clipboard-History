'use strict';

// 阶段 5 空闲稳定性采样（开发用，需 --remote-debugging-port=9222）。
// 用法：node scripts/soak-check.js [采样秒数=600] [采样间隔秒=15]
// 输出 CPU/内存采样，并写入 data-dev/soak-result.json。

const fs = require('node:fs');
const path = require('node:path');

const DURATION_SEC = Number(process.argv[2]) || 600;
const INTERVAL_SEC = Number(process.argv[3]) || 15;
const ROOT = path.join(__dirname, '..');

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

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < DURATION_SEC * 1000) {
    const status = await cdp.evaluate(`window.api.getStatus()`);
    samples.push({
      t: Date.now() - start,
      cpu: status.cpuPercent,
      memoryMB: status.memoryMB,
    });
    await sleep(INTERVAL_SEC * 1000);
  }
  cdp.close();

  const cpuSamples = samples.slice(1).map((sample) => sample.cpu);
  const memorySamples = samples.map((sample) => sample.memoryMB);
  const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const result = {
    date: new Date().toISOString(),
    durationSec: DURATION_SEC,
    intervalSec: INTERVAL_SEC,
    samples,
    cpu: {
      avgPercent: Math.round(average(cpuSamples) * 100) / 100,
      maxPercent: cpuSamples.length ? Math.max(...cpuSamples) : 0,
    },
    memory: {
      startMB: memorySamples[0] || 0,
      endMB: memorySamples[memorySamples.length - 1] || 0,
      minMB: memorySamples.length ? Math.min(...memorySamples) : 0,
      maxMB: memorySamples.length ? Math.max(...memorySamples) : 0,
    },
  };

  fs.writeFileSync(path.join(ROOT, 'data-dev', 'soak-result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ durationSec: result.durationSec, cpu: result.cpu, memory: result.memory, sampleCount: samples.length }, null, 2));
})().catch((err) => {
  console.error('稳定性采样失败：', err && err.message ? err.message : err);
  process.exit(1);
});
