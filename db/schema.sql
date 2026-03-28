-- Запускать один раз в Supabase SQL Editor

-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(100) NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица сообщений
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_login VARCHAR(50) NOT NULL,
  receiver_login VARCHAR(50) NOT NULL,
  text TEXT NOT NULL,
  is_deleted BOOLEAN DEFAULT FALSE,   -- скрыто в UI, но остаётся в БД
  deleted_at TIMESTAMP,               -- когда удалили
  created_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для быстрого поиска переписки
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_login);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_login);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Создать администратора moreshka и первых пользователей
-- ПОМЕНЯЙ ПАРОЛИ НА СВОИ!
INSERT INTO users (login, password, is_admin) VALUES
  ('moreshka', 'admin_password_here', TRUE)
ON CONFLICT (login) DO NOTHING;

-- Добавлять обычных пользователей так:
-- INSERT INTO users (login, password) VALUES ('ivan', 'password123');
-- INSERT INTO users (login, password) VALUES ('anna', 'password456');
