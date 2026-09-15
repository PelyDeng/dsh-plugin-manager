/** Translate prose only; code and links retain their spelling. */
export function needsChineseTranslation(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, '')
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length
  const han = (prose.match(/\p{Script=Han}/gu) ?? []).length
  return latin >= 16 && (prose.match(/[A-Za-z]+/g) ?? []).length >= 4 && latin > han * 2
}
