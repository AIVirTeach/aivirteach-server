import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { logoutAction } from './actions';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <header className="app-header">
        <a href="/courses" className="brand">
          <span className="brand-mark" aria-hidden="true">
            AV
          </span>
          AIVirTeach <span className="brand-context">课程工作室</span>
        </a>
        <form action={logoutAction} data-logout="true">
          <Button type="submit" variant="outline">
            退出
          </Button>
        </form>
      </header>
      {children}
    </>
  );
}
