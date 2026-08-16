export const browserSocketFactory = (url, protocols) => new WebSocket(url, [...protocols]);
