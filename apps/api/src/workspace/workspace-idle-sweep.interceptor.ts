import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import type { Observable } from 'rxjs';
import { WorkspaceService } from './workspace.service';

const THROTTLE_MS = 60_000;

// Plan B 的"搭便车"扫描：免费版 Vercel 没有分钟级 Cron，所以借任何一次请求的机会顺手
// 检查一遍空闲 workspace，而不是单独起一个定时任务。内存节流（同一个函数实例内至少间隔
// 60 秒才真的扫一次），扫描本身用 waitUntil 扔到后台，不拖慢这次请求的响应。
@Injectable()
export class WorkspaceIdleSweepInterceptor implements NestInterceptor {
  private lastSweepAt = -Infinity;

  constructor(private readonly workspaceService: WorkspaceService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const now = Date.now();
    if (now - this.lastSweepAt >= THROTTLE_MS) {
      this.lastSweepAt = now;
      waitUntil(this.workspaceService.sweepIdle());
    }
    return next.handle();
  }
}
