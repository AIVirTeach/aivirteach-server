import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { logoutAction } from './actions';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="app-header">
        <a href="/courses" className="brand">
          AIVirTeach <span>课程工作室</span>
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
