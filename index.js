
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== SESSION ====================

app.use(session({
  name: 'sanhdieu.sid',
  secret: process.env.SESSION_SECRET ||
    'change-this-to-a-long-random-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ==================== DATABASE ====================

const db = new Database(
  path.join(__dirname, 'sanhdieu-users.sqlite')
);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const columns = db.prepare('PRAGMA table_info(users)').all();

if (!columns.some(column => column.name === 'points')) {
  db.exec(
    'ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0'
  );
}
// ==================== ADMIN ROUTES ====================

app.use(require('./routes/admin'));
// ==================== CAPTCHA ====================

const captchas = new Map();

function createCaptcha() {
  const id = crypto.randomUUID();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let answer = '';

  for (let i = 0; i < 5; i++) {
    answer += chars[crypto.randomInt(chars.length)];
  }

  captchas.set(id, {
    answer,
    createdAt: Date.now()
  });

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="180" height="60" viewBox="0 0 180 60">
      <rect width="180" height="60" rx="8" fill="#17130c"/>
      <path d="M0 12 L180 47 M5 58 L160 0 M0 43 L180 19"
            stroke="#b88b35" stroke-width="2" opacity=".65"/>
      <circle cx="24" cy="15" r="2" fill="#f5d889"/>
      <circle cx="150" cy="46" r="3" fill="#f5d889"/>
      <text x="90" y="40" text-anchor="middle"
            font-family="Arial,sans-serif" font-size="27"
            font-weight="bold" letter-spacing="5"
            fill="#f8dfa0">${answer}</text>
    </svg>
  `;

  return {
    id,
    image: 'data:image/svg+xml;base64,' +
      Buffer.from(svg).toString('base64')
  };
}

function verifyCaptcha(id, answer) {
  const key = String(id || '');
  const captcha = captchas.get(key);

  // Mỗi CAPTCHA chỉ được sử dụng một lần.
  captchas.delete(key);

  return Boolean(
    captcha &&
    Date.now() - captcha.createdAt < 5 * 60 * 1000 &&
    captcha.answer === String(answer || '').trim().toUpperCase()
  );
}

setInterval(() => {
  const now = Date.now();

  for (const [id, captcha] of captchas.entries()) {
    if (now - captcha.createdAt > 5 * 60 * 1000) {
      captchas.delete(id);
    }
  }
}, 60 * 1000).unref();

// ==================== CAPTCHA API ====================

app.get('/api/captcha', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(createCaptcha());
});

// ==================== REGISTER API ====================

app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!verifyCaptcha(req.body.captchaId, req.body.captcha)) {
      return res.status(400).json({
        error: 'CAPTCHA sai hoặc hết hạn. Hãy làm mới mã.'
      });
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        error: 'Tên tài khoản phải có 3–20 ký tự, chỉ gồm chữ, số và dấu _.'
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        error: 'Mật khẩu phải có từ 8 đến 72 ký tự.'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        error: 'Hai mật khẩu không khớp.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    db.prepare(`
      INSERT INTO users (username, password_hash)
      VALUES (?, ?)
    `).run(username, passwordHash);

    return res.status(201).json({
      message: 'Đăng ký thành công! Bạn có thể đăng nhập.'
    });
  } catch (err) {
    if (
      err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      String(err.message).includes('UNIQUE constraint failed')
    ) {
      return res.status(409).json({
        error: 'Tên tài khoản đã tồn tại. Hãy chọn tên khác.'
      });
    }

    console.error('REGISTER ERROR:', err);

    return res.status(500).json({
      error: 'Lỗi máy chủ khi đăng ký. Hãy kiểm tra Logs.'
    });
  }
});

// ==================== LOGIN API ====================

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!verifyCaptcha(req.body.captchaId, req.body.captcha)) {
      return res.status(400).json({
        error: 'CAPTCHA sai hoặc hết hạn. Hãy làm mới mã.'
      });
    }

    const user = db.prepare(`
      SELECT id, username, password_hash, points
      FROM users
      WHERE username = ?
    `).get(username);

    if (!user) {
      return res.status(401).json({
        error: 'Tên tài khoản hoặc mật khẩu không đúng.'
      });
    }

    const matched = await bcrypt.compare(password, user.password_hash);

    if (!matched) {
      return res.status(401).json({
        error: 'Tên tài khoản hoặc mật khẩu không đúng.'
      });
    }

    req.session.regenerate(err => {
      if (err) {
        console.error('SESSION ERROR:', err);

        return res.status(500).json({
          error: 'Không thể tạo phiên đăng nhập.'
        });
      }

      req.session.userId = user.id;
      req.session.username = user.username;

      req.session.save(saveErr => {
        if (saveErr) {
          console.error('SESSION SAVE ERROR:', saveErr);

          return res.status(500).json({
            error: 'Không thể lưu phiên đăng nhập.'
          });
        }

        return res.json({
          message: 'Đăng nhập thành công!',
          user: {
            username: user.username,
            points: user.points
          }
        });
      });
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);

    return res.status(500).json({
      error: 'Lỗi máy chủ khi đăng nhập. Hãy kiểm tra Logs.'
    });
  }
});

// ==================== CHANGE PASSWORD API ====================

app.post('/api/change-password', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'
      });
    }

    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (
      newPassword.length < 8 ||
      Buffer.byteLength(newPassword, 'utf8') > 72
    ) {
      return res.status(400).json({
        error: 'Mật khẩu mới phải có ít nhất 8 ký tự và không vượt giới hạn cho phép.'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        error: 'Hai mật khẩu mới không khớp.'
      });
    }

    if (oldPassword === newPassword) {
      return res.status(400).json({
        error: 'Mật khẩu mới phải khác mật khẩu hiện tại.'
      });
    }

    const user = db.prepare(`
      SELECT id, password_hash
      FROM users
      WHERE id = ?
    `).get(req.session.userId);

    if (!user) {
      return res.status(401).json({
        error: 'Không tìm thấy tài khoản. Hãy đăng nhập lại.'
      });
    }

    const matched = await bcrypt.compare(
      oldPassword,
      user.password_hash
    );

    if (!matched) {
      return res.status(400).json({
        error: 'Mật khẩu hiện tại không đúng.'
      });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    const result = db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
    `).run(newHash, user.id);

    if (result.changes !== 1) {
      return res.status(500).json({
        error: 'Không thể cập nhật mật khẩu. Hãy thử lại.'
      });
    }

    return res.json({
      message: 'Đổi mật khẩu thành công!'
    });
  } catch (err) {
    console.error('CHANGE PASSWORD ERROR:', err);

    return res.status(500).json({
      error: 'Lỗi máy chủ khi đổi mật khẩu.'
    });
  }
});

// ==================== CURRENT USER API ====================

app.get('/api/me', (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({ loggedIn: false });
    }

    const user = db.prepare(`
      SELECT username, points
      FROM users
      WHERE id = ?
    `).get(req.session.userId);

    if (!user) {
      return res.json({ loggedIn: false });
    }


    const adminUsername = process.env.ADMIN_USERNAME || '';
    const isAdmin = adminUsername.trim() !== '' &&
      user.username.toLowerCase() === adminUsername.trim().toLowerCase();
    console.log('ADMIN CHECK:', {
      username: user.username,
      adminConfigured: !!process.env.ADMIN_USERNAME,
      isAdmin
    });
    console.log('ADMIN RESULT:', user.username, !!process.env.ADMIN_USERNAME, isAdmin);
    return res.json({
      loggedIn: true,
      user,
      isAdmin
    });
  } catch (err) {
    console.error('ME ERROR:', err);

    return res.status(500).json({
      error: 'Không kiểm tra được tài khoản.'
    });
  }
});


// ==================== LOGOUT API ====================

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('LOGOUT ERROR:', err);

      return res.status(500).json({
        error: 'Đăng xuất thất bại.'
      });
    }

    res.clearCookie('sanhdieu.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto'
    });

    return res.json({
      message: 'Bạn đã đăng xuất.'
    });
  });
});

// ==================== MAIN WEBSITE ====================

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#090806">
<meta name="description" content="SanhDieu.Club - Khu vui chơi giải trí bằng điểm ảo">
<title>SanhDieu.Club | Đăng nhập</title>

<style>
:root {
  --bg: #090806;
  --panel: #12100c;
  --panel2: #1b1710;
  --gold: #d8b46a;
  --gold-light: #f5dfaa;
  --text: #f8f3e8;
  --muted: #a69b85;
  --border: rgba(216,180,106,.23);
  --green: #8ed6a2;
  --red: #ff9b91;
}

* {
  box-sizing: border-box;
}

html {
  min-height: 100%;
}

body {
  margin: 0;
  min-height: 100vh;
  padding: 28px;
  display: flex;
  justify-content: center;
  align-items: center;
  font-family: Arial, Helvetica, sans-serif;
  color: var(--text);
  background:
    radial-gradient(ellipse at 18% 15%, rgba(111,75,23,.22), transparent 42%),
    radial-gradient(ellipse at 82% 82%, rgba(92,62,20,.14), transparent 40%),
    var(--bg);
}

button, input {
  font: inherit;
}

button {
  cursor: pointer;
}

button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--gold-light);
  outline-offset: 3px;
}

.page {
  width: 100%;
  max-width: 1120px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 430px);
  gap: 56px;
  align-items: center;
}

.hero {
  position: relative;
  min-width: 0;
  padding: 18px 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 15px;
}

.brand-mark {
  width: 58px;
  height: 58px;
  flex: 0 0 58px;
  display: grid;
  place-items: center;
  border: 1px solid var(--gold);
  border-radius: 17px;
  color: var(--gold-light);
  font-size: 30px;
  background: linear-gradient(145deg, #2a2112, #100e09);
  box-shadow: 0 0 35px rgba(216,180,106,.1);
}

.brand-name {
  margin: 0;
  font-size: clamp(22px, 3vw, 31px);
  letter-spacing: 1.5px;
  color: var(--gold-light);
}

.brand-caption {
  margin: 7px 0 0;
  font-size: 12px;
  letter-spacing: 3px;
  color: var(--muted);
  text-transform: uppercase;
}

.hero h2 {
  max-width: 570px;
  margin: 48px 0 18px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(38px, 5.4vw, 64px);
  font-weight: 500;
  line-height: 1.08;
  letter-spacing: -1.6px;
}

.hero h2 span {
  color: var(--gold);
}

.hero-description {
  max-width: 450px;
  color: #b8ad99;
  line-height: 1.9;
  font-size: 15px;
}

.art-frame {
  position: relative;
  max-width: 460px;
  height: 260px;
  margin-top: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 24px;
  background:
    radial-gradient(ellipse at center, rgba(168,121,39,.15), transparent 65%),
    linear-gradient(135deg, rgba(255,255,255,.025), transparent);
}

.hero-image {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: 100%;
  padding: 8px;
  object-fit: contain;
  border-radius: 24px;
  filter: drop-shadow(0 0 24px rgba(212,175,55,.2));
}

.art-label {
  position: absolute;
  bottom: 14px;
  z-index: 2;
  padding: 6px 10px;
  border: 1px solid rgba(216,180,106,.25);
  border-radius: 20px;
  color: var(--gold-light);
  background: rgba(9,8,6,.78);
  font-size: 9px;
  letter-spacing: 3px;
  pointer-events: none;
}

.features {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

.feature {
  padding: 10px 13px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: #c9bda7;
  font-size: 12px;
  background: rgba(255,255,255,.018);
}

.login-card {
  width: 100%;
  padding: 30px;
  border: 1px solid rgba(216,180,106,.26);
  border-radius: 23px;
  background:
    linear-gradient(145deg, rgba(255,255,255,.025), transparent 40%),
    var(--panel);
  box-shadow: 0 25px 90px rgba(0,0,0,.48);
}

.card-top {
  margin-bottom: 23px;
}

.card-eyebrow {
  margin: 0 0 9px;
  color: var(--gold);
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 3px;
  text-transform: uppercase;
}

.card-top h1 {
  margin: 0;
  font-size: 27px;
  letter-spacing: -.5px;
}

.card-top p:last-child {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  padding: 5px;
  margin-bottom: 22px;
  border: 1px solid rgba(255,255,255,.04);
  border-radius: 12px;
  background: #0b0907;
}

.tab {
  min-height: 42px;
  border: 0;
  border-radius: 8px;
  color: #9e9380;
  background: transparent;
  font-size: 13px;
  font-weight: bold;
  transition: background .2s, color .2s;
}

.tab.active {
  color: #1a1307;
  background: linear-gradient(135deg, #f0d18b, #bb8d3d);
}

.field {
  margin-bottom: 16px;
}

.field label {
  display: block;
  margin-bottom: 8px;
  color: #d8cdb9;
  font-size: 12px;
  font-weight: bold;
}

.input-wrap {
  position: relative;
}

.input-icon {
  position: absolute;
  top: 50%;
  left: 14px;
  transform: translateY(-50%);
  color: var(--gold);
  font-size: 15px;
  pointer-events: none;
}

.field input {
  display: block;
  width: 100%;
  min-width: 0;
  height: 47px;
  padding: 0 13px 0 40px;
  border: 1px solid #383024;
  border-radius: 10px;
  color: var(--text);
  background: #0c0a08;
  font-size: 14px;
  transition: border-color .2s;
}

.field input::placeholder {
  color: #716858;
}

.field input:focus {
  border-color: var(--gold);
  outline: none;
}

.captcha-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}

.captcha-heading label {
  color: #d8cdb9;
  font-size: 12px;
  font-weight: bold;
}

.refresh-btn {
  padding: 5px 0 5px 8px;
  border: 0;
  color: var(--gold);
  background: transparent;
  font-size: 11px;
}

.captcha-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 112px;
  gap: 9px;
  align-items: center;
}

#captchaImage {
  display: block;
  width: 100%;
  height: 47px;
  border: 1px solid #443722;
  border-radius: 9px;
  background: #17130c;
  object-fit: contain;
}

#captcha {
  width: 100%;
  min-width: 0;
  height: 47px;
  padding: 0 10px;
  border: 1px solid #383024;
  border-radius: 9px;
  color: var(--text);
  background: #0c0a08;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 3px;
}

.submit-btn {
  width: 100%;
  min-height: 49px;
  margin-top: 22px;
  border: 0;
  border-radius: 10px;
  color: #1c1408;
  background: linear-gradient(110deg, #f2d99b, #c19343);
  box-shadow: 0 7px 24px rgba(193,147,67,.12);
  font-size: 14px;
  font-weight: 800;
  transition: filter .2s, transform .2s;
}

.submit-btn:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

button:disabled {
  cursor: wait;
  opacity: .65;
}

#message {
  display: none;
  margin-top: 15px;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

#message.show {
  display: block;
}

#message.ok {
  color: var(--green);
  border-color: rgba(142,214,162,.2);
  background: rgba(28,87,47,.18);
}

#message.bad {
  color: var(--red);
  border-color: rgba(255,155,145,.2);
  background: rgba(115,35,29,.18);
}

#account {
  display: none;
  margin-top: 18px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel2);
}

.account-label {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 2px;
  text-transform: uppercase;
}

#welcome {
  display: block;
  overflow-wrap: anywhere;
  color: var(--gold-light);
  font-size: 15px;
}

#points {
  margin: 11px 0 0;
  color: #d7c7a8;
  font-size: 13px;
}

#logout {
  width: 100%;
  min-height: 40px;
  margin-top: 14px;
  border: 1px solid #443722;
  border-radius: 8px;
  color: #e6d6b7;
  background: #211a10;
  font-size: 12px;
}

#logout:hover {
  background: #302415;
}

.note {
  margin: 19px 0 0;
  color: #827865;
  text-align: center;
  font-size: 10px;
  line-height: 1.8;
}

.footer {
  margin-top: 24px;
  color: #756b59;
  font-size: 10px;
  letter-spacing: 1px;
}

@media (max-width: 850px) {
  body {
    padding: 24px 16px;
  }

  .page {
    max-width: 500px;
    grid-template-columns: 1fr;
    gap: 30px;
  }

  .hero {
    padding: 5px 0 0;
  }

  .hero h2 {
    margin-top: 30px;
    font-size: 43px;
  }

  .hero-description {
    font-size: 14px;
  }

  .art-frame {
    height: 220px;
    margin-top: 25px;
  }

  .features {
    margin-top: 17px;
  }

  .footer {
    margin-top: 18px;
  }
}

@media (max-width: 400px) {
  .login-card {
    padding: 22px 17px;
  }

  .brand-name {
    font-size: 22px;
  }

  .brand-caption {
    font-size: 9px;
    letter-spacing: 2px;
  }

  .hero h2 {
    font-size: 36px;
  }

  .captcha-row {
    grid-template-columns: minmax(0, 1fr) 90px;
  }
}
</style>
</head>

<body>
<div class="page">

  <section class="hero">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">♛</div>
      <div>
        <h2 class="brand-name">SanhDieu.Club</h2>
        <p class="brand-caption">Entertainment Lounge</p>
      </div>
    </div>

    <h2>
      TẶNG<br>
      <span>75%</span><br>
      BACARAT.
    </h2>

    <p class="hero-description">
      Khám phá không gian giải trí trực tuyến với giao diện sang trọng,
      tài khoản cá nhân và hệ thống điểm thưởng ảo.
    </p>

    <div class="art-frame">
      <img
        src="/hero-ai.jpg"
        alt="Hình minh họa SanhDieu.Club"
        class="hero-image"
      >
      <div class="art-label">YOUR PRIVATE LOUNGE</div>
    </div>

    <div class="features">
      <div class="feature">✦ Giao diện cao cấp</div>
      <div class="feature">♙ Tài khoản cá nhân</div>
      <div class="feature">◇ Điểm thưởng ảo</div>
    </div>

    <div class="footer">SANHDIEU.CLUB · DIGITAL ENTERTAINMENT</div>
  </section>

  <main class="login-card">
    <div class="card-top">
      <p class="card-eyebrow">WELCOME TO SANHDIEU</p>
      <h1 id="cardTitle">Chào mừng trở lại</h1>
      <p id="cardDescription">
        Đăng nhập tài khoản để tiếp tục trải nghiệm.
      </p>
    </div>

    <div class="tabs">
      <button class="tab active" id="loginTab" type="button">
        Đăng nhập
      </button>
      <button class="tab" id="registerTab" type="button">
        Đăng ký
      </button>
    </div>

    <form id="form">
      <div class="field">
        <label for="username">TÊN TÀI KHOẢN</label>
        <div class="input-wrap">
          <span class="input-icon" aria-hidden="true">♙</span>
          <input
            id="username"
            name="username"
            type="text"
            placeholder="Nhập tên tài khoản"
            minlength="3"
            maxlength="20"
            pattern="[a-zA-Z0-9_]+"
            autocomplete="username"
            required
          >
        </div>
      </div>

      <div class="field">
        <label for="password">MẬT KHẨU</label>
        <div class="input-wrap">
          <span class="input-icon" aria-hidden="true">◇</span>
          <input
            id="password"
            name="password"
            type="password"
            placeholder="Nhập mật khẩu"
            minlength="8"
            maxlength="72"
            autocomplete="current-password"
            required
          >
        </div>
      </div>

      <div class="field" id="confirmWrap" hidden>
        <label for="confirmPassword">XÁC NHẬN MẬT KHẨU</label>
        <div class="input-wrap">
          <span class="input-icon" aria-hidden="true">◇</span>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="Nhập lại mật khẩu"
            minlength="8"
            maxlength="72"
            autocomplete="new-password"
          >
        </div>
      </div>

      <div class="field">
        <div class="captcha-heading">
          <label for="captcha">MÃ XÁC NHẬN CAPTCHA</label>
          <button id="refresh" class="refresh-btn" type="button">
            ↻ Làm mới
          </button>
        </div>

        <div class="captcha-row">
          <img id="captchaImage" alt="Mã CAPTCHA">
          <input
            id="captcha"
            name="captcha"
            type="text"
            placeholder="Mã"
            maxlength="5"
            autocomplete="off"
            autocapitalize="characters"
            required
          >
        </div>
      </div>

      <button id="submit" class="submit-btn" type="submit">
        Đăng nhập →
      </button>
    </form>

    <div id="message" role="status" aria-live="polite"></div>

    <section id="account">
      <p class="account-label">TÀI KHOẢN CỦA BẠN</p>
      <strong id="welcome"></strong>
      <p id="points"></p>
      
<button id="adminToggle" type="button" hidden>
  ♛ ADMIN — QUẢN LÝ ĐIỂM
</button>
<section id="adminPanel" hidden>
  <h3>Quản lý điểm người chơi</h3>

  <label for="adminSearch">Tìm username</label>
  <input id="adminSearch" maxlength="50" placeholder="Nhập username cần tìm">
  <button id="adminSearchBtn" type="button">Tìm tài khoản</button>

  <div id="adminResults"></div>

  <label for="targetUsername">Username cần chỉnh</label>
  <input id="targetUsername" placeholder="Chọn tài khoản từ kết quả">

  <label for="pointAction">Thao tác</label>
  <select id="pointAction">
    <option value="add">Cộng điểm</option>
    <option value="subtract">Trừ điểm</option>
    <option value="set">Đặt số điểm mới</option>
  </select>

  <label for="pointAmount">Số điểm</label>
  <input id="pointAmount" type="number" min="0" step="1" value="0">

  <label for="adminConfirm">Nhập lại username để xác nhận</label>
  <input id="adminConfirm" placeholder="Nhập chính xác username">

  <button id="savePoints" type="button">Xác nhận chỉnh điểm</button>
  <button id="closeAdmin" type="button">Đóng bảng quản lý</button>
  <p id="adminMessage" role="status"></p>
</section>
      <button id="logout" type="button">Đăng xuất</button>
    </section>

    <p class="note">
      Điểm chỉ dùng cho mục đích giải trí, không có giá trị tiền thật.
      Hãy bảo vệ thông tin tài khoản của bạn.
    </p>
  </main>
</div>


<script>
const $ = id => document.getElementById(id);

let mode = 'login';
let captchaId = '';

function showMessage(text, ok = false) {
  $('message').textContent = text;
  $('message').className = 'show ' + (ok ? 'ok' : 'bad');
}

function clearMessage() {
  $('message').textContent = '';
  $('message').className = '';
}

function setMode(next) {
  mode = next;

  const registering = mode === 'register';

  $('loginTab').classList.toggle('active', !registering);
  $('registerTab').classList.toggle('active', registering);

  $('confirmWrap').hidden = !registering;
  $('confirmPassword').required = registering;

  $('cardTitle').textContent = registering
    ? 'Tạo tài khoản mới'
    : 'Chào mừng trở lại';

  $('cardDescription').textContent = registering
    ? 'Tạo tài khoản để bắt đầu trải nghiệm.'
    : 'Đăng nhập tài khoản để tiếp tục trải nghiệm.';

  $('submit').textContent = registering
    ? 'Tạo tài khoản →'
    : 'Đăng nhập →';

  $('password').autocomplete = registering
    ? 'new-password'
    : 'current-password';

  clearMessage();
}

$('loginTab').addEventListener('click', () => setMode('login'));
$('registerTab').addEventListener('click', () => setMode('register'));

async function refreshCaptcha() {
  captchaId = '';
  $('captcha').value = '';
  $('captchaImage').removeAttribute('src');
  $('refresh').disabled = true;

  try {
    const response = await fetch('/api/captcha', {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const data = await response.json();

    captchaId = data.id;
    $('captchaImage').src = data.image;
  } catch (err) {
    console.error('CAPTCHA ERROR:', err);
    showMessage('Không tải được CAPTCHA. Hãy thử làm mới.');
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', refreshCaptcha);

$('form').addEventListener('submit', async event => {
  event.preventDefault();

  const username = $('username').value.trim();
  const password = $('password').value;
  const confirmPassword = $('confirmPassword').value;
  const captcha = $('captcha').value.trim();

  if (mode === 'register' && password !== confirmPassword) {
    showMessage('Hai mật khẩu không khớp.');
    return;
  }

  if (!captchaId) {
    showMessage('CAPTCHA chưa sẵn sàng. Hãy thử làm mới.');
    await refreshCaptcha();
    return;
  }

  const currentMode = mode;

  $('submit').disabled = true;
  $('submit').textContent = 'Đang xử lý...';
  clearMessage();

  try {
    const response = await fetch(
      currentMode === 'register' ? '/api/register' : '/api/login',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username,
          password,
          confirmPassword,
          captcha,
          captchaId
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      showMessage(data.error || 'Yêu cầu thất bại.');
    } else if (currentMode === 'register') {
      setMode('login');

      $('username').value = username;
      $('password').value = '';
      $('confirmPassword').value = '';

      showMessage(data.message, true);
        } else {
      window.location.href = '/game';
      return;
    }
  } catch (err) {
    console.error('AUTH ERROR:', err);
    showMessage('Không kết nối được máy chủ. Hãy thử lại.');
  } finally {
    $('submit').disabled = false;
    $('submit').textContent = mode === 'register'
      ? 'Tạo tài khoản →'
      : 'Đăng nhập →';

    await refreshCaptcha();
  }
});

$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;

  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });

    const data = await response.json();

    if (!response.ok) {
      showMessage(data.error || 'Đăng xuất thất bại.');
      return;
    }

    $('account').style.display = 'none';
    $('password').value = '';
    $('confirmPassword').value = '';

    showMessage(data.message, true);
  } catch (err) {
    console.error('LOGOUT ERROR:', err);
    showMessage('Không thể đăng xuất. Hãy thử lại.');
  } finally {
    $('logout').disabled = false;
  }
});


async function checkLogin() {
  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store'
    });

    const data = await response.json();

    console.log('THONG TIN ADMIN:', data);

    if (data.loggedIn) {
      $('account').style.display = 'block';
      $('welcome').textContent = 'Xin chào, ' + data.user.username + '!';
      $('points').textContent = 'Điểm ảo: ' + data.user.points;
    } else {
      $('account').style.display = 'none';
    }
const adminButton = document.getElementById('adminToggle');

console.log('ADMIN DEBUG:', {
  foundButton: !!adminButton,
  loggedIn: data.loggedIn,
  isAdmin: data.isAdmin
});

if (adminButton) {
  const isAdmin = data.loggedIn === true && data.isAdmin === true;
  adminButton.hidden = !isAdmin;
  adminButton.style.display = isAdmin ? 'block' : 'none';
}
  } catch (err) {
    console.error('CHECK LOGIN ERROR:', err);
  }
}

refreshCaptcha();
checkLogin();
</script>
</body>
</html>`);
});

app.get('/game', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }

  const user = db.prepare(
    'SELECT username, points FROM users WHERE id = ?'
  ).get(req.session.userId);

  if (!user) {
    return res.redirect('/');
  }

  const safeName = String(user.username).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);

  const points = Number(user.points) || 0;

  res.type('html').send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SANHDIEU | Sảnh giải trí</title>

<style>
:root {
  --gold: #f8d98b;
  --gold-light: #fff0bd;
  --gold-dark: #9c6b24;
  --bg: #080704;
  --panel: rgba(24, 18, 9, .92);
  --muted: #b6a783;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-height: 100vh;
  padding-bottom: 105px;
  color: #fff8e8;
  font-family: Arial, Helvetica, sans-serif;
  background:
    radial-gradient(ellipse at 50% -15%, #65451c 0%, transparent 48%),
    radial-gradient(ellipse at 0% 45%, #211607 0%, transparent 35%),
    var(--bg);
}

button {
  font: inherit;
  cursor: pointer;
}

.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 100px;
  padding: 16px 4%;
  border-bottom: 1px solid #8c642b;
  background: linear-gradient(
    105deg,
    rgba(7, 6, 4, .98),
    rgba(42, 29, 12, .97),
    rgba(8, 7, 4, .98)
  );
  box-shadow: 0 8px 32px #0008;
}

.brand {
  flex-shrink: 0;
  color: var(--gold);
  font-size: clamp(23px, 3vw, 39px);
  font-weight: 900;
  letter-spacing: 3px;
  text-shadow: 0 0 20px #d39a3e55;
}

.brand small {
  display: block;
  margin-top: 6px;
  color: #d4b77b;
  font-size: 10px;
  letter-spacing: 5px;
  text-align: center;
}

.profile {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 320px;
  padding: 9px 17px 9px 9px;
  border: 1px solid #8b692f;
  border-radius: 50px;
  background: linear-gradient(135deg, #241a0d, #0c0a06);
  box-shadow: inset 0 0 15px #d9a94b0a;
}

.avatar {
  flex-shrink: 0;
  width: 50px;
  height: 50px;
  object-fit: cover;
  border: 2px solid var(--gold);
  border-radius: 50%;
  box-shadow: 0 0 15px #d7a44230;
}

.username {
  overflow: hidden;
  max-width: 190px;
  color: var(--gold-light);
  font-weight: 800;
  text-overflow: ellipsis;
}

.points {
  margin-top: 6px;
  color: #e4d3ac;
  font-size: 13px;
}

.status {
  flex-shrink: 0;
  padding: 10px 14px;
  color: #a6f5a0;
  border: 1px solid #426b35;
  border-radius: 30px;
  background: #10200e;
  font-size: 12px;
  font-weight: 800;
}

.logout {
  flex-shrink: 0;
  padding: 12px 18px;
  color: #251807;
  border: 1px solid #ffe6a4;
  border-radius: 10px;
  background: linear-gradient(135deg, #fff0bd, #d4a54e);
  box-shadow: 0 4px 16px #d39a3e20;
  font-weight: 800;
  transition: .2s ease;
}

.logout:hover {
  transform: translateY(-2px);
  box-shadow: 0 7px 22px #d39a3e40;
}

main {
  width: min(1450px, 92%);
  margin: 0 auto;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: fit-content;
  margin: 30px auto 25px;
  padding: 14px 38px;
  color: var(--gold-light);
  border: 1px solid var(--gold-dark);
  border-radius: 14px;
  background: linear-gradient(135deg, #38270f, #100c06);
  box-shadow:
    0 0 25px #b77b2420,
    inset 0 0 15px #e2b45a0b;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 2px;
}

.banner-link {
  position: relative;
  display: block;
  overflow: hidden;
  border: 1px solid #b68a3c;
  border-radius: 20px;
  background: #171008;
  box-shadow:
    0 15px 40px #0008,
    0 0 25px #bb85252a;
  transition: transform .25s ease, box-shadow .25s ease;
}

.banner-link:hover {
  transform: translateY(-3px);
  box-shadow:
    0 18px 45px #0009,
    0 0 32px #d8a34545;
}

.banner {
  display: block;
  width: 100%;
  aspect-ratio: 3.2 / 1;
  object-fit: cover;
  object-position: center;
  background: #171008;
}

.banner-note {
  margin: 17px 0 32px;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 2px;
  text-align: center;
}

.bottom-nav {
  position: fixed;
  z-index: 100;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  min-height: 84px;
  padding: 9px max(12px, 5%);
  border-top: 1px solid #8b642b;
  background: linear-gradient(
    180deg,
    rgba(31, 22, 10, .98),
    rgba(7, 6, 4, .99)
  );
  box-shadow: 0 -8px 35px #0009;
  backdrop-filter: blur(12px);
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  color: #d9bd80;
  border: 0;
  border-right: 1px solid #4b361b;
  background: transparent;
  font-size: 13px;
  font-weight: 700;
  transition: color .2s ease, background .2s ease;
}

.nav-item:last-child {
  border-right: 0;
}

.nav-icon {
  font-size: 25px;
  transition: transform .2s ease;
}

.nav-item:hover {
  color: var(--gold-light);
  background: linear-gradient(180deg, #d5a24312, transparent);
}

.nav-item:hover .nav-icon {
  transform: translateY(-3px);
}

button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--gold-light);
  outline-offset: 4px;
}

@media (min-width: 1100px) {
  main {
    padding-top: 8px;
  }

  .banner {
    max-height: 460px;
  }
}

@media (max-width: 760px) {
  .topbar {
    gap: 12px;
    padding: 14px 3%;
    flex-wrap: wrap;
  }

  .brand {
    font-size: 25px;
  }

  .brand small {
    font-size: 9px;
    letter-spacing: 3px;
  }

  .profile {
    margin-left: auto;
    gap: 8px;
    padding: 6px 10px 6px 6px;
  }

  .avatar {
    width: 40px;
    height: 40px;
  }

  .username {
    max-width: 125px;
    font-size: 13px;
  }

  .points {
    font-size: 11px;
  }

  .status {
    display: none;
  }

  .logout {
    padding: 10px 12px;
    font-size: 12px;
  }

  main {
    width: 94%;
  }

  .section-title {
    margin: 23px auto 19px;
    padding: 12px 25px;
    font-size: 19px;
  }

  .banner-link {
    border-radius: 14px;
  }

  .banner {
    aspect-ratio: 1.4 / 1;
    object-fit: cover;
  }

  .banner-note {
    font-size: 10px;
    letter-spacing: 1px;
  }

  .bottom-nav {
    min-height: 75px;
    padding: 6px 4px;
  }

  .nav-item {
    gap: 4px;
    font-size: 12px;
  }

  .nav-icon {
    font-size: 23px;
  }
}

@media (max-width: 380px) {
  .brand {
    font-size: 21px;
  }

  .profile {
    max-width: 190px;
  }

  .username {
    max-width: 95px;
  }

  .logout {
    padding: 9px 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}

/* Hiệu ứng banner Baccarat */
.banner {
  transition: transform 0.35s ease,
              filter 0.35s ease,
              box-shadow 0.35s ease;
  transform-origin: center;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .banner:hover {
    transform: scale(1.025);
    filter: brightness(1.12) saturate(1.08);
    box-shadow:
      0 0 18px rgba(245, 206, 114, 0.28),
      0 0 38px rgba(245, 206, 114, 0.12);
  }
}

.banner:active {
  transform: scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
  .banner {
    transition: none;
  }

  .banner:hover,
  .banner:active {
    transform: none;
  }
}

/* ===== SANHDIEU: GOLD PREMIUM EFFECTS ===== */

/* Banner Baccarat */
#baccaratCard {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 18px;
  isolation: isolate;
  transition: transform .35s ease, box-shadow .35s ease;
}

#baccaratCard .banner {
  display: block;
  width: 100%;
  transition: transform .4s ease, filter .4s ease;
}

@media (hover: hover) and (pointer: fine) {
  #baccaratCard:hover {
    transform: translateY(-4px);
    box-shadow:
      0 0 0 1px rgba(245, 206, 114, .8),
      0 0 22px rgba(245, 206, 114, .35),
      0 12px 32px rgba(0, 0, 0, .45);
  }

  #baccaratCard:hover .banner {
    transform: scale(1.025);
    filter: brightness(1.1) saturate(1.08);
  }
}

/* Vệt sáng chạy ngang banner */
#baccaratCard::after {
  content: "";
  position: absolute;
  z-index: 2;
  top: -30%;
  bottom: -30%;
  left: -80%;
  width: 38%;
  pointer-events: none;
  transform: skewX(-22deg);
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 238, 180, .48),
    rgba(255, 255, 255, .16),
    transparent
  );
  animation: goldShine 5s ease-in-out infinite;
}

@keyframes goldShine {
  0%, 55% { left: -80%; }
  100% { left: 140%; }
}

/* Lưới thẻ game */
.game-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin: 24px 0;
}

.game-tile {
  position: relative;
  min-width: 0;
  min-height: 145px;
  padding: 20px 12px;
  overflow: hidden;
  isolation: isolate;
  text-align: center;
  color: #f8e8bd;
  background: linear-gradient(145deg, #21190c, #0d0b07 70%);
  border: 1px solid rgba(205, 158, 65, .42);
  border-radius: 16px;
  cursor: pointer;
  transition:
    transform .28s ease,
    border-color .28s ease,
    box-shadow .28s ease;
}

.game-tile::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: 0;
  opacity: 0;
  background: radial-gradient(
    circle at 50% 0%,
    rgba(245, 206, 114, .25),
    transparent 70%
  );
  transition: opacity .28s ease;
}

.game-tile:hover {
  transform: translateY(-5px);
  border-color: #f5ce72;
  box-shadow: 0 8px 26px rgba(218, 165, 56, .16);
}

.game-tile:hover::before {
  opacity: 1;
}

.game-tile:active {
  transform: scale(.98);
}

.game-icon {
  display: block;
  margin-bottom: 12px;
  font-size: 34px;
  line-height: 1.2;
}

.game-name {
  display: block;
  color: #f5ce72;
  font-weight: 700;
  font-size: 14px;
}

.game-status {
  display: inline-block;
  margin-top: 8px;
  color: #c5b58d;
  font-size: 11px;
}

@media (max-width: 600px) {
  .game-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .game-tile {
    min-height: 125px;
    padding: 16px 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  #baccaratCard,
  #baccaratCard .banner,
  .game-tile,
  .game-tile::before {
    transition: none;
  }

  #baccaratCard::after {
    animation: none;
  }

  .game-tile:hover,
  #baccaratCard:hover {
    transform: none;
  }
}

/* GOLDEN DASHBOARD */
.gold-dashboard {
  position: relative;
  overflow: hidden;
  margin: 24px 0;
  padding: 22px;
  color: #f3e6c4;
  background:
    radial-gradient(ellipse at 100% 0%, rgba(190,145,55,.13), transparent 45%),
    linear-gradient(145deg, #17130b, #090806 72%);
  border: 1px solid rgba(218,180,95,.34);
  border-radius: 20px;
  box-shadow: 0 12px 32px rgba(0,0,0,.25);
}

.gold-dashboard::before {
  content: "";
  position: absolute;
  top: 0;
  left: -100%;
  width: 60%;
  height: 1px;
  background: linear-gradient(90deg, transparent, #f5ce72, transparent);
  animation: dashLight 6s ease-in-out infinite;
}

@keyframes dashLight {
  0%, 35% { left: -100%; }
  75%, 100% { left: 150%; }
}

.dash-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(218,180,95,.16);
  color: #c7ad70;
  font-size: 10px;
  letter-spacing: 2px;
}

.dash-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #eac56b;
  box-shadow: 0 0 10px rgba(234,197,107,.65);
}

.dash-live {
  margin-left: auto;
  color: #b9c99a;
  letter-spacing: 1px;
}

.dash-welcome {
  padding: 24px 0 20px;
}

#dashGreeting {
  color: #d6b56b;
  font-size: 11px;
  letter-spacing: 3px;
}

.dash-welcome h2 {
  margin: 10px 0;
  color: #f5ead0;
  font-size: clamp(20px, 4vw, 28px);
  line-height: 1.5;
  font-weight: 500;
}

.dash-welcome h2 strong {
  color: #f5ce72;
  letter-spacing: 1px;
}

.dash-welcome p {
  margin: 0;
  color: #a99c7d;
  font-size: 12px;
  line-height: 1.7;
}

.dash-clock-panel {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 17px;
  border: 1px solid rgba(218,180,95,.2);
  border-radius: 14px;
  background: rgba(255,255,255,.025);
}

.dash-clock-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 12px;
  color: #f5ce72;
  background: rgba(218,180,95,.09);
  border: 1px solid rgba(218,180,95,.2);
  font-size: 32px;
}

.dash-label {
  margin-bottom: 7px;
  color: #a99568;
  font-size: 9px;
  letter-spacing: 1.8px;
}

.dash-clock {
  color: #ffe5a2;
  font-size: clamp(25px, 5vw, 34px);
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
  font-weight: 600;
}

.dash-date {
  margin-top: 5px;
  color: #b9ad91;
  font-size: 11px;
}

.dash-quote {
  display: flex;
  gap: 13px;
  margin-top: 14px;
  padding: 17px;
  border-left: 2px solid #bd9140;
  background: linear-gradient(90deg, rgba(189,145,64,.09), transparent);
}

.dash-quote-mark {
  color: #f5ce72;
  font-size: 23px;
}

.dash-quote p {
  margin: 0;
  color: #e2d5b8;
  font-size: 12px;
  line-height: 1.7;
}

.dash-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 22px;
  color: #8e7545;
  font-size: 9px;
  letter-spacing: 2px;
}

@media (max-width: 480px) {
  .gold-dashboard {
    padding: 16px;
    margin: 18px 0;
  }

  .dash-clock-panel {
    gap: 12px;
    padding: 13px;
  }

  .dash-clock-icon {
    width: 40px;
    height: 40px;
  }

  .dash-top {
    letter-spacing: 1px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gold-dashboard::before {
    animation: none;
  }
}
.profile-overlay[hidden],
#changePasswordForm[hidden] {
  display: none !important;
}

.profile-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(0, 0, 0, .78);
  backdrop-filter: blur(7px);
}

.profile-modal {
  position: relative;
  width: 100%;
  max-width: 420px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 28px 22px;
  color: #f6e7c1;
  background: linear-gradient(145deg, #17130c, #080808);
  border: 1px solid #bd9140;
  border-radius: 18px;
  box-shadow: 0 0 35px rgba(189, 145, 64, .18);
}

.profile-close {
  position: absolute;
  top: 10px;
  right: 13px;
  width: 36px;
  height: 36px;
  border: 1px solid rgba(245, 206, 114, .35);
  border-radius: 50%;
  color: #f5ce72;
  background: #211a0e;
  font-size: 25px;
  cursor: pointer;
}

.profile-heading {
  color: #f5ce72;
  font-size: 11px;
  letter-spacing: 3px;
}

.profile-modal h2 {
  margin: 10px 0 22px;
  font-size: 23px;
}

.profile-info {
  padding: 6px 14px;
  border: 1px solid rgba(189, 145, 64, .25);
  border-radius: 12px;
  background: rgba(189, 145, 64, .06);
}

.profile-row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px 0;
}

.profile-row + .profile-row {
  border-top: 1px solid rgba(189, 145, 64, .2);
}

.profile-row span,
.profile-modal label {
  color: #b9ad95;
  font-size: 12px;
}

.profile-row strong {
  color: #f5ce72;
  overflow-wrap: anywhere;
}

.profile-action,
.profile-logout {
  width: 100%;
  margin-top: 14px;
  padding: 13px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
}

.profile-action {
  color: #171109;
  background: linear-gradient(100deg, #bd9140, #f5ce72);
  border: none;
}

.profile-logout {
  color: #f0c9b8;
  background: #24120f;
  border: 1px solid #744136;
}

#changePasswordForm {
  margin-top: 16px;
}

#changePasswordForm label {
  display: block;
  margin: 12px 0 6px;
}

#changePasswordForm input {
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  border: 1px solid rgba(189, 145, 64, .4);
  border-radius: 8px;
  color: #fff;
  background: #100e0a;
}

#passwordMessage {
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>

</head>

<body>

<header class="topbar">
  <div class="brand">
    ♛ SANHDIEU
    <small>SẢNH GIẢI TRÍ</small>
  </div>

  <div class="profile">
    <img class="avatar"
         src="/hero-ai.jpg"
         alt="Ảnh đại diện"
         onerror="this.style.display='none'">

    <div>
      <div class="username">${safeName}</div>
      <div class="points">
        Điểm ảo: ${points.toLocaleString('vi-VN')}
      </div>
    </div>
  </div>

  <div class="status">● LIVE</div>

  <button class="logout" id="logout">
    Đăng xuất
  </button>
</header>

<main>
 <div class="section-title">
  🎮 &nbsp; ALL GAME
</div>
<a class="banner-link" href="/baccarat" id="baccaratCard">
  <img
    class="banner"
    src="/baccarat-banner.png"
    alt="Baccarat Multiplayer"
  >
</a>

<p class="banner-note">
  SANHDIEU CLUB · Khu giải trí dùng điểm ảo
</p>
 
<section class="gold-dashboard">
  <div class="dash-top">
    <span class="dash-dot"></span>
    <span>SANHDIEU LOUNGE</span>
    <span class="dash-live">● ONLINE</span>
  </div>

  <div class="dash-welcome">
    <span id="dashGreeting">XIN CHÀO</span>
    <h2>Chào mừng đến với<br><strong>SANHDIEU CLUB</strong></h2>
    <p>Một không gian giải trí mang dấu ấn riêng.</p>
  </div>

  <div class="dash-clock-panel">
    <div class="dash-clock-icon">◷</div>
    <div>
      <div class="dash-label">THỜI GIAN HIỆN TẠI</div>
      <div id="dashClock" class="dash-clock">--:--:--</div>
      <div id="dashDate" class="dash-date">Đang cập nhật ngày tháng...</div>
    </div>
  </div>
<div class="dash-quote">
  <span class="dash-quote-mark">✦</span>
  <div>
    <div class="dash-label">THÔNG ĐIỆP HÔM NAY</div>
    <p id="dashMessage">Nghiêm Cấm Hành Vi Khai Thác Đánh Chéo!.</p>
  </div>
</div>

    <div class="dash-footer">
    <span>✧</span>
    <span>YOUR MOMENT · YOUR STYLE</span>
    <span>✧</span>
  </div>
</section>
</main>

<nav class="bottom-nav" aria-label="Điều hướng">
  <button class="nav-item" data-section="Nạp">
    <span class="nav-icon">💰</span>
    <span>Nạp</span>
  </button>

  <button class="nav-item" data-section="Rút">
    <span class="nav-icon">💳</span>
    <span>Rút</span>
  </button>

  <button class="nav-item" data-section="Thư">
    <span class="nav-icon">✉️</span>
    <span>Thư</span>
  </button>

  <button class="nav-item" data-section="Hồ sơ">
    <span class="nav-icon">👤</span>
    <span>Hồ sơ</span>
  </button>
</nav>
<div id="profileOverlay" class="profile-overlay" hidden>
  <div class="profile-modal" role="dialog" aria-modal="true"
       aria-labelledby="profileTitle">
    <button type="button" id="closeProfile" class="profile-close"
            aria-label="Đóng hồ sơ">×</button>

    <div class="profile-heading">SANHDIEU.CLUB</div>
    <h2 id="profileTitle">Hồ sơ tài khoản</h2>

    <div class="profile-info">
      <div class="profile-row">
        <span>Tên đăng nhập</span>
        <strong id="profileUsername">Đang tải...</strong>
      </div>
      <div class="profile-row">
        <span>Điểm ảo</span>
        <strong id="profilePoints">Đang tải...</strong>
      </div>
    </div>

    <button type="button" id="showPasswordForm" class="profile-action">
      Đổi mật khẩu
    </button>

    <form id="changePasswordForm" hidden>
      <label for="oldPassword">Mật khẩu hiện tại</label>
      <input id="oldPassword" name="oldPassword"
             type="password" autocomplete="current-password" required>

      <label for="newPassword">Mật khẩu mới</label>
      <input id="newPassword" name="newPassword"
             type="password" autocomplete="new-password"
             minlength="8" required>

      <label for="confirmPassword">Nhập lại mật khẩu mới</label>
      <input id="confirmPassword" name="confirmPassword"
             type="password" autocomplete="new-password"
             minlength="8" required>

      <button type="submit" class="profile-action">Xác nhận đổi mật khẩu</button>
      <p id="passwordMessage" role="status"></p>
    </form>

    <button type="button" id="profileLogout" class="profile-logout">
      Đăng xuất
    </button>
  </div>
</div>
<script>
document.getElementById('logout')?.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });

    if (response.ok) {
      window.location.replace('/');
    } else {
      alert('Đăng xuất chưa thành công. Hãy thử lại.');
    }
  } catch (error) {
    alert('Không kết nối được máy chủ.');
  }
});


document.querySelectorAll('[data-section]').forEach(button => {
  button.addEventListener('click', () => {
    const section = button.dataset.section;

    // Hồ sơ đã có popup riêng
    if (section === 'Hồ sơ') return;
// Mở hộp thư — có thể mở lại nhiều lần
if (section === 'Thư') {
  const mailOverlay = document.getElementById('mailMessageOverlay');

  if (mailOverlay) {
    mailOverlay.style.display = 'flex';
    mailOverlay.style.visibility = 'visible';
    mailOverlay.style.pointerEvents = 'auto';
  }

  return;
}

// Nút Nạp: mở hộp hỗ trợ
if (section === 'Nạp') {
  const depositOverlay = document.getElementById('depositOverlay');

  if (depositOverlay) {
    depositOverlay.style.display = 'flex';
  }

  return;
}

// Nút Rút: mở bảng hỗ trợ
if (section === 'Rút') {
  const withdrawOverlay = document.getElementById('withdrawOverlay');

  if (withdrawOverlay) {
    withdrawOverlay.style.display = 'flex';
  }

  return;
}
alert('Chức năng này chưa được chuẩn bị');
});
});


// Nhấn Escape để đóng
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const mailOverlay = document.getElementById('mailMessageOverlay');
    if (mailOverlay) mailOverlay.style.display = 'none';
  }
});

function updateGoldenDashboard() {
  const clock = document.getElementById('dashClock');
  const date = document.getElementById('dashDate');

  const now = new Date();

  if (clock) {
    clock.textContent = now.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  if (date) {
    date.textContent = now.toLocaleDateString('vi-VN', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
  }
}

updateGoldenDashboard();
setInterval(updateGoldenDashboard, 1000);
const profileOverlay = document.getElementById('profileOverlay');

function closeProfile() {
  if (profileOverlay) profileOverlay.hidden = true;
}

document.querySelectorAll('[data-section="Hồ sơ"]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!profileOverlay) return;

    profileOverlay.hidden = false;

    try {
      const response = await fetch('/api/me', {
        credentials: 'same-origin'
      });

      if (!response.ok) throw new Error('Không tải được tài khoản');

const data = await response.json();

if (!data.loggedIn || !data.user) {
  document.getElementById('profileUsername').textContent =
    'Chưa đăng nhập';

  document.getElementById('profilePoints').textContent = '—';
  return;
}

document.getElementById('profileUsername').textContent =
  data.user.username ?? 'Chưa có dữ liệu';

document.getElementById('profilePoints').textContent =
  Number(data.user.points ?? 0).toLocaleString('vi-VN');

    } catch (error) {
      document.getElementById('profileUsername').textContent =
        'Không tải được thông tin';
      document.getElementById('profilePoints').textContent = '—';
    }
  });
});

document.getElementById('closeProfile')
  ?.addEventListener('click', closeProfile);

profileOverlay?.addEventListener('click', event => {
  if (event.target === profileOverlay) closeProfile();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProfile();
});

document.getElementById('showPasswordForm')
  ?.addEventListener('click', () => {
    const form = document.getElementById('changePasswordForm');
    form.hidden = !form.hidden;
  });

document.getElementById('changePasswordForm')
  ?.addEventListener('submit', async event => {
    event.preventDefault();

    const form = event.currentTarget;
    const message = document.getElementById('passwordMessage');
    const submitButton = form.querySelector('button[type="submit"]');

    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword =
      document.getElementById('confirmPassword').value;

    message.textContent = '';
    message.style.color = '#ff9b91';

    if (newPassword !== confirmPassword) {
      message.textContent = 'Hai mật khẩu mới không khớp.';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Đang cập nhật...';

    try {
      const response = await fetch('/api/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          oldPassword,
          newPassword,
          confirmPassword
        })
      });

      const data = await response.json();

      if (!response.ok) {
        message.textContent = data.error || 'Đổi mật khẩu thất bại.';
        return;
      }

      message.style.color = '#8ed6a2';
      message.textContent = data.message || 'Đổi mật khẩu thành công!';

      form.reset();

    } catch (error) {
      console.error('CHANGE PASSWORD ERROR:', error);
      message.textContent = 'Không kết nối được máy chủ.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Xác nhận đổi mật khẩu';
    }
  });

document.getElementById('profileLogout')
  ?.addEventListener('click', async () => {
    if (!confirm('Fen có chắc muốn đăng xuất không?')) return;

    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });

      if (response.ok) {
        window.location.replace('/');
      } else {
        alert('Đăng xuất chưa thành công.');
      }
    } catch (error) {
      alert('Không kết nối được máy chủ.');
    }
  });
 
  // Đóng hộp thư bằng nút Tắt
document.addEventListener('click', function (event) {
  const closeButton = event.target.closest('#closeMailMessage');
  const overlay = document.getElementById('mailMessageOverlay');

  if (closeButton && overlay) {
    event.preventDefault();
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'none';
  }

  // Đóng khi bấm ra ngoài hộp thư
  if (overlay && event.target === overlay) {
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'none';
  }
});
// Đóng hộp thư bằng nút Tắt hoặc bấm ra ngoài
document.addEventListener('click', function (event) {
  const overlay = document.getElementById('mailMessageOverlay');

  if (!overlay) return;

  const closeButton = event.target.closest('#closeMailMessage');

  if (closeButton || event.target === overlay) {
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';
    overlay.style.pointerEvents = 'none';
  }
});
// Đóng hộp hỗ trợ Admin
document.addEventListener('click', function(event) {
  const overlay = document.getElementById('depositOverlay');

  if (!overlay) return;

  if (
    event.target.closest('#closeDeposit') ||
    event.target === overlay
  ) {
    overlay.style.display = 'none';
  }
});
// Đóng bảng hỗ trợ Rút
document.addEventListener('click', function(event) {
  const overlay = document.getElementById('withdrawOverlay');

  if (!overlay) return;

  if (
    event.target.closest('#closeWithdraw') ||
    event.target === overlay
  ) {
    overlay.style.display = 'none';
  }
});
</script>
<!-- HỘP HỖ TRỢ ADMIN -->
<div id="depositOverlay" style="
  display:none;
  position:fixed;
  inset:0;
  z-index:99999;
  background:rgba(0,0,0,.78);
  align-items:center;
  justify-content:center;
  padding:20px;
">
  <div style="
    width:100%;
    max-width:400px;
    background:#151515;
    border:1px solid #d6ad55;
    border-radius:16px;
    padding:24px;
    color:white;
    text-align:center;
    box-shadow:0 0 30px rgba(214,173,85,.2);
  ">
    <h2 style="color:#e6bd62;margin-top:0;">
      ✦ HỖ TRỢ TÀI KHOẢN
    </h2>

    <p style="font-size:14px;line-height:1.8;color:#ddd;">
      Gửi Tên Game Của Bạn Ở Dưới Đây Và Đợi 10 Giây.
    </p>

    <a
      href="https://www.facebook.com/share/1FvZDeVBzK/?mibextid=wwXIfr"
      target="_blank"
      rel="noopener noreferrer"
      style="
        display:block;
        margin-top:20px;
        padding:13px;
        background:linear-gradient(135deg,#f3d889,#b98a32);
        color:#17120a;
        border-radius:9px;
        font-weight:bold;
        text-decoration:none;
      "
    >
      Liên hệ Admin qua Facebook
    </a>

    <button id="closeDeposit" type="button" style="
      margin-top:12px;
      padding:10px 24px;
      background:#292929;
      color:white;
      border:1px solid #555;
      border-radius:8px;
      cursor:pointer;
    ">
      Đóng
    </button>
  </div>
</div>
<!-- BẢNG HỖ TRỢ RÚT -->
<div id="withdrawOverlay" style="
  display:none;
  position:fixed;
  inset:0;
  z-index:100001;
  background:rgba(0,0,0,.78);
  align-items:center;
  justify-content:center;
  padding:20px;
">
  <div style="
    width:100%;
    max-width:400px;
    background:#151515;
    border:1px solid #d6ad55;
    border-radius:16px;
    padding:24px;
    color:white;
    text-align:center;
    box-shadow:0 0 30px rgba(214,173,85,.2);
  ">
    <h2 style="color:#e6bd62;margin-top:0;">
      ✦ HỖ TRỢ TÀI KHOẢN
    </h2>

    <p style="font-size:14px;line-height:1.8;color:#ddd;">
      Chuẩn bị hình ảnh nạp tiền và liên hệ Admin 👑.
    </p>

    <a
      href="https://www.facebook.com/share/1FvZDeVBzK/?mibextid=wwXIfr"
      target="_blank"
      rel="noopener noreferrer"
      style="
        display:block;
        margin-top:20px;
        padding:13px;
        background:linear-gradient(135deg,#f3d889,#b98a32);
        color:#17120a;
        border-radius:9px;
        font-weight:bold;
        text-decoration:none;
      "
    >
      Liên hệ Admin Facebook
    </a>

    <button id="closeWithdraw" type="button" style="
      margin-top:12px;
      padding:10px 24px;
      background:#292929;
      color:white;
      border:1px solid #555;
      border-radius:8px;
      cursor:pointer;
    ">
      Đóng
    </button>
  </div>
</div>
<!-- HỘP THƯ THÔNG BÁO -->
<div id="mailMessageOverlay" style="
  display:none;
  position:fixed;
  inset:0;
  z-index:99999;
  background:rgba(0,0,0,.75);
  align-items:center;
  justify-content:center;
  padding:20px;
">
  <div style="
    width:100%;
    max-width:420px;
    background:#151515;
    border:1px solid #d6ad55;
    border-radius:16px;
    padding:24px;
    color:#fff;
    text-align:center;
    box-shadow:0 0 30px rgba(214,173,85,.2);
  ">
    <h2 style="color:#e6bd62;margin-top:0;">✉ Hộp thư</h2>

    <p style="font-size:16px;line-height:1.7;margin:22px 0;">
  📢 Chào mừng bạn đến với SanhDieu.Club!<br><br>
  ✨ Tặng 75% tiền nạp với mỗi lần nạp không giới hạn!.<br><br>
  🛡️ Đừng quên bảo mật tài khoản và giữ kín thông tin đăng nhập của bạn nhé!<br><br>
  💎 Hệ thống nạp rút chỉ 10 giây và 24/24!
</p>

    <button id="closeMailMessage" type="button" style="
      background:linear-gradient(135deg,#f3d889,#b98a32);
      color:#17120a;
      border:0;
      border-radius:8px;
      padding:10px 28px;
      font-weight:bold;
      cursor:pointer;
    ">Tắt</button>
  </div>
</div>

</body>
</html>`);
});

app.use('/baccarat', require('./routes/baccarat'));
// ==================== START SERVER ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log('SanhDieu.Club đang chạy trên cổng ' + PORT);
});
