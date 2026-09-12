/** Deterministic redaction for model-visible and business-page content. */

import type { JsonValue } from './gateway.ts'

const PHONE_KEYS = new Set(['phone', 'userPhone', 'submitUserPhone', 'mobile', 'mobilePhone'])
const ID_CARD_KEYS = new Set(['idCard', 'identityCard', 'certificateNo'])
const MEDIA_KEYS = new Set([
  'accessAddress', 'attachment', 'faceUrl', 'headPicUrl', 'iconImg', 'path', 'url',
  'videoAddress', 'videoUrl', 'liveUrl', 'liveUrlInner', 'devicePullStreamUrl',
])

function digits(value: string): string {
  return value.replace(/\D/g, '')
}

/** Mask one phone-like value while retaining enough digits for record comparison. */
export function maskPhone(value: string): string {
  const normalized = digits(value)
  return normalized.length >= 7 ? `${normalized.slice(0, 3)}****${normalized.slice(-4)}` : '已隐藏'
}

/** Mask one identity-card-like value while retaining stable leading and trailing digits. */
export function maskIdCard(value: string): string {
  const normalized = value.replace(/[\s-]/g, '')
  return normalized.length >= 10 ? `${normalized.slice(0, 6)}********${normalized.slice(-4)}` : '已隐藏'
}

/** Redact common sensitive values embedded in previously persisted assistant text. */
export function redactVisibleText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?|rtsp|rtmp):\/\/[^\s)\]}，。；、,;]+/gi, '[地址已隐藏]')
    .replace(/\/\/[^\s)\]}，。；、,;]+/g, '[地址已隐藏]')
    .replace(/\/(?:media|stream|play|video|capture|record|snapshot)(?:\/|[?#])[^\s)\]}，。；、,;]*/gi, '[地址已隐藏]')
    .replace(/\/(?:[^\s)\]}，。；、,;/?#]+\/)*[^\s)\]}，。；、,;/?#]+\?(?:[^\s)\]}，。；、,;]*&)?(?:token|auth|signature|sign|key)=[^\s)\]}，。；、,;]*/gi, '[地址已隐藏]')
    .replace(/\/(?:[^\s)\]}，。；、,;/?#]+\/)*[^\s)\]}，。；、,;/?#]+\.(?:m3u8|flv|mp4|mov|ts|jpe?g|png)(?:\?[^\s)\]}，。；、,;]*)?/gi, '[地址已隐藏]')
    .replace(/(?<!\d)1(?:[\s-]?\d){10}(?!\d)/g, match => maskPhone(match))
    .replace(/(?<![\dA-Za-z])\d{6}[\s-]?\d{8}[\s-]?\d{3}[\dXx](?![\dA-Za-z])/g, match => maskIdCard(match))
}

/** Recursively redact known sensitive JSON fields without removing opaque workflow ids. */
export function redactJsonValue(value: JsonValue, key = ''): JsonValue {
  if (typeof value === 'string') {
    if (PHONE_KEYS.has(key)) return maskPhone(value)
    if (ID_CARD_KEYS.has(key)) return maskIdCard(value)
    if (MEDIA_KEYS.has(key)) return '已隐藏'
    return redactVisibleText(value)
  }
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, key))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey)]))
}
