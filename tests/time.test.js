'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRelativeTime } = require('../src/renderer/js/time');

const NOW = new Date(2026, 10, 19, 14, 30, 0).getTime();

test('time: 一分钟内显示「刚刚」', () => {
  assert.equal(formatRelativeTime(NOW - 30 * 1000, NOW), '刚刚');
  assert.equal(formatRelativeTime(NOW, NOW), '刚刚');
  assert.equal(formatRelativeTime(NOW + 5000, NOW), '刚刚');
});

test('time: 一小时内显示分钟数', () => {
  assert.equal(formatRelativeTime(NOW - 5 * 60 * 1000, NOW), '5 分钟前');
  assert.equal(formatRelativeTime(NOW - 59 * 60 * 1000, NOW), '59 分钟前');
});

test('time: 当天显示「今天 HH:mm」', () => {
  assert.equal(formatRelativeTime(new Date(2026, 10, 19, 9, 5).getTime(), NOW), '今天 09:05');
});

test('time: 昨天显示「昨天 HH:mm」', () => {
  assert.equal(formatRelativeTime(new Date(2026, 10, 18, 18, 20).getTime(), NOW), '昨天 18:20');
});

test('time: 同年显示「M月D日 HH:mm」', () => {
  assert.equal(formatRelativeTime(new Date(2026, 0, 5, 8, 7).getTime(), NOW), '1月5日 08:07');
});

test('time: 跨年显示完整日期', () => {
  assert.equal(formatRelativeTime(new Date(2025, 11, 31, 23, 59).getTime(), NOW), '2025年12月31日 23:59');
});
