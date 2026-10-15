/*
 * Private notifications for /kids/. No fetch handler, offline cache, credentials,
 * or conversation data. Gateway payload text and navigation targets are ignored.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Rocky", {
      body: "Rocky has a reply for you",
      icon: "/kids/rocky.svg",
      tag: "rocky-reply",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL("/kids/#chat", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname === "/kids/";
      });
      if (existing) {
        existing.postMessage({ type: "kids:navigate", hash: "#chat" });
        await existing.focus();
      } else {
        await self.clients.openWindow(destination);
      }
    })(),
  );
});
