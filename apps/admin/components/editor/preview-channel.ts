export function createPreviewChannel({
  clientOrigin,
  getTarget,
}: {
  clientOrigin: string;
  getTarget: () => Window | null;
}) {
  let ready = false;
  let latest: unknown;
  const send = () => {
    if (ready && latest !== undefined)
      getTarget()?.postMessage(latest, clientOrigin);
  };
  return {
    post(payload: unknown) {
      latest = payload;
      send();
    },
    receive(event: MessageEvent) {
      if (
        event.origin !== clientOrigin ||
        event.source !== getTarget() ||
        !event.source ||
        event.data?.type !== 'lesson-preview-ready'
      )
        return false;
      ready = true;
      send();
      return true;
    },
    reset() {
      ready = false;
    },
  };
}
