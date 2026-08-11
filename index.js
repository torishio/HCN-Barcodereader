const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

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

async function migrate(pool) {
  // 会社（テナント）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [companyCols] = await pool.query("SHOW COLUMNS FROM companies");
  if (!companyCols.some(c => c.Field === "default_low_stock_threshold")) {
    await pool.query(
      "ALTER TABLE companies ADD COLUMN default_low_stock_threshold INT NOT NULL DEFAULT 5"
    );
  }

  // グループ（会社内の分類ラベル）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`groups\` (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(255) NOT NULL,
      UNIQUE KEY uniq_company_group (company_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // users: company_id / group_id を追加、role に superadmin を追加
  const [userCols] = await pool.query("SHOW COLUMNS FROM users");
  const colNames = userCols.map(c => c.Field);
  if (!colNames.includes("company_id")) {
    await pool.query("ALTER TABLE users ADD COLUMN company_id BIGINT UNSIGNED NULL");
  }
  if (!colNames.includes("group_id")) {
    await pool.query("ALTER TABLE users ADD COLUMN group_id BIGINT UNSIGNED NULL");
  }
  await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('superadmin','admin','user') NOT NULL DEFAULT 'user'");
  // ユーザー名は会社単位で一意（別会社なら同じユーザー名可）にする
  try {
    await pool.query("ALTER TABLE users DROP INDEX username");
  } catch (e) {
    /* もともと無ければ何もしない */
  }
  try {
    await pool.query("ALTER TABLE users ADD UNIQUE KEY uniq_company_username (company_id, username)");
  } catch (e) {
    if (!/duplicate/i.test(e.message)) console.error("users unique key migration:", e.message);
  }

  // 会社に属さない既存adminはシステム管理者に昇格
  await pool.query("UPDATE users SET role = 'superadmin' WHERE company_id IS NULL AND role = 'admin'");

  // products / logs に company_id を追加し、products の主キーを (company_id, barcode) に変更
  const [productCols] = await pool.query("SHOW COLUMNS FROM products");
  const [logCols] = await pool.query("SHOW COLUMNS FROM logs");
  const productsNeedsMigration = !productCols.some(c => c.Field === "company_id");
  const logsNeedsMigration = !logCols.some(c => c.Field === "company_id");

  if (productsNeedsMigration) {
    await pool.query("ALTER TABLE products ADD COLUMN company_id BIGINT UNSIGNED NULL FIRST");
  }
  if (logsNeedsMigration) {
    await pool.query("ALTER TABLE logs ADD COLUMN company_id BIGINT UNSIGNED NULL");
  }

  if (productsNeedsMigration || logsNeedsMigration) {
    // 既存データ（会社未設定）はデフォルト会社へ移行する
    let [defaultCompany] = await pool.query("SELECT * FROM companies WHERE code = 'default'");
    let defaultCompanyId = defaultCompany[0] && defaultCompany[0].id;
    if (!defaultCompanyId) {
      const [result] = await pool.query("INSERT INTO companies (code, name) VALUES ('default', '（移行データ）')");
      defaultCompanyId = result.insertId;
    }
    if (productsNeedsMigration) {
      await pool.query("UPDATE products SET company_id = ? WHERE company_id IS NULL", [defaultCompanyId]);
      await pool.query("ALTER TABLE products MODIFY COLUMN company_id BIGINT UNSIGNED NOT NULL");
      await pool.query("ALTER TABLE products DROP PRIMARY KEY, ADD PRIMARY KEY (company_id, barcode)");
    }
    if (logsNeedsMigration) {
      await pool.query("UPDATE logs SET company_id = ? WHERE company_id IS NULL", [defaultCompanyId]);
    }
  }
}

async function createApp(dbConfig, sessionSecret, yahooAppId) {
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

  await migrate(pool);

  // 初回起動時、システム管理者が1人もいなければ作成する
  const [existingSuperadmins] = await pool.query(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'"
  );
  if (existingSuperadmins[0].n === 0) {
    const initialPassword = crypto.randomBytes(9).toString("base64").replace(/[/+=]/g, "");
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query(
      "INSERT INTO users (username, password_hash, role, company_id) VALUES ('admin', ?, 'superadmin', NULL)",
      [hash]
    );
    console.log("======================================================");
    console.log(" 初期システム管理者アカウントを作成しました");
    console.log(" username: admin（企業IDは空欄でログイン）");
    console.log(` password: ${initialPassword}`);
    console.log(" ログイン後、必ずパスワードを変更してください");
    console.log("======================================================");
  }

  function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    next();
  }

  // 会社に所属するユーザー（admin/user）専用。在庫系エンドポイントで使う
  function requireCompanyMember(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    if (!req.session.user.company_id) return res.status(403).json({ message: "Company account only" });
    next();
  }

  // 会社管理者（自社のみ）。システム管理者もここは通す
  function requireCompanyAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    if (req.session.user.role === "superadmin") return next();
    if (req.session.user.role !== "admin") return res.status(403).json({ message: "Admin only" });
    next();
  }

  function requireSuperadmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ message: "Login required" });
    if (req.session.user.role !== "superadmin") return res.status(403).json({ message: "Superadmin only" });
    next();
  }

  // --- 認証 ---
  // ブルートフォース対策：同一IPからの連続ログイン試行を制限する
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "ログイン試行回数が多すぎます。しばらくしてから再度お試しください" },
  });

  app.post("/auth/login", loginLimiter, async (req, res) => {
    const { companyCode, username, password } = req.body;
    let companyId = null;

    if (companyCode) {
      const [companies] = await pool.query("SELECT * FROM companies WHERE code = ?", [companyCode]);
      if (!companies[0]) {
        return res.status(401).json({ message: "企業IDが見つかりません" });
      }
      companyId = companies[0].id;
    }

    const [rows] = await pool.query(
      companyId
        ? "SELECT * FROM users WHERE company_id = ? AND username = ?"
        : "SELECT * FROM users WHERE company_id IS NULL AND username = ?",
      companyId ? [companyId, username] : [username]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "ユーザー名またはパスワードが違います" });
    }
    let companyName = null;
    let defaultThreshold = 5;
    if (user.company_id) {
      const [c] = await pool.query(
        "SELECT name, default_low_stock_threshold FROM companies WHERE id = ?",
        [user.company_id]
      );
      if (c[0]) {
        companyName = c[0].name;
        defaultThreshold = c[0].default_low_stock_threshold;
      }
    }
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      company_id: user.company_id,
      company_name: companyName,
      group_id: user.group_id,
      default_low_stock_threshold: defaultThreshold,
    };
    res.json(req.session.user);
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
  });

  app.get("/auth/me", (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Not logged in" });
    res.json(req.session.user);
  });

  // 自分自身のパスワード変更（全ロール共通）
  app.put("/auth/password", requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword, newPassword は必須です" });
    }
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(401).json({ message: "現在のパスワードが違います" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
    res.json({ message: "Password updated" });
  });

  // --- システム管理者: 会社管理 ---
  app.get("/superadmin/companies", requireSuperadmin, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM companies ORDER BY id");
    res.json(rows);
  });

  app.put("/superadmin/companies/:id", requireSuperadmin, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "name は必須です" });
    await pool.query("UPDATE companies SET name = ? WHERE id = ?", [name, req.params.id]);
    res.json({ message: "Updated" });
  });

  // --- システム管理者: 全社ユーザー管理 ---
  app.get("/superadmin/users", requireSuperadmin, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT users.id, users.username, users.role, users.created_at,
              companies.name AS company_name, companies.code AS company_code
       FROM users LEFT JOIN companies ON users.company_id = companies.id
       ORDER BY companies.name IS NULL DESC, companies.name, users.id`
    );
    res.json(rows);
  });

  app.put("/superadmin/users/:id", requireSuperadmin, async (req, res) => {
    const { role, password } = req.body;
    if (role) {
      await pool.query("UPDATE users SET role = ? WHERE id = ?", [
        role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : "user",
        req.params.id,
      ]);
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.params.id]);
    }
    res.json({ message: "Updated" });
  });

  app.delete("/superadmin/users/:id", requireSuperadmin, async (req, res) => {
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ message: "自分自身は削除できません" });
    }
    await pool.query("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ message: "Deleted" });
  });

  app.post("/superadmin/companies", requireSuperadmin, async (req, res) => {
    const { code, name, adminUsername, adminPassword } = req.body;
    if (!code || !name || !adminUsername || !adminPassword) {
      return res.status(400).json({ message: "code, name, adminUsername, adminPassword は必須です" });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query("INSERT INTO companies (code, name) VALUES (?, ?)", [code, name]);
      const hash = await bcrypt.hash(adminPassword, 10);
      await conn.query(
        "INSERT INTO users (username, password_hash, role, company_id) VALUES (?, ?, 'admin', ?)",
        [adminUsername, hash, result.insertId]
      );
      await conn.commit();
      res.json({ message: "Company created" });
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "その企業ID、もしくは管理者ユーザー名は既に使われています" });
      }
      res.status(500).json({ message: err.message });
    } finally {
      conn.release();
    }
  });

  app.delete("/superadmin/companies/:id", requireSuperadmin, async (req, res) => {
    await pool.query("DELETE FROM companies WHERE id = ?", [req.params.id]);
    await pool.query("DELETE FROM users WHERE company_id = ?", [req.params.id]);
    await pool.query("DELETE FROM \`groups\` WHERE company_id = ?", [req.params.id]);
    await pool.query("DELETE FROM products WHERE company_id = ?", [req.params.id]);
    await pool.query("DELETE FROM logs WHERE company_id = ?", [req.params.id]);
    res.json({ message: "Deleted" });
  });

  // --- 会社管理者: グループ管理 ---
  app.get("/admin/groups", requireCompanyAdmin, async (req, res) => {
    const companyId = req.query.companyId || req.session.user.company_id;
    if (!companyId) return res.status(400).json({ message: "companyId が必要です" });
    const [rows] = await pool.query("SELECT * FROM \`groups\` WHERE company_id = ? ORDER BY id", [companyId]);
    res.json(rows);
  });

  app.post("/admin/groups", requireCompanyAdmin, async (req, res) => {
    const companyId = req.session.user.company_id || req.body.companyId;
    const { name } = req.body;
    if (!companyId || !name) return res.status(400).json({ message: "name は必須です" });
    try {
      await pool.query("INSERT INTO \`groups\` (company_id, name) VALUES (?, ?)", [companyId, name]);
      res.json({ message: "Group created" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "同じ名前のグループが既にあります" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/admin/groups/:id", requireCompanyAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "name は必須です" });
    try {
      await pool.query("UPDATE \`groups\` SET name = ? WHERE id = ?", [name, req.params.id]);
      res.json({ message: "Updated" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "同じ名前のグループが既にあります" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/admin/groups/:id", requireCompanyAdmin, async (req, res) => {
    await pool.query("DELETE FROM \`groups\` WHERE id = ?", [req.params.id]);
    res.json({ message: "Deleted" });
  });

  // --- 会社管理者: 会社設定 ---
  app.get("/admin/company", requireCompanyAdmin, async (req, res) => {
    const companyId = req.session.user.company_id;
    if (!companyId) return res.status(400).json({ message: "システム管理者はこのAPIを使えません" });
    const [companies] = await pool.query("SELECT * FROM companies WHERE id = ?", [companyId]);
    const [[userCount]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE company_id = ?", [companyId]);
    const [[productCount]] = await pool.query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(stock),0) AS totalStock FROM products WHERE company_id = ?",
      [companyId]
    );
    res.json({
      ...companies[0],
      userCount: userCount.n,
      productCount: productCount.n,
      totalStock: productCount.totalStock,
    });
  });

  app.put("/admin/company", requireCompanyAdmin, async (req, res) => {
    const companyId = req.session.user.company_id;
    if (!companyId) return res.status(400).json({ message: "システム管理者はこのAPIを使えません" });
    const { default_low_stock_threshold } = req.body;
    await pool.query("UPDATE companies SET default_low_stock_threshold = ? WHERE id = ?", [
      Number(default_low_stock_threshold) || 5,
      companyId,
    ]);
    res.json({ message: "Updated" });
  });

  // --- 会社管理者: ユーザー管理（自社のみ） ---
  app.get("/admin/users", requireCompanyAdmin, async (req, res) => {
    const companyId = req.session.user.company_id;
    if (!companyId) return res.status(400).json({ message: "システム管理者はこのAPIを使えません" });
    const [rows] = await pool.query(
      `SELECT users.id, users.username, users.role, users.created_at, \`groups\`.name AS group_name
       FROM users LEFT JOIN \`groups\` ON users.group_id = \`groups\`.id
       WHERE users.company_id = ? ORDER BY users.id`,
      [companyId]
    );
    res.json(rows);
  });

  app.post("/admin/users", requireCompanyAdmin, async (req, res) => {
    const companyId = req.session.user.company_id;
    if (!companyId) return res.status(400).json({ message: "システム管理者はこのAPIを使えません" });
    const { username, password, role, groupId } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "username, password は必須です" });
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      await pool.query(
        "INSERT INTO users (username, password_hash, role, company_id, group_id) VALUES (?, ?, ?, ?, ?)",
        [username, hash, role === "admin" ? "admin" : "user", companyId, groupId || null]
      );
      res.json({ message: "User created" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "そのユーザー名は既に使われています" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/admin/users/:id", requireCompanyAdmin, async (req, res) => {
    const { role, password, groupId, username } = req.body;
    try {
      if (username) {
        await pool.query("UPDATE users SET username = ? WHERE id = ?", [username, req.params.id]);
      }
      if (role) {
        await pool.query("UPDATE users SET role = ? WHERE id = ?", [
          role === "admin" ? "admin" : "user",
          req.params.id,
        ]);
      }
      if (groupId !== undefined) {
        await pool.query("UPDATE users SET group_id = ? WHERE id = ?", [groupId || null, req.params.id]);
      }
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.params.id]);
      }
      res.json({ message: "Updated" });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "そのユーザー名は既に使われています" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/admin/users/:id", requireCompanyAdmin, async (req, res) => {
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

  // クライアントの更新チェック・お知らせ用（デプロイのたびに changelog.json を更新する）
  app.get("/api/changelog", (req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "changelog.json"), "utf8"));
      res.json(data);
    } catch (e) {
      res.json([]);
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

  // JANコードからYahoo!ショッピングで商品情報を検索（登録時の候補表示用）
  app.get("/barcode/:barcode/lookup", requireAuth, async (req, res) => {
    if (!yahooAppId) {
      return res.status(503).json({ message: "商品検索機能が設定されていません" });
    }
    const { barcode } = req.params;
    try {
      const url = new URL("https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch");
      url.searchParams.set("appid", yahooAppId);
      url.searchParams.set("jan_code", barcode);
      url.searchParams.set("results", "20");
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json({ message: "検索サービスへの接続に失敗しました" });
      const data = await r.json();
      const items = (data.hits || []).map(h => ({
        name: h.name,
        image: (h.image && (h.image.medium || h.image.small)) || null,
        description: h.description || "",
        price: h.price,
        url: h.url,
      }));
      // まとめ買い・ケース販売より単品らしい商品名を優先して表示する
      const bulkPattern = /ケース|本入|本セット|セット|ダース|まとめ買い|よりどり|選べる|箱入|×\s*\d+|\d+\s*本|\d+\s*個|\d+\s*枚|\d+\s*袋/;
      items.sort((a, b) => Number(bulkPattern.test(a.name)) - Number(bulkPattern.test(b.name)));
      res.json(items);
    } catch (e) {
      res.status(500).json({ message: "商品検索に失敗しました" });
    }
  });

  // 商品取得
  app.get("/products/:barcode", requireCompanyMember, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? AND barcode = ?", [
      req.session.user.company_id,
      req.params.barcode,
    ]);
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  });

  // 商品登録
  app.post("/products", requireCompanyMember, async (req, res) => {
    const { barcode, name, stock, location, low_stock_threshold } = req.body;
    const companyId = req.session.user.company_id;

    if (!isValidJAN(barcode)) {
      return res.status(400).json({
        message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
      });
    }

    let threshold = low_stock_threshold;
    if (threshold === undefined || threshold === null) {
      const [[company]] = await pool.query(
        "SELECT default_low_stock_threshold FROM companies WHERE id = ?",
        [companyId]
      );
      threshold = company ? company.default_low_stock_threshold : 5;
    }

    await pool.query(
      `INSERT INTO products (company_id, barcode, name, stock, location, low_stock_threshold) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), stock = VALUES(stock), location = VALUES(location), low_stock_threshold = VALUES(low_stock_threshold)`,
      [companyId, barcode, name, stock ?? 0, location ?? "", threshold]
    );
    res.json({ message: "Product saved" });
  });

  // 商品情報の編集（名称・場所・低在庫しきい値）
  app.put("/products/:barcode", requireCompanyMember, async (req, res) => {
    const { barcode } = req.params;
    const { name, location, low_stock_threshold } = req.body;
    const companyId = req.session.user.company_id;

    const [result] = await pool.query(
      "UPDATE products SET name = ?, location = ?, low_stock_threshold = ? WHERE company_id = ? AND barcode = ?",
      [name, location ?? "", low_stock_threshold ?? 5, companyId, barcode]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? AND barcode = ?", [
      companyId,
      barcode,
    ]);
    res.json(rows[0]);
  });

  // 商品削除
  app.delete("/products/:barcode", requireCompanyMember, async (req, res) => {
    const companyId = req.session.user.company_id;
    const [result] = await pool.query("DELETE FROM products WHERE company_id = ? AND barcode = ?", [
      companyId,
      req.params.barcode,
    ]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    res.json({ message: "Product deleted" });
  });

  // スキャン（在庫増減）
  app.post("/scan", requireCompanyMember, async (req, res) => {
    const { barcode, diff } = req.body;
    const companyId = req.session.user.company_id;

    if (!isValidJAN(barcode)) {
      return res.status(400).json({
        message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
      });
    }

    const [result] = await pool.query(
      "UPDATE products SET stock = stock + ? WHERE company_id = ? AND barcode = ?",
      [diff, companyId, barcode]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });

    const [logResult] = await pool.query(
      "INSERT INTO logs (company_id, barcode, diff, time, user_id) VALUES (?, ?, ?, ?, ?)",
      [companyId, barcode, diff, new Date(), req.session.user.id]
    );

    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? AND barcode = ?", [
      companyId,
      barcode,
    ]);
    res.json({ ...rows[0], logId: logResult.insertId });
  });

  // 直前のスキャンを取り消す（読み取りミス対策）
  app.post("/scan/undo/:logId", requireCompanyMember, async (req, res) => {
    const companyId = req.session.user.company_id;
    const [logRows] = await pool.query("SELECT * FROM logs WHERE id = ? AND company_id = ?", [
      req.params.logId,
      companyId,
    ]);
    const log = logRows[0];
    if (!log) return res.status(404).json({ message: "Log not found" });

    await pool.query("UPDATE products SET stock = stock - ? WHERE company_id = ? AND barcode = ?", [
      log.diff,
      companyId,
      log.barcode,
    ]);
    await pool.query("DELETE FROM logs WHERE id = ?", [log.id]);

    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? AND barcode = ?", [
      companyId,
      log.barcode,
    ]);
    res.json(rows[0]);
  });

  // 在庫一覧
  app.get("/inventory", requireCompanyMember, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? ORDER BY barcode", [
      req.session.user.company_id,
    ]);
    res.json(rows);
  });

  // 在庫のCSVエクスポート
  app.get("/inventory/export", requireCompanyMember, async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM products WHERE company_id = ? ORDER BY barcode", [
      req.session.user.company_id,
    ]);
    const csvField = v => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["barcode,name,stock,location,low_stock_threshold"];
    rows.forEach(r => {
      lines.push(
        [r.barcode, r.name, r.stock, r.location, r.low_stock_threshold].map(csvField).join(",")
      );
    });
    const csv = "﻿" + lines.join("\r\n"); // Excel向けにBOM付与
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="inventory.csv"`);
    res.send(csv);
  });

  // 在庫のCSV一括インポート（本文にCSVテキストをそのまま渡す）
  app.post("/inventory/import", requireCompanyMember, async (req, res) => {
    const { csv } = req.body;
    if (!csv) return res.status(400).json({ message: "csv は必須です" });
    const companyId = req.session.user.company_id;

    function parseCsvLine(line) {
      const fields = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQuotes = false;
          else cur += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { fields.push(cur); cur = ""; }
        else cur += c;
      }
      fields.push(cur);
      return fields;
    }

    const lines = csv.split(/\r\n|\n/).filter(l => l.trim() !== "");
    if (lines.length <= 1) return res.status(400).json({ message: "データ行がありません" });

    let imported = 0;
    const skipped = [];
    for (const line of lines.slice(1)) {
      const [barcode, name, stock, location, threshold] = parseCsvLine(line);
      if (!barcode || !isValidJAN(barcode.trim())) {
        skipped.push(barcode || "(空欄)");
        continue;
      }
      await pool.query(
        `INSERT INTO products (company_id, barcode, name, stock, location, low_stock_threshold) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), stock = VALUES(stock), location = VALUES(location), low_stock_threshold = VALUES(low_stock_threshold)`,
        [
          companyId,
          barcode.trim(),
          name || "",
          Number(stock) || 0,
          location || "",
          Number(threshold) || 5,
        ]
      );
      imported++;
    }
    res.json({ imported, skipped });
  });

  // 入出庫履歴
  app.get("/logs", requireCompanyMember, async (req, res) => {
    const [rows] = await pool.query(
      `SELECT logs.*, products.name, users.username FROM logs
       LEFT JOIN products ON logs.company_id = products.company_id AND logs.barcode = products.barcode
       LEFT JOIN users ON logs.user_id = users.id
       WHERE logs.company_id = ?
       ORDER BY logs.id DESC LIMIT 200`,
      [req.session.user.company_id]
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
  const yahooAppId = process.env.YAHOO_APP_ID || null;

  createApp(dbConfig, sessionSecret, yahooAppId).then(app => {
    if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
      const https = require("https");
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
