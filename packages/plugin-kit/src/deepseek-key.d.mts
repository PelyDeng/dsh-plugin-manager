export declare const DEEPSEEK_KEY_REF = "DEEPSEEK_API_KEY";
export declare class DeepSeekKeyError extends Error {}
export interface DeepSeekKeyStatus {
  supported: boolean;
  configured: boolean;
  writable: boolean;
  source: string | null;
  fingerprint: string | null;
}
export declare function validateDeepSeekKey(key: unknown): asserts key is string;
export declare function deepSeekKeyStatus(provider: unknown): Promise<DeepSeekKeyStatus>;
export declare function setDeepSeekKey(provider: unknown, key: unknown, authorize?: () => void): Promise<DeepSeekKeyStatus>;
