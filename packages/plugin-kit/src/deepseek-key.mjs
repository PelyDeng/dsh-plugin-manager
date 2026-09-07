/** Backward-compatible default DeepSeek credential API for existing CLI consumers. */
import { modelKeyStatus, setModelKey, validateModelKey } from './model-key.mjs';
export { ModelKeyError as DeepSeekKeyError } from './model-key.mjs';
export const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY';
export function validateDeepSeekKey(key) { validateModelKey('deepseek', key); }
export function deepSeekKeyStatus(provider) { return modelKeyStatus(provider, 'deepseek'); }
export function setDeepSeekKey(provider, key, authorize) { return setModelKey(provider, 'deepseek', key, authorize); }
