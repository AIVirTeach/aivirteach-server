import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const TOKEN_ISSUER = 'aivirteach';
export const TOKEN_AUDIENCE = 'aivirteach-client';

export interface AccessTokenClaims {
  sub: string;
  email: string;
}

export class InvalidTokenError extends Error {
  constructor(message = 'token 无效或已过期') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

// jose 要求密钥是 Uint8Array，不能直接传字符串。
const toKey = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttl: string,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime(ttl)
    .sign(toKey(secret));
}

// 所有失败原因（签名不符、过期、格式错误）统一成 InvalidTokenError，
// 避免把 jose 的内部错误类型泄露给上层，也避免用错误信息区分「无此用户」和「密码错」。
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, toKey(secret), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new InvalidTokenError('token 缺少必要字段');
    }

    return { sub: payload.sub, email: payload.email };
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      throw error;
    }
    throw new InvalidTokenError();
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
