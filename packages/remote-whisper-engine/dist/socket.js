export const defaultSocketFactory = (url, protocols) => new WebSocket(url, [...protocols]);
