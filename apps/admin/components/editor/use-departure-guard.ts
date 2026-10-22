'use client';
import { useEffect } from 'react';
const activeGuards = new Set<symbol>();
let historyGuardInstalled = false;
let guardedUrl = '';
function protectHistory() {
  if (window.history.state?.courseEditorGuard !== window.location.href) {
    guardedUrl = window.location.href;
    window.history.pushState(
      { ...window.history.state, courseEditorGuard: guardedUrl },
      '',
      guardedUrl,
    );
  }
  if (historyGuardInstalled) return;
  historyGuardInstalled = true;
  window.addEventListener(
    'popstate',
    (event) => {
      if (!activeGuards.size || event.state?.courseEditorGuard === guardedUrl)
        return;
      event.stopImmediatePropagation();
      window.history.forward();
      window.alert('还有未保存的改动，请保存成功后再离开。');
    },
    true,
  );
}
export function useDepartureGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const token = Symbol();
    activeGuards.add(token);
    protectHistory();
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest('a') : null;
      if (
        target &&
        target.getAttribute('target') !== '_blank' &&
        !target.getAttribute('href')?.startsWith('#')
      ) {
        event.preventDefault();
        event.stopPropagation();
        window.alert('还有未保存的改动，请保存成功后再离开。');
      }
    };
    const submit = (event: SubmitEvent) => {
      if (
        event.target instanceof HTMLFormElement &&
        event.target.dataset.logout === 'true'
      ) {
        event.preventDefault();
        event.stopPropagation();
        window.alert('还有未保存的改动，请保存成功后再退出。');
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', click, true);
    document.addEventListener('submit', submit, true);
    return () => {
      activeGuards.delete(token);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', click, true);
      document.removeEventListener('submit', submit, true);
    };
  }, [dirty]);
}
