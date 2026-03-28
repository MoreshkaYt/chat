require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// ─── Утилита: проверка сессии ────────────────────────────────────────────────
// Простейшая "сессия" — передаём login+password в каждом запросе в заголовках.
// Не самое безопасное, но раз шифрования не нужно — всё ок.

async function getUser(req) {
  const login = req.headers['x-login'];
  const password = req.headers['x-password'];
  if (!login || !password) return null;
  const { rows } = await db.query(
    'SELECT * FROM users WHERE login=$1 AND password=$2',
    [login, password]
  );
  return rows[0] || null;
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

// Проверить логин/пароль
app.post('/auth/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password)
    return res.status(400).json({ error: 'Нужны login и password' });

  const { rows } = await db.query(
    'SELECT id, login, is_admin FROM users WHERE login=$1 AND password=$2',
    [login, password]
  );
  if (!rows[0])
    return res.status(401).json({ error: 'Неверный логин или пароль' });

  res.json({ ok: true, user: rows[0] });
});

// ─── ПОЛЬЗОВАТЕЛИ ────────────────────────────────────────────────────────────

// Список всех пользователей (чтобы начать чат)
app.get('/users', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });

  const { rows } = await db.query(
    'SELECT login, is_admin FROM users WHERE login != $1 ORDER BY login',
    [user.login]
  );
  res.json(rows);
});

// ─── СООБЩЕНИЯ ───────────────────────────────────────────────────────────────

// Получить переписку с конкретным пользователем
app.get('/messages/:withLogin', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });

  const other = req.params.withLogin;

  const { rows } = await db.query(
    `SELECT id, sender_login, receiver_login, text, is_deleted, created_at
     FROM messages
     WHERE (sender_login=$1 AND receiver_login=$2)
        OR (sender_login=$2 AND receiver_login=$1)
     ORDER BY created_at ASC`,
    [user.login, other]
  );
  res.json(rows);
});

// Отправить сообщение
app.post('/messages', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });

  const { receiver_login, text } = req.body;
  if (!receiver_login || !text)
    return res.status(400).json({ error: 'Нужны receiver_login и text' });

  // Проверить что получатель существует
  const { rows: rRows } = await db.query(
    'SELECT login FROM users WHERE login=$1', [receiver_login]
  );
  if (!rRows[0])
    return res.status(404).json({ error: 'Получатель не найден' });

  const { rows } = await db.query(
    `INSERT INTO messages (sender_login, receiver_login, text)
     VALUES ($1, $2, $3)
     RETURNING id, sender_login, receiver_login, text, is_deleted, created_at`,
    [user.login, receiver_login, text]
  );
  const msg = rows[0];

  // Уведомить получателя через WebSocket (если онлайн)
  io.to(receiver_login).emit('new_message', msg);
  // И отправителя тоже (чтобы обновился его UI)
  io.to(user.login).emit('new_message', msg);

  res.json(msg);
});

// Удалить сообщение (помечает is_deleted = true, в БД остаётся)
app.post('/messages/:id/delete', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });

  const { id } = req.params;

  // Только автор может удалить своё сообщение (admin может удалить любое)
  const { rows: mRows } = await db.query(
    'SELECT * FROM messages WHERE id=$1', [id]
  );
  const msg = mRows[0];
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });

  if (!user.is_admin && msg.sender_login !== user.login)
    return res.status(403).json({ error: 'Нельзя удалить чужое сообщение' });

  await db.query(
    'UPDATE messages SET is_deleted=TRUE, deleted_at=NOW() WHERE id=$1',
    [id]
  );

  // Уведомить обоих участников
  io.to(msg.sender_login).emit('message_deleted', { id: Number(id) });
  io.to(msg.receiver_login).emit('message_deleted', { id: Number(id) });

  res.json({ ok: true });
});

// ─── ADMIN: доступ moreshka ко всем перепискам ───────────────────────────────

// Все пользователи с количеством сообщений
app.get('/admin/users', async (req, res) => {
  const user = await getUser(req);
  if (!user || !user.is_admin)
    return res.status(403).json({ error: 'Только для администратора' });

  const { rows } = await db.query(
    `SELECT u.login, u.is_admin, u.created_at,
            COUNT(m.id) AS message_count
     FROM users u
     LEFT JOIN messages m ON m.sender_login = u.login
     GROUP BY u.login, u.is_admin, u.created_at
     ORDER BY u.login`
  );
  res.json(rows);
});

// Переписка между любыми двумя пользователями (включая удалённые)
app.get('/admin/chat', async (req, res) => {
  const user = await getUser(req);
  if (!user || !user.is_admin)
    return res.status(403).json({ error: 'Только для администратора' });

  const { user1, user2 } = req.query;
  if (!user1 || !user2)
    return res.status(400).json({ error: 'Нужны user1 и user2' });

  const { rows } = await db.query(
    `SELECT id, sender_login, receiver_login, text, is_deleted, deleted_at, created_at
     FROM messages
     WHERE (sender_login=$1 AND receiver_login=$2)
        OR (sender_login=$2 AND receiver_login=$1)
     ORDER BY created_at ASC`,
    [user1, user2]
  );
  res.json(rows);
});

// Все переписки пользователя (с кем общался)
app.get('/admin/user-chats/:login', async (req, res) => {
  const user = await getUser(req);
  if (!user || !user.is_admin)
    return res.status(403).json({ error: 'Только для администратора' });

  const { login } = req.params;
  const { rows } = await db.query(
    `SELECT DISTINCT
       CASE WHEN sender_login=$1 THEN receiver_login ELSE sender_login END AS other_user,
       MAX(created_at) AS last_message_at
     FROM messages
     WHERE sender_login=$1 OR receiver_login=$1
     GROUP BY other_user
     ORDER BY last_message_at DESC`,
    [login]
  );
  res.json(rows);
});

// ─── ДОБАВИТЬ ПОЛЬЗОВАТЕЛЯ (только admin) ────────────────────────────────────
app.post('/admin/users', async (req, res) => {
  const user = await getUser(req);
  if (!user || !user.is_admin)
    return res.status(403).json({ error: 'Только для администратора' });

  const { login, password } = req.body;
  if (!login || !password)
    return res.status(400).json({ error: 'Нужны login и password' });

  try {
    const { rows } = await db.query(
      'INSERT INTO users (login, password) VALUES ($1, $2) RETURNING login',
      [login, password]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    res.status(409).json({ error: 'Логин уже занят' });
  }
});

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
// Клиент при подключении передаёт свой login+password для идентификации

io.on('connection', (socket) => {
  const { login, password } = socket.handshake.auth;

  // Проверяем пользователя асинхронно
  db.query('SELECT login FROM users WHERE login=$1 AND password=$2', [login, password])
    .then(({ rows }) => {
      if (!rows[0]) {
        socket.disconnect();
        return;
      }
      // Подписываем сокет на комнату с именем логина
      // Так сервер может отправить сообщение конкретному пользователю
      socket.join(login);
    })
    .catch(() => socket.disconnect());

  socket.on('disconnect', () => {});
});

// ─── ЗАПУСК ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
