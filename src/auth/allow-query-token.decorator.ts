import { SetMetadata } from '@nestjs/common';

export const ALLOW_QUERY_TOKEN_KEY = 'allowQueryToken';

// 只有极少数端点需要接受 URL 上的 token（浏览器 sendBeacon()/WebSocket 握手都不能带自定义
// header）。默认不允许——JwtAuthGuard 只有在这个 handler 显式标了这个装饰器时才会去看
// query string，避免短生命周期 token 无谓地泄进访问日志、浏览器历史或分享出去的链接里。
export const AllowQueryToken = () => SetMetadata(ALLOW_QUERY_TOKEN_KEY, true);
