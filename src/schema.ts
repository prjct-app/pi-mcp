import { z } from 'zod';

export const ExposureSchema = z.enum(['direct', 'deferred', 'codemode', 'hidden']);
export type Exposure = z.infer<typeof ExposureSchema>;
const textMap = z.record(z.string(), z.string());
export const ServerSchema = z.object({
  command: z.string().min(1).optional(), args: z.array(z.string()).max(128).optional(),
  env: textMap.optional(), cwd: z.string().optional(),
  url: z.string().optional(), headers: textMap.optional(),
  auth: z.enum(['oauth', 'bearer']).optional(), bearerTokenEnv: z.string().min(1).optional(),
  oauth: z.object({
    grantType: z.enum(['authorization_code', 'client_credentials']).optional(),
    clientId: z.string().min(1).optional(), clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    issuer: z.string().optional(), clientMetadataUrl: z.string().optional(), redirectUri: z.string().optional(), scope: z.string().optional(),
  }).strict().optional(),
  protocolVersion: z.enum(['auto', 'legacy', '2026-07-28']).optional(),
  requestTimeoutMs: z.number().int().min(100).max(300000).optional(), disabled: z.boolean().optional(),
  exposure: ExposureSchema.optional(), toolExposure: z.record(z.string().min(1), ExposureSchema).optional(),
}).strict();


export type ServerConfig = z.infer<typeof ServerSchema>;
