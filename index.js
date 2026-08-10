const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 3000;

// DB（ルート直下に db.sqlite ができる）
const db = new sqlite3.Database("./db.sqlite");

// 初期化
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      barcode TEXT PRIMARY KEY,
      name TEXT,
      stock INTEGER DEFAULT 0,
      location TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT,
      diff INTEGER,
      time TEXT
    )
  `);
});

// 疎通確認
app.get("/", (req, res) => {
  res.json({ status: "barcode API server running" });
});

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

// バーコードのチェックディジット検証（読み取り前の確認用）
app.get("/barcode/:barcode/validate", (req, res) => {
  const { barcode } = req.params;
  const isJAN = /^\d{8}$/.test(barcode) || /^\d{13}$/.test(barcode);
  res.json({
    barcode,
    isJAN,
    valid: isValidJAN(barcode),
  });
});

// 商品取得
app.get("/products/:barcode", (req, res) => {
  const { barcode } = req.params;
  db.get(
    "SELECT * FROM products WHERE barcode = ?",
    [barcode],
    (err, row) => {
      if (err) return res.status(500).json(err);
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    }
  );
});

// 商品登録
app.post("/products", (req, res) => {
  const { barcode, name, stock, location } = req.body;

  if (!isValidJAN(barcode)) {
    return res.status(400).json({
      message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
    });
  }

  db.run(
    "INSERT OR REPLACE INTO products (barcode, name, stock, location) VALUES (?, ?, ?, ?)",
    [barcode, name, stock ?? 0, location ?? ""],
    err => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Product saved" });
    }
  );
});

// スキャン（在庫増減）
app.post("/scan", (req, res) => {
  const { barcode, diff } = req.body;

  if (!isValidJAN(barcode)) {
    return res.status(400).json({
      message: "Invalid barcode: check digit mismatch (misread or damaged barcode?)",
    });
  }

  db.serialize(() => {
    db.run(
      "UPDATE products SET stock = stock + ? WHERE barcode = ?",
      [diff, barcode],
      function (err) {
        if (err) return res.status(500).json(err);
        if (this.changes === 0) {
          return res.status(404).json({ message: "Product not found" });
        }

        db.run(
          "INSERT INTO logs (barcode, diff, time) VALUES (?, ?, ?)",
          [barcode, diff, new Date().toISOString()]
        );

        db.get(
          "SELECT * FROM products WHERE barcode = ?",
          [barcode],
          (err, row) => {
            if (err) return res.status(500).json(err);
            res.json(row);
          }
        );
      }
    );
  });
});

// 在庫一覧
app.get("/inventory", (req, res) => {
  db.all("SELECT * FROM products", (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});

app.listen(PORT, () => {
  console.log(`barcode API server running on http://localhost:${PORT}`);
});
