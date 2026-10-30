const revision = new URL(import.meta.url).searchParams.get('revision');
if (!revision) throw new Error('The development reload script requires a page revision.');

const changes = new EventSource('/__dev/events');
changes.onmessage = event => {
  if (event.data !== revision) {
    changes.close();
    location.reload();
  }
};
window.addEventListener('pagehide', () => changes.close(), {once: true});
