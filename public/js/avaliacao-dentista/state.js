export const AvaliacaoApp = {
  user: null,
  currentTab: null,
  currentSession: null,
  config: null,
  events: new EventTarget(),

  emit(type, detail = {}) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  },

  on(type, handler) {
    this.events.addEventListener(type, handler);
  },
};
