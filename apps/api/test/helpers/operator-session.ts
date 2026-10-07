import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { TOKEN_AUDIENCE_ADMIN, signAccessToken } from '../../src/auth/tokens';

export interface OperatorSession {
  email: string;
  token: string;
  cleanup: () => Promise<void>;
}

// e2e 用：直接在库里建一个 ACTIVE 运营并签一个 admin 令牌，不走登录接口
// （登录本身在 operator-auth.e2e-spec 里测）。
export async function createOperatorSession(
  prisma: PrismaClient,
  label: string,
): Promise<OperatorSession> {
  const email = `op-${label}-${randomUUID()}@example.com`;
  const operator = await prisma.operator.create({
    data: { email, passwordHash: 'not-a-real-hash' },
  });
  const token = await signAccessToken(
    { sub: operator.id, email },
    process.env.JWT_SECRET ?? '',
    '1h',
    TOKEN_AUDIENCE_ADMIN,
  );
  return {
    email,
    token,
    cleanup: async () => {
      await prisma.auditEvent.deleteMany({ where: { actorId: email } });
      await prisma.operator.deleteMany({ where: { id: operator.id } });
    },
  };
}
