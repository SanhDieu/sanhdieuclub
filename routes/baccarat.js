const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const router = express.Router();

// Dùng chung cơ sở dữ liệu tài khoản của SanhDieu.Club
const db = new Database(path.join(__dirname, '..', 'sanhdieu-users.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS baccarat_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    choice TEXT NOT NULL,
    chip_value INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_baccarat_predictions_round_user
    ON baccarat_predictions (round_id, user_id);

  CREATE TABLE IF NOT EXISTS baccarat_scores (
    user_id INTEGER PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS baccarat_rounds (
    round_id INTEGER PRIMARY KEY,
    result TEXT NOT NULL,
    player_cards TEXT NOT NULL,
    banker_cards TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Bổ sung cột lưu mức chip dự đoán cho các phiên mới và cũ.
const predictionColumns = db.prepare(`
  PRAGMA table_info(baccarat_predictions)
`).all();

if (!predictionColumns.some(column => column.name === 'chip_value')) {
  db.exec(`
    ALTER TABLE baccarat_predictions
    ADD COLUMN chip_value INTEGER NOT NULL DEFAULT 10
  `);
}

if (!predictionColumns.some(column => column.name === 'created_at')) {
  db.exec(`
    ALTER TABLE baccarat_predictions
    ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0
  `);
}

// ---------------------------------------------------------------------------
// MIGRATION: bảng cũ có ràng buộc UNIQUE(round_id, user_id) nên mỗi người chỉ
// đặt được 1 lần / phiên. Ta dựng lại bảng để cho phép đặt nhiều lần.
// ---------------------------------------------------------------------------
function dropLegacyUniquePredictionIndex() {
  const indexes = db.prepare(`PRAGMA index_list(baccarat_predictions)`).all();

  const legacy = indexes.find(index => {
    if (!index.unique) return false;
    const columns = db
      .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all()
      .map(column => column.name);

    return (
      columns.length === 2 &&
      columns.includes('round_id') &&
      columns.includes('user_id')
    );
  });

  if (!legacy) return;

  db.exec(`
    ALTER TABLE baccarat_predictions RENAME TO baccarat_predictions_legacy;

    CREATE TABLE baccarat_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      choice TEXT NOT NULL,
      chip_value INTEGER NOT NULL DEFAULT 10,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO baccarat_predictions (id, round_id, user_id, choice, chip_value, created_at)
    SELECT id, round_id, user_id, choice, chip_value, 0
    FROM baccarat_predictions_legacy;

    DROP TABLE baccarat_predictions_legacy;

    CREATE INDEX IF NOT EXISTS idx_baccarat_predictions_round_user
      ON baccarat_predictions (round_id, user_id);
  `);

  console.log('[baccarat] Đã gỡ ràng buộc UNIQUE(round_id, user_id): cho phép đặt nhiều lần / phiên.');
}

dropLegacyUniquePredictionIndex();

const CHIP_VALUES = [10, 20, 50, 100, 500, 1000];

const MULTIPLIERS = {
  player: 1.95,
  banker: 1.95,
  tie: 7
};

const CHOICES = ['player', 'tie', 'banker'];
const SIDE_CHOICES = ['player', 'banker'];

const LABELS = {
  player: 'Tay con',
  tie: 'Hòa',
  banker: 'Nhà cái'
};

function getUserScore(userId) {
  const row = db.prepare(`SELECT score FROM baccarat_scores WHERE user_id = ?`).get(userId);
  if (!row) {
    db.prepare(`INSERT INTO baccarat_scores (user_id, score) VALUES (?, 0)`).run(userId);
    return 0;
  }
  return row.score;
}

function deductScore(userId, amount) {
  const current = getUserScore(userId);
  if (current < amount) return false;
  db.prepare(`UPDATE baccarat_scores SET score = score - ? WHERE user_id = ?`).run(amount, userId);
  return true;
}

function addScore(userId, amount) {
  if (!amount) return;

  const exists = db.prepare(`SELECT 1 FROM baccarat_scores WHERE user_id = ?`).get(userId);
  if (exists) {
    db.prepare(`UPDATE baccarat_scores SET score = score + ? WHERE user_id = ?`).run(amount, userId);
  } else {
    db.prepare(`INSERT INTO baccarat_scores (user_id, score) VALUES (?, ?)`).run(userId, amount);
  }
}

// Trả thưởng cho TẤT CẢ các lần đặt của phiên (mỗi dòng là 1 lần đặt).
// Luật Hòa: cửa Tay con / Nhà cái được HOÀN LẠI đúng số điểm đã đặt
//          (không thắng, không thua), cửa Hòa ăn x7.
function payoutRound(roundId, result) {
  const predictions = db.prepare(`
    SELECT user_id, choice, chip_value
    FROM baccarat_predictions
    WHERE round_id = ?
  `).all(roundId);

  for (const pred of predictions) {
    // Hòa -> hoàn cược cho 2 bên Tay con / Nhà cái
    if (result === 'tie' && SIDE_CHOICES.includes(pred.choice)) {
      addScore(pred.user_id, pred.chip_value);
      continue;
    }

    if (pred.choice !== result) continue;

    const winAmount = Math.floor(pred.chip_value * MULTIPLIERS[pred.choice]);
    if (winAmount <= 0) continue;

    addScore(pred.user_id, winAmount);
  }
}

const BETTING_SECONDS = 30;
const REVEAL_SECONDS = 13;
const RESULT_HOLD_SECONDS = 8;

const ROUND_SECONDS =
  BETTING_SECONDS + REVEAL_SECONDS + RESULT_HOLD_SECONDS;

let roundId = Date.now();
let roundStartedAt = Date.now();
let phase = 'waiting';
let result = null;
let playerCards = [];
let bankerCards = [];
let forcedResult = null; // Admin ép kết quả

function card() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const rank = ranks[Math.floor(Math.random() * ranks.length)];

  let value = Number(rank);
  if (rank === 'A') value = 1;
  if (['J', 'Q', 'K', '10'].includes(rank)) value = 0;

  return {
    rank,
    suit: suits[Math.floor(Math.random() * suits.length)],
    value
  };
}

function total(cards) {
  return cards.reduce((sum, item) => sum + item.value, 0) % 10;
}

function shouldDrawBanker(bankerScore, playerThirdCard) {
  if (playerThirdCard === null) {
    return bankerScore <= 5;
  }

  if (bankerScore <= 2) return true;
  if (bankerScore === 3) return playerThirdCard !== 8;
  if (bankerScore === 4) return playerThirdCard >= 2 && playerThirdCard <= 7;
  if (bankerScore === 5) return playerThirdCard >= 4 && playerThirdCard <= 7;
  if (bankerScore === 6) return playerThirdCard === 6 || playerThirdCard === 7;

  return false;
}

function outcomeFromCards(cardsP, cardsB) {
  const p = total(cardsP);
  const b = total(cardsB);
  if (p > b) return 'player';
  if (b > p) return 'banker';
  return 'tie';
}

function dealRandomHand() {
  const nextPlayer = [card(), card()];
  const nextBanker = [card(), card()];

  const playerScore = total(nextPlayer);
  const bankerScore = total(nextBanker);

  if ([8, 9].includes(playerScore) || [8, 9].includes(bankerScore)) {
    return { playerCards: nextPlayer, bankerCards: nextBanker };
  }

  let playerThirdCard = null;

  if (playerScore <= 5) {
    const third = card();
    nextPlayer.push(third);
    playerThirdCard = third.value;
  }

  if (shouldDrawBanker(bankerScore, playerThirdCard)) {
    nextBanker.push(card());
  }

  return { playerCards: nextPlayer, bankerCards: nextBanker };
}

function fallbackHand(target) {
  const make = (rank, suit) => {
    let value = Number(rank);
    if (rank === 'A') value = 1;
    if (['J', 'Q', 'K', '10'].includes(rank)) value = 0;
    return { rank, suit, value };
  };

  if (target === 'player') {
    return {
      playerCards: [make('4', '♠'), make('5', '♥')],
      bankerCards: [make('3', '♣'), make('5', '♦')]
    };
  }

  if (target === 'banker') {
    return {
      playerCards: [make('3', '♠'), make('4', '♥')],
      bankerCards: [make('4', '♣'), make('5', '♦')]
    };
  }

  return {
    playerCards: [make('3', '♠'), make('5', '♥')],
    bankerCards: [make('4', '♣'), make('4', '♦')]
  };
}

function handForOutcome(target) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const hand = dealRandomHand();
    if (outcomeFromCards(hand.playerCards, hand.bankerCards) === target) {
      return hand;
    }
  }
  return fallbackHand(target);
}

function getResult() {
  return outcomeFromCards(playerCards, bankerCards);
}

function dealCards() {
  const target = forcedResult;
  forcedResult = null;

  const hand = target ? handForOutcome(target) : dealRandomHand();
  playerCards = hand.playerCards;
  bankerCards = hand.bankerCards;
}

function finishRound() {
  result = getResult();
  phase = 'result';

  db.prepare(`
    INSERT OR REPLACE INTO baccarat_rounds
    (round_id, result, player_cards, banker_cards, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    roundId,
    result,
    JSON.stringify(playerCards),
    JSON.stringify(bankerCards),
    Date.now()
  );

  // Trả điểm cho người đoán đúng
  payoutRound(roundId, result);

  const completedCount = db.prepare(`SELECT COUNT(*) AS total FROM baccarat_rounds`).get().total;
  if (completedCount >= 60) {
    db.prepare('DELETE FROM baccarat_rounds').run();
  }

  // Dọn dự đoán của các phiên rất cũ (bảng giờ có thể nhiều dòng / người / phiên).
  db.prepare('DELETE FROM baccarat_predictions WHERE round_id < ?').run(roundId - 100);
}

function startNextRound() {
  roundId++;
  roundStartedAt = Date.now();
  phase = 'waiting';
  result = null;
  playerCards = [];
  bankerCards = [];
}

function updateRound() {
  const elapsed = (Date.now() - roundStartedAt) / 1000;

  // Hết 30 + 13 + 8 giây thì bắt đầu phiên mới.
  if (elapsed >= ROUND_SECONDS) {
    startNextRound();
    return;
  }

  // 30 giây đầu: cho phép dự đoán.
  if (elapsed < BETTING_SECONDS) {
    phase = 'waiting';
    return;
  }

  // 13 giây tiếp theo: lật bài.
  if (elapsed < BETTING_SECONDS + REVEAL_SECONDS) {
    if (phase === 'waiting') {
      dealCards();
      phase = 'revealing';
    }
    return;
  }

  // Sau khi lật bài xong: công bố kết quả trong 8 giây.
  if (phase !== 'result') {
    finishRound();
  }
}

// Máy chủ tự chạy phiên liên tục
setInterval(updateRound, 250);

// Kiểm tra đăng nhập
router.use((req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/');
  }
  next();
});

// ---------------------------------------------------------------------------
// HELPERS cho luật đặt cược nhiều lần trong 1 phiên
// ---------------------------------------------------------------------------
function getMyBets(currentRoundId, userId) {
  return db.prepare(`
    SELECT id, choice, chip_value
    FROM baccarat_predictions
    WHERE round_id = ? AND user_id = ?
    ORDER BY id
  `).all(currentRoundId, userId);
}

function summarizeBets(bets) {
  const summary = { player: 0, banker: 0, tie: 0 };
  for (const bet of bets) {
    if (summary[bet.choice] === undefined) continue;
    summary[bet.choice] += bet.chip_value;
  }
  const stake = bets.reduce((sum, bet) => sum + bet.chip_value, 0);
  return { ...summary, stake };
}

// Cửa "bên" (con/cái) mà người chơi đã đặt trong phiên, null nếu chưa đặt bên nào.
function lockedSide(bets) {
  const side = bets.find(bet => SIDE_CHOICES.includes(bet.choice));
  return side ? side.choice : null;
}

router.get('/', (req, res) => {
  const user = db.prepare('SELECT username FROM users WHERE id = ?')
    .get(req.session.userId);

  if (!user) return res.redirect('/');

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baccarat Multiplayer - SanhDieu.Club</title>
<style>
*{box-sizing:border-box}
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(ellipse at 50% 20%, #17633f 0%, #092c20 48%, #04130e 100%);
  color: #fff;
  font-family: Arial, sans-serif;
}

.wrap {
  max-width: 1200px;
  margin: auto;
  padding: 20px;
}

.table {
  background:
    radial-gradient(ellipse at center, #16804c 0%, #075331 65%, #04351f 100%);
  border: 7px solid #a9843b;
  border-radius: 45% / 18%;
  padding: 32px 24px;
  box-shadow: 0 15px 45px #0009, inset 0 0 25px #ffffff16;
}

.side {
  min-height: 205px;
  background: #062d20cc;
  border: 2px solid #d5b45e;
  border-radius: 20px;
  padding: 20px;
}
.card {
  width: 68px;
  height: 96px;
  border: 2px solid #eee2c9;
  border-radius: 10px;
  font-size: 26px;
  animation: none !important;
  transition: none !important;
}

.chip-area {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 15px;
  padding: 22px;
  margin: 18px 0;
  border-radius: 18px;
  background: #041e16;
  border: 1px solid #a9843b;
}

.chip {
  width: 72px;
  height: 72px;
  border: 6px dashed #fff;
  border-radius: 50%;
  display: grid;
  place-items: center;
  box-shadow: 0 5px 12px #0008;
}

.chip span {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: #fff;
  color: #171717;
  display: grid;
  place-items: center;
  font-weight: 900;
}

.chip.blue { background: #2452c5; }
.chip.red { background: #c52c35; }
.chip.green { background: #32934b; }
.chip.gold { background: #d6a32e; }
.chip.purple { background: #7547b8; }
.chip.black { background: #252525; }
.top{height:58px;background:#101b19;display:flex;align-items:center;
justify-content:space-between;padding:0 16px;border-bottom:1px solid #b99a48}
.top strong{color:#e9ca75;letter-spacing:2px}
.top a{color:white;text-decoration:none;background:#263d34;padding:10px 15px;border-radius:9px}
.wrap{max-width:1100px;margin:auto;padding:12px}
.table{background:linear-gradient(145deg,#087044,#03462d);border:5px solid #9a7838;
border-radius:22px;padding:18px;box-shadow:0 12px 35px #0008}
.head{text-align:center;color:#ffe39a;font-weight:bold;letter-spacing:2px}
.status{text-align:center;margin:12px 0;color:#fff0b5}
.clock{font-size:42px;font-weight:bold;text-align:center;color:#ffe27b}
.players{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:15px}
.side{background:#062e22;border:2px solid #b69b54;border-radius:14px;padding:14px;text-align:center}
.side h2{margin:3px 0 12px}
.cards{height:105px;display:flex;justify-content:center;align-items:center;gap:8px}
.card{background:#fff;color:#171717;border-radius:9px;width:65px;height:88px;
display:flex;align-items:center;justify-content:center;font-size:25px;font-weight:bold;
box-shadow:0 4px 9px #0008}
.red{color:#d52222}
.score{font-size:25px;color:#ffe17b;margin-top:8px}
.choices{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:15px}
.choice{
  border:2px solid #c5a653;
  border-radius:12px;
  padding:14px 5px 10px;
  font-size:18px;
  font-weight:bold;
  color:white;
  cursor:pointer;
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:4px;
  position:relative;
}
.choice .odds{
  font-size:13px;
  font-weight:700;
  opacity:0.9;
  background:rgba(0,0,0,0.25);
  padding:2px 8px;
  border-radius:6px;
}
.choice:disabled{opacity:.45;cursor:not-allowed}
.player{background:#1466a5}
.tie{background:#3d9142}
.banker{background:#a41f25}
.choice.selected{outline:4px solid #ffe37b}
.message{text-align:center;min-height:28px;margin:12px 0;color:#ffe69a}
.chip-area {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 17px;
  padding: 18px 8px;
  margin-top: 12px;
  background: linear-gradient(180deg, #063c2a, #052b20);
  border-radius: 15px;
}

.chip {
  width: 82px;
  height: 82px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  position: relative;
  border: 7px dashed #fff;
  box-shadow: 0 5px 12px #0008, inset 0 0 0 4px #ffffff70;
}

.chip span {
  width: 53px;
  height: 53px;
  border-radius: 50%;
  background: #fff;
  color: #171717;
  display: grid;
  place-items: center;
  font-size: 19px;
  font-weight: 900;
}

.chip.blue { background: #243eaa; }
.chip.gold { background: #d99a16; }
.chip.green { background: #65a52a; }
.chip.teal { background: #08a58c; }
.chip.cyan { background: #159dc4; }
.chip.purple { background: #7444bd; }

@media(max-width:600px) {
  .chip {
    width: 62px;
    height: 62px;
    border-width: 5px;
  }
  .chip span {
    width: 40px;
    height: 40px;
    font-size: 15px;
  }
}
.history,.ranking{background:#102a21;border:1px solid #92783d;border-radius:12px;
padding:13px;margin-top:14px}
.history-list{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.dot{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:bold}
.dot.player{background:#1674c5}.dot.banker{background:#c3262e}.dot.tie{background:#319c56}
table{width:100%;border-collapse:collapse;margin-top:10px}
td,th{padding:9px;border-bottom:1px solid #355347;text-align:left}
.muted{color:#b7c9bd;font-size:13px;text-align:center;margin:15px}
@media(max-width:600px){
 .wrap{padding:7px}.table{padding:10px}
 .card{width:48px;height:72px;font-size:21px}
 .cards{height:82px}.choice{font-size:15px;padding:14px 2px}
 .clock{font-size:35px}
}
.confirm-button {
  display: block;
  width: 100%;
  max-width: 360px;
  margin: 18px auto;
  padding: 15px;
  border: 2px solid #f4d77f;
  border-radius: 12px;
  background: linear-gradient(135deg, #d5a83e, #8c6420);
  color: #17120a;
  font-size: 17px;
  font-weight: 900;
  cursor: pointer;
}

.confirm-button:disabled {
  opacity: .45;
  cursor: not-allowed;
}
.chip {
  cursor: pointer;
  transition: transform .16s ease, box-shadow .16s ease;
}

.chip:hover:not(:disabled) {
  transform: translateY(-3px);
}

.chip:active:not(:disabled) {
  transform: scale(.96);
}

.chip.active {
  transform: translateY(-12px);
  box-shadow: 0 17px 22px #000b, 0 0 0 3px #ffe27b;
}

.chip:disabled {
  cursor: not-allowed;
  opacity: .65;
}

/* ===== Bảng đặt cược nhiều lần trong phiên ===== */
.bets {
  max-width: 620px;
  margin: 4px auto 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: #052a1f;
  border: 1px dashed #7d6531;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  font-size: 14px;
  color: #d8e7dd;
}

.bet-pill {
  padding: 6px 12px;
  border-radius: 999px;
  font-weight: 700;
  background: #1c3a2e;
  border: 1px solid #4d6b5c;
}

.bet-pill.player { background: #0f4d7d; border-color: #2f8fd0; }
.bet-pill.banker { background: #7a1a1f; border-color: #d05a60; }
.bet-pill.tie { background: #246b33; border-color: #4fbb6c; }
.bet-pill.total {
  background: #3a3111;
  border-color: #e0c168;
  color: #ffe27b;
}

.bet-empty {
  color: #93a99c;
  font-style: italic;
  text-align: center;
}

.choice .bet-badge {
  position: absolute;
  top: -10px;
  right: -8px;
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border-radius: 999px;
  background: #ffe27b;
  color: #241a00;
  font-size: 13px;
  font-weight: 900;
  display: none;
  align-items: center;
  justify-content: center;
  box-shadow: 0 3px 8px #0008;
}

.choice.has-bet .bet-badge { display: flex; }

.hint {
  text-align: center;
  font-size: 13px;
  color: #a9c3b4;
  margin: 8px auto 0;
  max-width: 620px;
  line-height: 1.5;
}
</style>
</head>
<body>
<div class="top">
  <strong>SANHDIEU.CLUB</strong>
  <div style="display:flex;align-items:center;gap:12px;">
    <span id="userScore" style="color:#ffe27b;font-weight:bold;font-size:15px;background:#1a2e26;padding:7px 14px;border-radius:8px;border:1px solid #b99a48;">
      Điểm: --
    </span>

    ${user.username === 'uganh17' ? `
    <button id="adminBtn" style="background:#c0392b;color:white;border:none;padding:8px 14px;border-radius:8px;font-weight:bold;cursor:pointer;">
      ADMIN
    </button>
    ` : ''}

    <a href="/game">← Thoát</a>
  </div>
</div>

<div class="wrap">
<div class="table">
<div class="head">Entertainment Lounge</div>
<div class="status" id="status">Đang kết nối bàn chơi...</div>
<div class="clock" id="clock">--</div>

<div class="players">
<div class="side">
<h2 style="color:#55baff">TAY CON</h2>
<div class="cards" id="playerCards">
<div class="card">?</div><div class="card">?</div>
</div>
<div class="score" id="playerScore">-</div>
</div>
<div class="side">
<h2 style="color:#ff7777">NHÀ CÁI</h2>
<div class="cards" id="bankerCards">
<div class="card">?</div><div class="card">?</div>
</div>
<div class="score" id="bankerScore">-</div>
</div>
</div>
</div>
<div class="chip-area" id="chipArea">
  <button type="button" class="chip blue" data-chip="10"><span>10</span></button>
  <button type="button" class="chip red" data-chip="20"><span>20</span></button>
  <button type="button" class="chip green" data-chip="50"><span>50</span></button>
  <button type="button" class="chip gold" data-chip="100"><span>100</span></button>
  <button type="button" class="chip purple" data-chip="500"><span>500</span></button>
  <button type="button" class="chip black" data-chip="1000"><span>1.000</span></button>
</div>
<h3 style="text-align:center;color:#f4d77f">CHỌN DỰ ĐOÁN</h3>
<div class="choices">
  <button class="choice player" data-choice="player">
    <span class="bet-badge" data-badge="player">0</span>
    Tay con
    <span class="odds">x1.95</span>
  </button>
  <button class="choice tie" data-choice="tie">
    <span class="bet-badge" data-badge="tie">0</span>
    Hòa
    <span class="odds">x7</span>
  </button>
  <button class="choice banker" data-choice="banker">
    <span class="bet-badge" data-badge="banker">0</span>
    Nhà cái
    <span class="odds">x1.95</span>
  </button>
</div>
<button type="button" id="confirmButton" class="confirm-button" disabled>
  XÁC NHẬN DỰ ĐOÁN
</button>
<div class="bet-empty" id="emptyBets" style="display:block"></div>
<div class="bets" id="myBets"></div>
<div class="hint">
 Bắt đầu đặt cược , chúc ông chủ may mắn nhé!.
</div>

<div class="message" id="message">
  Chọn kết quả bạn dự đoán cho phiên này.
</div>

<div class="history">
<strong>LỊCH SỬ CÁC PHIÊN</strong>
<div class="history-list" id="history"></div>
</div>

<div class="muted">
Xin chào ${String(user.username).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}.
Bắt đầu đặt cược , chúc ông chủ may mắn nhé!.
</div>
</div>
<!-- Admin Panel -->
<div id="adminPanel" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:9999; align-items:center; justify-content:center;">
  <div style="background:#0f2a20; border:2px solid #d4af37; border-radius:16px; padding:28px; width:90%; max-width:420px; color:white;">
    <h2 style="margin:0 0 18px; color:#f4d77f; text-align:center;">ADMIN - Điều chỉnh điểm</h2>
    
    <div style="margin-bottom:14px;">
      <label style="display:block; margin-bottom:6px; color:#ccc;">Tên tài khoản</label>
      <input id="adminUsername" type="text" placeholder="Nhập username..." style="width:100%; padding:11px; border-radius:8px; border:1px solid #555; background:#1a1a1a; color:white; font-size:15px;">
    </div>

    <div style="margin-bottom:18px;">
      <label style="display:block; margin-bottom:6px; color:#ccc;">Số điểm (+ là cộng, - là trừ)</label>
      <input id="adminAmount" type="number" placeholder="Ví dụ: 500 hoặc -200" style="width:100%; padding:11px; border-radius:8px; border:1px solid #555; background:#1a1a1a; color:white; font-size:15px;">
    </div>
<hr style="border-color:#444; margin: 20px 0;">

<h3 style="color:#f4d77f; margin-bottom:12px; text-align:center;">Ép kết quả phiên</h3>

<div style="display:flex; gap:8px; margin-bottom:16px;">
  <button type="button" class="force-btn" data-force="player" style="flex:1; padding:10px; background:#1466a5; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">
    Tay con
  </button>
  <button type="button" class="force-btn" data-force="tie" style="flex:1; padding:10px; background:#3d9142; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">
    Hòa
  </button>
  <button type="button" class="force-btn" data-force="banker" style="flex:1; padding:10px; background:#a41f25; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">
    Nhà cái
  </button>
</div>
    <div style="display:flex; gap:12px;">
      <button id="adminConfirm" style="flex:1; padding:12px; background:#27ae60; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">
        Xác nhận
      </button>
      <button id="adminClose" style="flex:1; padding:12px; background:#7f8c8d; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">
        Đóng
      </button>
    </div>

    <div id="adminMessage" style="margin-top:14px; text-align:center; min-height:22px; color:#f1c40f;"></div>
  </div>
</div>

<script>
let currentRound = 0;
let selected = null;
let selectedChip = null;
let roundBets = [];        // [{ id, choice, chip_value }] trong phiên hiện tại
let phaseLocked = false;   // true khi hết 30s đặt cược

const labels = {
  player: 'Tay con',
  tie: 'Hòa',
  banker: 'Nhà cái'
};

const SIDES = ['player', 'banker'];

function makeCard(item) {
  const isRed = item.suit === '♥' || item.suit === '♦';

  return '<div class="card ' + (isRed ? 'red' : '') + '">' +
    escapeHtml(item.rank) + escapeHtml(item.suit) +
    '</div>';
}

function betSum(choice) {
  return roundBets
    .filter(b => b.choice === choice)
    .reduce((sum, b) => sum + b.chip_value, 0);
}

function totalStake() {
  return roundBets.reduce((sum, b) => sum + b.chip_value, 0);
}

// Bên (con/cái) người chơi đã đặt trong phiên này
function placedSide() {
  const bet = roundBets.find(b => SIDES.indexOf(b.choice) !== -1);
  return bet ? bet.choice : null;
}

// Cửa này có bị luật chặn không (đã đặt bên còn lại)
function isBlocked(choice) {
  if (SIDES.indexOf(choice) === -1) return false;
  const side = placedSide();
  return !!side && side !== choice;
}

function renderBets() {
  const box = document.getElementById('myBets');
  const empty = document.getElementById('emptyBets');

  document.querySelectorAll('.bet-badge').forEach(badge => {
    const value = betSum(badge.dataset.badge);
    badge.textContent = value.toLocaleString('vi-VN');
  });

  document.querySelectorAll('.choice').forEach(button => {
    button.classList.toggle('has-bet', betSum(button.dataset.choice) > 0);
  });

  if (!roundBets.length) {
    box.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'Phiên này bạn chưa đặt cửa nào.';
    return;
  }

  empty.style.display = 'none';

  const order = ['player', 'banker', 'tie'];
  let html = '';

  order.forEach(choice => {
    const bets = roundBets.filter(b => b.choice === choice);
    if (!bets.length) return;

    html += '<span class="bet-pill ' + choice + '">' +
      labels[choice] + ': ' + betSum(choice).toLocaleString('vi-VN') +
      (bets.length > 1 ? ' (' + bets.length + ' lần)' : '') +
      '</span>';
  });

  html += '<span class="bet-pill total">Tổng đặt: ' +
    totalStake().toLocaleString('vi-VN') + '</span>';

  box.innerHTML = html;
}

function renderSelection() {
  document.querySelectorAll('.choice').forEach(button => {
    const choice = button.dataset.choice;

    button.classList.toggle('selected', choice === selected);
    button.disabled = phaseLocked || isBlocked(choice);
  });

  document.querySelectorAll('.chip[data-chip]').forEach(button => {
    button.classList.toggle(
      'active',
      Number(button.dataset.chip) === selectedChip
    );
    button.disabled = phaseLocked;
  });

  document.getElementById('confirmButton').disabled =
    phaseLocked || !selected || !selectedChip || isBlocked(selected);

  renderBets();
}

// Chọn chip
document.querySelectorAll('.chip[data-chip]').forEach(button => {
  button.addEventListener('click', () => {
    if (phaseLocked) return;

    selectedChip = Number(button.dataset.chip);
    renderSelection();
  });
});

// Chọn cửa
document.querySelectorAll('.choice').forEach(button => {
  button.addEventListener('click', () => {
    const choice = button.dataset.choice;
    if (phaseLocked) return;

    if (isBlocked(choice)) {
      document.getElementById('message').textContent =
        'Mỗi phiên chỉ được đặt một bên. Bạn đã đặt ' +
        labels[placedSide()] + ' rồi, chỉ có thể đặt thêm Hòa.';
      return;
    }

    selected = choice;
    renderSelection();
  });
});

// Xác nhận dự đoán (gọi được nhiều lần trong cùng 1 phiên)
async function predict() {
  const message = document.getElementById('message');

  if (!selected || !selectedChip) {
    message.textContent = 'Vui lòng chọn chip và cửa dự đoán.';
    return;
  }

  const button = document.getElementById('confirmButton');
  button.disabled = true;

  try {
    const response = await fetch('/baccarat/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choice: selected,
        chipValue: selectedChip
      })
    });

    const data = await response.json();
    message.textContent = data.message;

    if (data.ok) {
      if (Array.isArray(data.myBets)) {
        roundBets = data.myBets;
      }
      if (typeof data.myScore === 'number') {
        document.getElementById('userScore').textContent =
          'Điểm: ' + data.myScore.toLocaleString('vi-VN');
      }
      // Đã đặt bên con/cái thì tự bỏ chọn cửa bên kia
      if (isBlocked(selected)) selected = phaseLocked ? null : selected;
    }
  } catch (err) {
    message.textContent = 'Không thể kết nối máy chủ.';
  }

  renderSelection();
}

document.getElementById('confirmButton')
  .addEventListener('click', predict);

function applyPhaseLock(locked) {
  phaseLocked = locked;

  if (locked) {
    selected = null;
    selectedChip = null;
  }
}

async function refresh() {
  try {
    const response = await fetch('/baccarat/api/state');
    const data = await response.json();

    if (typeof data.myScore === 'number') {
      document.getElementById('userScore').textContent =
        'Điểm: ' + data.myScore.toLocaleString('vi-VN');
    }

    if (currentRound !== data.roundId) {
      currentRound = data.roundId;
      selected = null;
      selectedChip = null;
    }

    // Luôn đồng bộ danh sách đặt cược từ server (có thể đặt nhiều lần)
    roundBets = Array.isArray(data.myBets) ? data.myBets : [];

    applyPhaseLock(data.phase !== 'waiting');

    document.getElementById('clock').textContent =
      data.phase === 'waiting' ? data.remaining + 's' : '';

    const status = data.phase === 'waiting'
      ? 'ĐANG NHẬN CƯỢC'
      : data.phase === 'revealing'
      ? 'ĐANG LẬT BÀI...'
      : 'KẾT QUẢ PHIÊN #' + data.roundId;

    document.getElementById('status').textContent = status;

    renderSelection();

    if (data.phase === 'revealing' || data.phase === 'result') {
      const revealKey =
        data.playerCards.map(c => c.rank + c.suit).join(',') +
        '|' +
        data.bankerCards.map(c => c.rank + c.suit).join(',');

      if (window.lastRevealKey !== revealKey) {
        window.lastRevealKey = revealKey;

        document.getElementById('playerCards').innerHTML =
          data.playerCards.map(makeCard).join('');

        document.getElementById('bankerCards').innerHTML =
          data.bankerCards.map(makeCard).join('');
      }

      if (data.phase === 'result') {
        document.getElementById('playerScore').textContent =
          data.playerTotal;

        document.getElementById('bankerScore').textContent =
          data.bankerTotal;

        let text = 'Kết quả: ' + labels[data.result];

        if (roundBets.length) {
          const win = Number(data.myWinAmount) || 0;
          const refund = Number(data.myRefund) || 0;

          if (refund > 0) {
            text += ' · Hoàn lại ' + refund.toLocaleString('vi-VN') +
              ' điểm đã đặt Tay con/Nhà cái';
          }

          if (win > 0) {
            text += ' · Thắng ' + win.toLocaleString('vi-VN') +
              ' điểm (đặt ' + totalStake().toLocaleString('vi-VN') + ')';
          }

          if (!win && !refund) {
            text += ' · Lần này chưa chính xác.';
          }
        }

        document.getElementById('message').textContent = text;
      } else {
        document.getElementById('playerScore').textContent = '-';
        document.getElementById('bankerScore').textContent = '-';
        document.getElementById('message').textContent =
          'Đang lần lượt lật các lá bài...';
      }
    } else {
      window.lastRevealKey = '';

      document.getElementById('playerCards').innerHTML =
        '<div class="card">?</div><div class="card">?</div>';

      document.getElementById('bankerCards').innerHTML =
        '<div class="card">?</div><div class="card">?</div>';

      document.getElementById('playerScore').textContent = '-';
      document.getElementById('bankerScore').textContent = '-';
    }

    document.getElementById('history').innerHTML = data.history.map(item =>
      '<div class="dot '+item.result+'" title="Phiên '+item.round_id+'">'+
      (item.result === 'player' ? 'P' : item.result === 'banker' ? 'B' : 'T')+
      '</div>'
    ).join('');

  } catch (error) {
    console.error('Lỗi cập nhật bàn Baccarat:', error);
    document.getElementById('status').textContent =
      'Lỗi cập nhật bàn — mở Console để xem chi tiết.';
}
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// ===== ADMIN =====
const adminBtn = document.getElementById('adminBtn');
const adminPanel = document.getElementById('adminPanel');
const adminClose = document.getElementById('adminClose');
const adminConfirm = document.getElementById('adminConfirm');
const adminMessage = document.getElementById('adminMessage');

if (adminBtn) {
  adminBtn.addEventListener('click', () => {
    adminPanel.style.display = 'flex';
    adminMessage.textContent = '';
  });
}

if (adminClose) {
  adminClose.addEventListener('click', () => {
    adminPanel.style.display = 'none';
  });
}

if (adminConfirm) {
  adminConfirm.addEventListener('click', async () => {
    const username = document.getElementById('adminUsername').value.trim();
    const amount = Number(document.getElementById('adminAmount').value);

    if (!username) {
      adminMessage.textContent = 'Vui lòng nhập tên tài khoản';
      return;
    }
    if (!amount || isNaN(amount)) {
      adminMessage.textContent = 'Vui lòng nhập số điểm hợp lệ';
      return;
    }

    try {
      const res = await fetch('/baccarat/api/admin/adjust-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, amount })
      });

      const data = await res.json();
      adminMessage.textContent = data.message;

      if (data.ok) {
        document.getElementById('adminUsername').value = '';
        document.getElementById('adminAmount').value = '';
        // Cập nhật điểm của chính mình nếu đang chỉnh acc mình
        refresh();
      }
    } catch (err) {
      adminMessage.textContent = 'Lỗi kết nối máy chủ';
    }
  });
}
// Ép kết quả
document.querySelectorAll('.force-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const choice = btn.dataset.force;

    try {
      const res = await fetch('/baccarat/api/admin/force-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice })
      });

      const data = await res.json();
      adminMessage.textContent = data.message;
      adminMessage.style.color = data.ok ? '#2ecc71' : '#e74c3c';
    } catch (err) {
      adminMessage.textContent = 'Lỗi kết nối';
    }
  });
});
refresh();
setInterval(refresh, 1000);
</script>

</body>
</html>`);
});

// Trạng thái chung của bàn
router.get('/api/state', (req, res) => {
  updateRound();

  const elapsed = (Date.now() - roundStartedAt) / 1000;

  const myBets = getMyBets(roundId, req.session.userId);
  const summary = summarizeBets(myBets);

  const history = db.prepare(`
    SELECT round_id, result
    FROM baccarat_rounds
    WHERE result IN ('player', 'banker', 'tie')
    ORDER BY created_at DESC
    LIMIT 40
  `).all().reverse();

  // Các lá bài được phép hiển thị
  let visiblePlayerCards = [];
  let visibleBankerCards = [];

  if (phase === 'revealing' || phase === 'result') {
    const order = [
      { side: 'player', index: 0 },
      { side: 'banker', index: 0 },
      { side: 'player', index: 1 },
      { side: 'banker', index: 1 },
      { side: 'player', index: 2 },
      { side: 'banker', index: 2 }
    ].filter(item => {
      return item.side === 'player'
        ? Boolean(playerCards[item.index])
        : Boolean(bankerCards[item.index]);
    });

    const elapsedReveal = Math.max(0, elapsed - BETTING_SECONDS);

    const revealStep = phase === 'result'
      ? order.length
      : Math.min(
        order.length,
        Math.floor(
          elapsedReveal / (REVEAL_SECONDS / Math.max(order.length, 1))
        ) + 1
      );

    for (const item of order.slice(0, revealStep)) {
      if (item.side === 'player') {
        visiblePlayerCards.push(playerCards[item.index]);
      } else {
        visibleBankerCards.push(bankerCards[item.index]);
      }
    }
  }

  // Số điểm thắng / hoàn lại của người chơi ở phiên này (nếu đang ở phase kết quả)
  let myWinAmount = null;
  let myRefund = null;

  if (phase === 'result' && result) {
    myWinAmount = 0;
    myRefund = 0;

    for (const bet of myBets) {
      // Hòa -> hoàn cược 2 bên
      if (result === 'tie' && SIDE_CHOICES.includes(bet.choice)) {
        myRefund += bet.chip_value;
        continue;
      }

      if (bet.choice === result) {
        myWinAmount += Math.floor(bet.chip_value * MULTIPLIERS[bet.choice]);
      }
    }
  }

  const side = lockedSide(myBets);

  res.json({
    roundId,
    phase,
    remaining: phase === 'waiting'
      ? Math.max(0, Math.ceil(BETTING_SECONDS - elapsed))
      : null,
    result,
    playerCards: visiblePlayerCards,
    bankerCards: visibleBankerCards,
    playerTotal: phase === 'result' ? total(playerCards) : null,
    bankerTotal: phase === 'result' ? total(bankerCards) : null,
    myBets: myBets.map(bet => ({
      id: bet.id,
      choice: bet.choice,
      chip_value: bet.chip_value
    })),
    mySummary: summary,
    lockedSide: side,
    myWinAmount,
    myRefund,
    // Giữ lại cho tương thích với client cũ
    myChoice: side || (myBets.length ? 'tie' : null),
    myChipValue: myBets.length ? myBets[myBets.length - 1].chip_value : null,
    myScore: getUserScore(req.session.userId),
    history
  });
});


// ===== API ĐẶT DỰ ĐOÁN =====
// Cho phép đặt NHIỀU LẦN trong cùng một phiên, nhưng:
//   - Chỉ được đặt một bên: player hoặc banker.
//   - Hòa (tie) luôn đặt được, kể cả khi đã đặt player/banker.
router.post('/api/predict', express.json(), (req, res) => {
  updateRound();

  const choice = req.body && req.body.choice;
  const chipValue = Number(req.body && req.body.chipValue);
  const userId = req.session.userId;

  if (!CHOICES.includes(choice)) {
    return res.status(400).json({
      ok: false,
      message: 'Lựa chọn không hợp lệ.'
    });
  }

  if (!CHIP_VALUES.includes(chipValue)) {
    return res.status(400).json({
      ok: false,
      message: 'Mức chip không hợp lệ.'
    });
  }

  const elapsed = (Date.now() - roundStartedAt) / 1000;

  if (phase !== 'waiting' || elapsed >= BETTING_SECONDS) {
    return res.json({
      ok: false,
      message: 'Phiên đã khóa dự đoán. Chờ phiên tiếp theo nhé.'
    });
  }

  // Kiểm tra luật "một bên + hòa"
  const existingBets = getMyBets(roundId, userId);
  const side = lockedSide(existingBets);

  if (SIDE_CHOICES.includes(choice) && side && side !== choice) {
    return res.json({
      ok: false,
      message:
        'Mỗi phiên chỉ được đặt một bên. Bạn đã đặt ' +
        LABELS[side] +
        ' rồi, chỉ có thể đặt thêm Hòa.'
    });
  }

  try {
    const placePrediction = db.transaction(() => {
      const current = getUserScore(userId);

      if (current < chipValue) {
        throw new Error('NOT_ENOUGH_SCORE');
      }

      const deduction = db.prepare(`
        UPDATE baccarat_scores
        SET score = score - ?
        WHERE user_id = ? AND score >= ?
      `).run(chipValue, userId, chipValue);

      if (deduction.changes !== 1) {
        throw new Error('NOT_ENOUGH_SCORE');
      }

      db.prepare(`
        INSERT INTO baccarat_predictions
        (round_id, user_id, choice, chip_value, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(roundId, userId, choice, chipValue, Date.now());
    });

    placePrediction();
  } catch (error) {
    if (error.message === 'NOT_ENOUGH_SCORE') {
      const current = getUserScore(userId);

      return res.json({
        ok: false,
        message: 'Không đủ điểm. Bạn đang có ' + current.toLocaleString('vi-VN') + ' điểm.'
      });
    }

    console.error('Lỗi đặt dự đoán:', error);

    return res.status(500).json({
      ok: false,
      message: 'Không thể lưu dự đoán.'
    });
  }

  const updatedBets = getMyBets(roundId, userId);
  const summary = summarizeBets(updatedBets);

  return res.json({
    ok: true,
    message:
      'Đã đặt ' + LABELS[choice] +
      ' với chip ' + chipValue.toLocaleString('vi-VN') + ' điểm.' +
      ' Tổng phiên này: ' + summary.stake.toLocaleString('vi-VN') + ' điểm.',
    roundId,
    myBets: updatedBets.map(bet => ({
      id: bet.id,
      choice: bet.choice,
      chip_value: bet.chip_value
    })),
    mySummary: summary,
    lockedSide: lockedSide(updatedBets),
    myScore: getUserScore(userId)
  });
});

// ===== API ADMIN =====
router.post('/api/admin/adjust-score', express.json(), (req, res) => {
  // Chỉ cho phép acc uganh17
  const currentUser = db.prepare('SELECT username FROM users WHERE id = ?')
    .get(req.session.userId);

  if (!currentUser || currentUser.username !== 'uganh17') {
    return res.status(403).json({
      ok: false,
      message: 'Bạn không có quyền admin'
    });
  }

  const username = (req.body.username || '').trim();
  const amount = Number(req.body.amount);

  if (!username) {
    return res.json({ ok: false, message: 'Thiếu tên tài khoản' });
  }
  if (!amount || isNaN(amount)) {
    return res.json({ ok: false, message: 'Số điểm không hợp lệ' });
  }

  // Kiểm tra user có tồn tại không
  const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!targetUser) {
    return res.json({ ok: false, message: 'Không tìm thấy tài khoản này trong hệ thống' });
  }

  // Cộng / trừ điểm
  const exists = db.prepare('SELECT 1 FROM baccarat_scores WHERE user_id = ?').get(targetUser.id);
  if (exists) {
    db.prepare('UPDATE baccarat_scores SET score = score + ? WHERE user_id = ?')
      .run(amount, targetUser.id);
  } else {
    db.prepare('INSERT INTO baccarat_scores (user_id, score) VALUES (?, ?)')
      .run(targetUser.id, amount);
  }

  const newScore = getUserScore(targetUser.id);

  return res.json({
    ok: true,
    message: `Đã ${amount > 0 ? 'cộng' : 'trừ'} ${Math.abs(amount).toLocaleString('vi-VN')} điểm cho ${username}. Điểm hiện tại: ${newScore.toLocaleString('vi-VN')}`
  });
});
// Admin ép kết quả phiên
router.post('/api/admin/force-result', express.json(), (req, res) => {
  const currentUser = db.prepare('SELECT username FROM users WHERE id = ?')
    .get(req.session.userId);

  if (!currentUser || currentUser.username !== 'uganh17') {
    return res.status(403).json({ ok: false, message: 'Không có quyền admin' });
  }

  const choice = req.body.choice;
  if (!['player', 'tie', 'banker'].includes(choice)) {
    return res.json({ ok: false, message: 'Kết quả không hợp lệ' });
  }

  const labels = { player: 'Tay con', tie: 'Hòa', banker: 'Nhà cái' };

  if (phase === 'revealing') {
    const hand = handForOutcome(choice);
    playerCards = hand.playerCards;
    bankerCards = hand.bankerCards;
    forcedResult = null;
    updateRound();

    return res.json({
      ok: true,
      message: `Đã ép phiên này ra ${labels[choice]}. Bài lật khớp cửa thắng.`
    });
  }

  updateRound();

  if (phase === 'revealing') {
    const hand = handForOutcome(choice);
    playerCards = hand.playerCards;
    bankerCards = hand.bankerCards;
    forcedResult = null;

    return res.json({
      ok: true,
      message: `Đã ép phiên này ra ${labels[choice]}. Bài lật khớp cửa thắng.`
    });
  }

  forcedResult = choice;

  return res.json({
    ok: true,
    message: phase === 'waiting'
      ? `Đã ép phiên này ra ${labels[choice]}. Lúc lật bài sẽ đúng cửa này.`
      : `Phiên này đã chốt. Phiên sau sẽ ra ${labels[choice]}, bài lật khớp kết quả.`
  });
});
module.exports = router;