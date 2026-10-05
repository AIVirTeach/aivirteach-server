import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { logoutAction } from './actions';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="flex justify-end border-b bg-white px-6 py-3">
        <form action={logoutAction}>
          <Button type="submit" variant="outline">
            退出
          </Button>
        </form>
      </header>
      {children}
    </>
  );
}
