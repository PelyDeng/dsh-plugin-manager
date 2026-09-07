export type ModelKeyProvider = 'deepseek' | 'zhipu';
export declare class ModelKeyError extends Error {}
export interface ModelKeyStatus {
  supported: boolean;
  configured: boolean;
  writable: boolean;
  source: string | null;
  fingerprint: string | null;
}
export declare function validateModelKey(kind: ModelKeyProvider, key: unknown): asserts key is string;
export declare function modelKeyStatus(provider: unknown, kind: ModelKeyProvider): Promise<ModelKeyStatus>;
export declare function setModelKey(provider: unknown, kind: ModelKeyProvider, key: unknown, authorize?: () => void): Promise<ModelKeyStatus>;
