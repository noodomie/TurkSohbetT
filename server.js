'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));

const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 8 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
  perMessageDeflate: false,
  cors: { origin: false },
  allowRequest(req, callback) {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0].trim().toLowerCase();
      const directHost = String(req.headers.host || '').toLowerCase();
      callback(null, originHost === requestHost || originHost === directHost);
    } catch (_error) {
      callback(null, false);
    }
  }
});

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_NAME_LENGTH = 16;
const MAX_MESSAGE_LENGTH = 200;
const MAX_ACTIVE_USERS = 150;
const MAX_CONNECTIONS = 300;
const MAX_STORED_MESSAGES = 300;
const HISTORY_LIMIT = 100;
const NAME_PATTERN = /^[ABC�DEFG�HI襤JKLMNO�PRS�TU�VYZabc癟defg�h覺ijklmno繹prs�tu羹vyz0-9]{3,16}$/u;

const activeUsers = new Map();
const messages = [];

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use('/health', rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'turk-sohbet' });
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  dotfiles: 'deny',
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

function normalizeName(name) {
  return name.normalize('NFC').toLocaleLowerCase('tr-TR');
}

function countCharacters(value) {
  return Array.from(value).length;
}

function sendError(socket, message, type = 'error') {
  socket.emit('server:notice', { type, message });
}

function takeRate(socket, key, limit, windowMs) {
  const now = Date.now();
  if (!socket.data.rateBuckets) socket.data.rateBuckets = new Map();
  const previous = socket.data.rateBuckets.get(key) || [];
  const recent = previous.filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    const lastNotice = socket.data.lastRateNoticeAt || 0;
    if (now - lastNotice > 1800) {
      socket.data.lastRateNoticeAt = now;
      sendError(socket, '�ok h覺zl覺 i�lem yap覺yorsun. Biraz yava�la.');
    }
    socket.data.rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  socket.data.rateBuckets.set(key, recent);
  return true;
}

function requireJoined(socket) {
  if (!socket.data.userKey || !socket.data.username) {
    sendError(socket, '�nce sohbete kat覺lmal覺s覺n.');
    return false;
  }
  return true;
}

function publicUsers() {
  return Array.from(activeUsers.values())
    .map((user) => ({ name: user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

function publicMessage(message) {
  const { senderKey, ...visible } = message;
  return visible;
}

function storeMessage(message) {
  messages.push(message);
  if (messages.length > MAX_STORED_MESSAGES) {
    messages.splice(0, messages.length - MAX_STORED_MESSAGES);
  }
}

function makeSystemMessage(text) {
  return {
    id: crypto.randomUUID(),
    system: true,
    sender: 'T羹rk Sohbet',
    text,
    timestamp: Date.now(),
    edited: false,
    replyTo: null
  };
}

function cleanMessageText(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!cleaned || countCharacters(cleaned) > MAX_MESSAGE_LENGTH) return null;
  return cleaned;
}

function sendChatMessage(socket, rawText, replyToId = null, acknowledge = null) {
  const fail = (message) => {
    sendError(socket, message);
    if (typeof acknowledge === 'function') acknowledge({ ok: false, message });
  };
  if (!requireJoined(socket)) {
    if (typeof acknowledge === 'function') acknowledge({ ok: false, message: '�nce sohbete kat覺lmal覺s覺n.' });
    return;
  }
  if (!takeRate(socket, 'message-short', 5, 5000) || !takeRate(socket, 'message-long', 30, 60000)) {
    if (typeof acknowledge === 'function') acknowledge({ ok: false, message: '�ok h覺zl覺 i�lem yap覺yorsun. Biraz yava�la.' });
    return;
  }

  const text = cleanMessageText(rawText);
  if (!text) {
    fail('Mesaj bo� olamaz ve en fazla 200 karakter olabilir.');
    return;
  }

  let replyTo = null;
  if (replyToId !== null && replyToId !== undefined && replyToId !== '') {
    if (typeof replyToId !== 'string' || replyToId.length > 64) {
      fail('Yan覺tlanacak mesaj bulunamad覺.');
      return;
    }
    const target = messages.find((item) => item.id === replyToId && !item.system);
    if (!target) {
      fail('Yan覺tlanacak mesaj art覺k bulunmuyor.');
      return;
    }
    replyTo = {
      id: target.id,
      sender: target.sender,
      text: target.text.slice(0, 100)
    };
  }

  const message = {
    id: crypto.randomUUID(),
    system: false,
    sender: socket.data.username,
    senderKey: socket.data.userKey,
    text,
    timestamp: Date.now(),
    edited: false,
    replyTo
  };

  storeMessage(message);
  io.emit('message:new', publicMessage(message));
  if (typeof acknowledge === 'function') acknowledge({ ok: true, id: message.id });
}

io.on('connection', (socket) => {
  if (io.engine.clientsCount > MAX_CONNECTIONS) {
    sendError(socket, 'Sunucu �u anda dolu. Daha sonra tekrar dene.');
    socket.disconnect(true);
    return;
  }

  socket.on('join', (payload) => {
    if (!takeRate(socket, 'join', 5, 60000)) {
      socket.emit('join:error', { message: '�ok s覺k deneme yap覺ld覺. Biraz sonra tekrar dene.' });
      return;
    }
    if (socket.data.userKey) {
      sendError(socket, 'Zaten sohbete kat覺ld覺n.');
      return;
    }

    const rawName = payload && typeof payload === 'object' ? payload.name : null;
    if (typeof rawName !== 'string') {
      socket.emit('join:error', { message: 'Hatal覺 襤sim!' });
      return;
    }

    const name = rawName.normalize('NFC').trim();
    if (countCharacters(name) < 3 || countCharacters(name) > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
      socket.emit('join:error', { message: 'Hatal覺 襤sim!' });
      return;
    }

    if (activeUsers.size >= MAX_ACTIVE_USERS) {
      socket.emit('join:error', { message: 'Sohbet �u anda dolu. Daha sonra tekrar dene.' });
      return;
    }

    const userKey = normalizeName(name);
    const existing = activeUsers.get(userKey);
    if (existing && existing.socketId !== socket.id) {
      socket.emit('join:error', { message: 'Bu isim �u anda kullan覺mda.' });
      return;
    }

    activeUsers.set(userKey, { socketId: socket.id, name });
    socket.data.username = name;
    socket.data.userKey = userKey;

    socket.emit('join:success', {
      name,
      users: publicUsers(),
      messages: messages.slice(-HISTORY_LIMIT).map(publicMessage)
    });

    io.emit('users:update', publicUsers());

    const joinedNotice = makeSystemMessage(`${name} sohbete kat覺ld覺`);
    storeMessage(joinedNotice);
    socket.broadcast.emit('message:new', publicMessage(joinedNotice));
  });

  socket.on('message:send', (payload, acknowledge) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    sendChatMessage(socket, body.text, body.replyToId, acknowledge);
  });

  socket.on('message:edit', (payload, acknowledge) => {
    const fail = (message) => {
      sendError(socket, message);
      if (typeof acknowledge === 'function') acknowledge({ ok: false, message });
    };
    if (!requireJoined(socket)) {
      if (typeof acknowledge === 'function') acknowledge({ ok: false, message: '�nce sohbete kat覺lmal覺s覺n.' });
      return;
    }
    if (!takeRate(socket, 'edit', 8, 60000)) {
      if (typeof acknowledge === 'function') acknowledge({ ok: false, message: '�ok h覺zl覺 i�lem yap覺yorsun. Biraz yava�la.' });
      return;
    }

    const body = payload && typeof payload === 'object' ? payload : {};
    if (typeof body.id !== 'string' || body.id.length > 64) {
      fail('Mesaj d羹zenlenemedi.');
      return;
    }

    const message = messages.find((item) => item.id === body.id && !item.system);
    if (!message || message.senderKey !== socket.data.userKey) {
      fail('Yaln覺zca kendi mesaj覺n覺 d羹zenleyebilirsin.');
      return;
    }

    const text = cleanMessageText(body.text);
    if (!text) {
      fail('Mesaj bo� olamaz ve en fazla 200 karakter olabilir.');
      return;
    }

    message.text = text;
    message.edited = true;
    message.editedAt = Date.now();
    io.emit('message:updated', publicMessage(message));
    if (typeof acknowledge === 'function') acknowledge({ ok: true, id: message.id });
  });

  socket.on('message:delete', (payload) => {
    if (!requireJoined(socket)) return;
    if (!takeRate(socket, 'delete', 10, 60000)) return;

    const body = payload && typeof payload === 'object' ? payload : {};
    if (typeof body.id !== 'string' || body.id.length > 64) {
      sendError(socket, 'Mesaj silinemedi.');
      return;
    }

    const index = messages.findIndex((item) => item.id === body.id && !item.system);
    if (index === -1 || messages[index].senderKey !== socket.data.userKey) {
      sendError(socket, 'Yaln覺zca kendi mesaj覺n覺 silebilirsin.');
      return;
    }

    messages.splice(index, 1);
    io.emit('message:deleted', { id: body.id });
  });

  socket.on('disconnect', () => {
    const userKey = socket.data.userKey;
    const username = socket.data.username;
    if (!userKey || !username) return;

    const current = activeUsers.get(userKey);
    if (current && current.socketId === socket.id) {
      activeUsers.delete(userKey);
      io.emit('users:update', publicUsers());
      const leftNotice = makeSystemMessage(`${username} sohbetten ayr覺ld覺`);
      storeMessage(leftNotice);
      io.emit('message:new', publicMessage(leftNotice));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`T羹rk Sohbet 癟al覺�覺yor: http://0.0.0.0:${PORT}`);
});
