const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

// JAN/EANチェックディジット計算（bodyは12桁=JAN-13用 または 7桁=JAN-8用）
function calcCheckDigit(body) {
  const isThirteen = body.length === 12;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[i]);
    const weight = isThirteen
      ? (i % 2 === 0 ? 1 : 3) // JAN-13: 奇数桁×1, 偶数桁×3
      : (i % 2 === 0 ? 3 : 1); // JAN-8: 奇数桁×3, 偶数桁×1
    sum += n * weight;
  }
  return (10 - (sum % 10)) % 10;
}

// JAN-8/JAN-13以外（社内独自コード等）はチェック対象外として許可する
function isValidJAN(barcode) {
  if (!/^\d{8}$/.test(barcode) && !/^\d{13}$/.test(barcode)) return true;
  const body = barcode.slice(0, -1);
  const checkDigit = Number(barcode.slice(-1));
  return calcCheckDigit(body) === checkDigit;
}

async function createApp(dbConfig, sessionSecret) {
  const app = express();
  app.use(express.json());
  app.use(cors({ origin: true, credentials: true }));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 },
    })
  );

  const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
  });

  // 初回起動時、管理者が1人もいなければ初期管理者を作成する
  const [existingAdmins] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  if (existingAdmins[0].n === 0) {
    const initialPassword = crypto.randomBytes(9).toString("base64").replace(/[/+=]/g, "");
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')",
      [hash]
    );
    console.log("======================================================");
    console.log(" 初期管理者アカウントを作成しました");
    console.log(" username: admin");
    console.log(` password: ${initialPassword}`);
    console.log(" ログイン後、必ずパスワードを変更してください");
    console.log("======================================================");
  }

  function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    if (req.session.user.role !== "admin") return res.status(403).json({ message: "Admin only" });
    next();
  }

  // --- 認証 ---
  app.post("/auth/login", async (req, res) => {
    const { username, password } = req.body;
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "ユーザー名またはパスワードが違います" });
    }
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json(req.session.user);
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
  });

  app.get("/auth/me", (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Not logged in" });
    res.json(req.session.user);
  });

  // --- 管理者: ユーザー管理 ---
  app.get("/admin/users", requireAdmin, async (req, res) => {
    const [rows] = await pool.query("SELECT id, username, role, created_at FROM users ORDER BY id");
    res.json(rows);
  });

  app.post("/admin/users", requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "username, password は必須です" });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      await pool.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [
        username,
        hash,
        role === "admin" ? "admin" : "user",
      ]);
      res.json({ message: "User created" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "そのユーザー名は既に使われています" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/admin/users/:id", requireAdmin, async (req, res) => {
    const { role, password } = req.body;
    if (role) {
      await pool.query("UPDATE users SET role = ? WHERE id = ?", [
        role === "admin" ? "admin" : "user",
        req.params.id,
      ]);
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.params.id]);
    }
    res.json({ message: "Updated" });
  });

  app.delete("/admin/users/:id", requireAdmin, async (req, res) => {
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ message: "自分自身は削除できません" });
    }
    await pool.query("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ message: "Deleted" });
  });

  // 疎通確認
  app.get("/api/status", (req, res) => {
    res.json({ status: "barcode API server running" });
  });

  // クライアントの更新チェック用（デプロイのたびに version.json を更新する）
  app.get("/api/latest-version", async (req, res) => {
    try {
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8"));
      res.json(data);
    } catch (e) {
      res.json({ sha: null, message: "", date: null });
    }
  });

  app.use(express.static(path.join(__dirname, "public")));

  // バーコードのチェックディジット検証（読み取り前の確認用）
  app.get("/barcode/:barcode/validate", requireAuth, (req, res) => {
    const { barcode } = req.params;
    const isJAN = /^\d{8}$/.test(barcode) || /^\d{13}$/.test(barcode);
    res.json({
      barcode,
      isJAN,
      valid: isValidJAN(barcode),
    });
  });

  // 商品取得
  app.get("/products/:barcode", requireAuth, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM products WHERE barcode = ?", [req.params.barcode]);
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  });

  // 商品登録
  app.post("/products", requireAuth, async (req, res) => {
    const { barcode, name, stock, location, low_stock_threshold } = req.body;

    if (!isValidJAN(barcode)) {
      return res.status(400).json({
        message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
      });
    }

    await pool.query(
      `INSERT INTO products (barcode, name, stock, location, low_stock_threshold) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), stock = VALUES(stock), location = VALUES(location), low_stock_threshold = VALUES(low_stock_threshold)`,
      [barcode, name, stock ?? 0, location ?? "", low_stock_threshold ?? 5]
    );
    res.json({ message: "Product saved" });
  });

  // 商品情報の編集（名称・場所・低在庫しきい値）
  app.put("/products/:barcode", requireAuth, async (req, res) => {
    const { barcode } = req.params;
    const { name, location, low_stock_threshold } = req.body;

    const [result] = await pool.query(
      "UPDATE products SET name = ?, location = ?, low_stock_threshold = ? WHERE barcode = ?",
      [name, location ?? "", low_stock_threshold ?? 5, barcode]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    const [rows] = await pool.query("SELECT * FROM products WHERE barcode = ?", [barcode]);
    res.json(rows[0]);
  });

  // 商品削除
  app.delete("/products/:barcode", requireAuth, async (req, res) => {
    const [result] = await pool.query("DELETE FROM products WHERE barcode = ?", [req.params.barcode]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    res.json({ message: "Product deleted" });
  });

  // スキャン（在庫増減）
  app.post("/scan", requireAuth, async (req, res) => {
    const { barcode, diff } = req.body;

    if (!isValidJAN(barcode)) {
      return res.status(400).json({
        message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
      });
    }

    const [result] = await pool.query("UPDATE products SET stock = stock + ? WHERE barcode = ?", [
      diff,
      barcode,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });

    await pool.query("INSERT INTO logs (barcode, diff, time, user_id) VALUES (?, ?, ?, ?)", [
      barcode,
      diff,
      new Date(),
      req.session.user.id,
    ]);

    const [rows] = await pool.query("SELECT * FROM products WHERE barcode = ?", [barcode]);
    res.json(rows[0]);
  });

  // 在庫一覧
  app.get("/inventory", requireAuth, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM products ORDER BY barcode");
    res.json(rows);
  });

  // 入出庫履歴
  app.get("/logs", requireAuth, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT logs.*, products.name, users.username FROM logs
       LEFT JOIN products ON logs.barcode = products.barcode
       LEFT JOIN users ON logs.user_id = users.id
       ORDER BY logs.id DESC LIMIT 200`
    );
    res.json(rows);
  });

  return app;
}

module.exports = { createApp, isValidJAN };

// `node index.js` で直接起動された場合のみサーバーを立ち上げる
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const dbConfig = {
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "inventory_db",
  };
  const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

  createApp(dbConfig, sessionSecret).then(app => {
    if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
      const https = require("https");
      const fs = require("fs");
      https
        .createServer(
          {
            key: fs.readFileSync(process.env.HTTPS_KEY),
            cert: fs.readFileSync(process.env.HTTPS_CERT),
          },
          app
        )
        .listen(PORT, () => console.log(`inventory API server running on https://0.0.0.0:${PORT}`));
    } else {
      app.listen(PORT, () => console.log(`inventory API server running on http://localhost:${PORT}`));
    }
  });
}
