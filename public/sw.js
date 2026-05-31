self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: 'CRM AMA', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(payload.title || 'CRM AMA', {
    body: payload.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: payload.data || {},
    tag: payload.data?.tipo || 'crm',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const crm = cs.find(c => c.url.includes(self.registration.scope));
    if (crm) return crm.focus();
    return clients.openWindow(self.registration.scope);
  }));
});
