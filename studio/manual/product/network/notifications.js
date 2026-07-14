export const Notifications = Object.freeze({
  supported: false,
  list: async () => ({ items: [], nextCursor: null }),
  read: async () => ({ supported: false })
});
