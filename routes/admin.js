const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const router = express.Router();

const db = new Database(
  path.join(__dirname, '..', 'sanhdieu-users.sqlite')
);

// Tạo bảng nhật ký nếu chưa tồn tại
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_username TEXT NOT NULL,
    target_username TEXT NOT NULL,
    action TEXT NOT NULL,
    old_points INTEGER NOT NULL,
    new_points INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

// Kiểm tra quyền Admin ở máy chủ
function requireAdmin(req, res, next) {
  const adminUsername = process.env.ADMIN_USERNAME;

  if (!req.session || !req.session.username) {
    return res.status(401).json({
      error: 'Bạn cần đăng nhập trước.'
    });
  }

  if (!adminUsername) {
    return res.status(503).json({
      error: 'Chưa cấu hình ADMIN_USERNAME trên Bonto.'
    });
  }

  if (
    String(req.session.username).toLowerCase() !==
    adminUsername.trim().toLowerCase()
  ) {
    return res.status(403).json({
      error: 'Bạn không có quyền Admin.'
    });
  }

  next();
}

// Tìm người chơi theo username
router.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();

  if (!q || q.length > 50) {
    return res.status(400).json({
      error: 'Hãy nhập username cần tìm (tối đa 50 ký tự).'
    });
  }

  const users = db.prepare(`
    SELECT username, points, created_at
    FROM users
    WHERE username LIKE ? COLLATE NOCASE
    ORDER BY username
    LIMIT 20
  `).all(`%${q}%`);

  res.json({ users });
});

// Cộng, trừ hoặc đặt điểm mới
router.post('/api/admin/user-points', requireAdmin, (req, res) => {
  const { username, action, amount, confirm } = req.body || {};
  const value = Number(amount);

  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > 50 ||
    confirm !== username ||
    !['add', 'subtract', 'set'].includes(action) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return res.status(400).json({
      error: 'Thông tin không hợp lệ hoặc username xác nhận không khớp.'
    });
  }

  try {
    const updatePoints = db.transaction(() => {
      const user = db.prepare(`
        SELECT username, points
        FROM users
        WHERE username = ? COLLATE NOCASE
      `).get(username.trim());

      if (!user) {
        return { error: 'Không tìm thấy tài khoản.' };
      }

      const oldPoints = user.points;
      let newPoints;

      if (action === 'add') newPoints = oldPoints + value;
      if (action === 'subtract') newPoints = oldPoints - value;
      if (action === 'set') newPoints = value;

      if (
        !Number.isSafeInteger(newPoints) ||
        newPoints < 0
      ) {
        return {
          error: 'Số điểm mới không hợp lệ hoặc không đủ điểm để trừ.'
        };
      }

      db.prepare(`
        UPDATE users SET points = ?
        WHERE username = ? COLLATE NOCASE
      `).run(newPoints, user.username);

      db.prepare(`
        INSERT INTO admin_logs
          (admin_username, target_username, action, old_points, new_points)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        req.session.username,
        user.username,
        action,
        oldPoints,
        newPoints
      );

      return {
        username: user.username,
        oldPoints,
        newPoints
      };
    });

    const result = updatePoints();

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Admin update points failed:', error);
    res.status(500).json({
      error: 'Không thể cập nhật điểm lúc này.'
    });
  }
});

// Xem lịch sử chỉnh điểm
router.get('/api/admin/logs', requireAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT admin_username, target_username, action,
           old_points, new_points, created_at
    FROM admin_logs
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json({ logs });
});

module.exports = router;