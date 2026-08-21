import { z } from 'zod';

export const OperatorSchema = z.email('operator 必须是合法邮箱');
export const ReasonSchema = z.string().min(1, 'reason 不能为空');
