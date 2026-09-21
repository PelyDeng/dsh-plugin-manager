import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// shadcn/ai-elements 生态的标准 cn：合并 Tailwind 类并去冲突。
// CLI 产物统一 import 此处（@/lib/utils），不引第三方 "cn" 包。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
