'use strict';
/* Эмулятор Telegram Bot API: принимает sendMessage и запоминает сообщения. */
const http = require('node:http');

function createMockTelegram() {
  const messages = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
      res.writeHead(m ? 200 : 404, { 'Content-Type': 'application/json' });
      if (!m) return res.end('{"ok":false}');
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (m[2] === 'sendMessage') messages.push({ token: m[1], chat_id: String(body.chat_id), text: body.text, reply_markup: body.reply_markup });
      res.end(JSON.stringify({ ok: true, result: { message_id: messages.length } }));
    });
  });
  const api = {
    messages, url: '',
    to: (chatId) => messages.filter((x) => x.chat_id === String(chatId)),
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { api.url = `http://127.0.0.1:${server.address().port}`; resolve(api); })),
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
  return api;
}

module.exports = { createMockTelegram };
