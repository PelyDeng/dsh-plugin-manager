/**
 * MinIO 接缝的公开入口。
 *
 * 三个文件各管一件事：`sigv4.ts` 是纯算法、`client.ts` 是网络与错误分类、本文件只是转出。
 * 分开是为了让签名能脱离网络单独验证——那是最容易出错、也最难从症状反推的一层。
 */

export { createMinioClient, type MinioClient, type MinioConfig } from './client.ts'
export { encodePath, sha256Hex, signS3Request, uriEncode, type SignS3Input } from './sigv4.ts'
