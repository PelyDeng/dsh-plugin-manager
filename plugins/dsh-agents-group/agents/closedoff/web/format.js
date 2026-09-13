/**
 * 展示用的格式化：token 数、耗时与最终回答文本。
 */

import { stripMarkdownTables } from './render-text.js';

export function compactTokens(value) {
  var n = Number(value) || 0;
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M tok';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'K tok';
  return n.toLocaleString('zh-CN') + ' tok';
}

export function exactTokens(value) {
  return (Number(value) || 0).toLocaleString('zh-CN') + ' tok';
}

export function compactDuration(ms) {
  var n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return Math.round(n) + ' 毫秒';
  if (n < 60000) return (Math.round(n / 100) / 10) + ' 秒';
  var minutes = Math.floor(n / 60000);
  return minutes + ' 分 ' + Math.round((n % 60000) / 1000) + ' 秒';
}

export function summaryDuration(ms) {
  var seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return seconds + ' 秒';
  return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
}

export function answerText(ast) {
  return (ast.hasStructured ? stripMarkdownTables(ast.accumulated) : ast.accumulated).trim();
}
