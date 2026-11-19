'use strict';

// 相对时间显示（纯函数，可在 Node 中测试）
// 规则：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / M月D日 HH:mm / YYYY年M月D日 HH:mm

(function (root) {
  function formatRelativeTime(timestamp, nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const diff = now - timestamp;

    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;

    const date = new Date(timestamp);
    const nowDate = new Date(now);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');

    if (date.toDateString() === nowDate.toDateString()) return `今天 ${hh}:${mm}`;

    const yesterday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hh}:${mm}`;

    if (date.getFullYear() === nowDate.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
  }

  const api = { formatRelativeTime };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TimeUtils = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
