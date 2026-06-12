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

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = e.notification.data && e.notification.data.url
    ? new URL(e.notification.data.url, self.registration.scope).href
    : self.registration.scope;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    var crm = cs.find(function(c) { return c.url.includes(self.registration.scope); });
    if (crm) {
      crm.focus();
      if (e.notification.data && e.notification.data.url && crm.navigate) return crm.navigate(url).catch(function() {});
      return;
    }
    return clients.openWindow(url);
  }));
});
