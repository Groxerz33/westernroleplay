const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("."));

// Koneksi ke database GTA (register + login)
const dbAuth = mysql.createConnection({
  host: "104.234.180.143",
  user: "u79_IkQ1tcBVSx",
  password: "Me+k8Xv3O!dCtbVh71mR^VaS",
  database: "s79_aretive"
});

// Koneksi ke database Web (fitur web)
const dbWeb = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "dbwebsamp8"
});

// ========================= REGISTER =========================
app.post("/api/daftar-akun", (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.json({ success: false, message: "Data tidak lengkap." });

  dbAuth.execute("SELECT * FROM accounts WHERE Username = ?", [username], (err, result) => {
    if (err) return res.json({ success: false, message: "Kesalahan server." });
    if (result.length > 0) return res.json({ success: false, message: "Username sudah digunakan." });

    const salt = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(password + salt).digest("hex");

    // Buat VerifyCode: WRP-4digit
    const verifyCode = "WRP-" + Math.floor(1000 + Math.random() * 9000);
    const whiteList = 1;

    dbAuth.execute(
      `INSERT INTO accounts (Username, Password, Salt, Email, RegisterDate, VerifyCode, WhiteList)
       VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?)`,
      [username, hash, salt, email, verifyCode, whiteList],
      (err2) => {
        if (err2) {
          console.error("Gagal mendaftar (akun):", err2);
          return res.json({ success: false, message: "Gagal mendaftar (akun)." });
        }

        // ➕ Tambahkan ke user_wallet di dbWeb
        dbWeb.execute(
          `INSERT INTO user_wallet (Username, Coin, IsBanned) VALUES (?, 0, 0)`,
          [username],
          (err3) => {
            if (err3) {
              console.error("Gagal membuat user_wallet:", err3);
              return res.json({ success: false, message: "Gagal membuat data wallet." });
            }

            res.json({ success: true, message: "Pendaftaran berhasil!" });
          }
        );
      }
    );
  });
});

// ========================= LOGIN =========================
app.post("/api/login", (req, res) => {
  const { nickname, password } = req.body;

  if (!nickname || !password)
    return res.json({ success: false, message: "Data tidak lengkap." });

  dbAuth.execute("SELECT * FROM accounts WHERE Username = ? LIMIT 1", [nickname], (err, results) => {
    if (err || results.length === 0)
      return res.json({ success: false, message: "Akun tidak ditemukan." });

    const akun = results[0];
    if (akun.IsBanned && akun.IsBanned === 1) {
      return res.json({ success: false, message: "Akun ini telah dibanned." });
    }

    const hashInput = crypto.createHash("sha256").update(password + akun.Salt).digest("hex");

    if (hashInput === akun.Password) {
      res.json({ success: true, message: "Login berhasil!" });
    } else {
      res.json({ success: false, message: "Password salah!" });
    }
  });
});

// ========================= AMBIL SALDO COIN =========================
app.get("/api/wpc/:username", (req, res) => {
  dbWeb.execute("SELECT Coin FROM user_wallet WHERE Username = ?", [req.params.username], (err, result) => {
    if (err || result.length === 0)
      return res.json({ success: false, message: "Tidak ditemukan." });
    res.json({ success: true, coin: result[0].Coin });
  });
});

// ========================= TOPUP REQUEST =========================
app.post("/api/topup", (req, res) => {
  const { username, jumlah, metode } = req.body;

  if (!username || !jumlah || !metode)
    return res.json({ success: false, message: "Data tidak lengkap." });

  dbWeb.execute(
    `INSERT INTO topup_requests (Username, Amount, Method, Status, RequestTime)
     VALUES (?, ?, ?, 'pending', NOW())`,
    [username, jumlah, metode],
    (err) => {
      if (err) return res.json({ success: false, message: "Gagal topup." });
      res.json({ success: true, message: "Top up berhasil dikirim." });
    }
  );
});

// ========================= SHOP =========================
app.get("/api/shop-items", (_, res) => {
  dbWeb.query("SELECT * FROM shop_items", (err, result) => {
    if (err) return res.json([]);
    res.json(result);
  });
});

app.post("/api/buy-item", (req, res) => {
  const { username, itemId } = req.body;

  dbWeb.execute("SELECT * FROM shop_items WHERE ID = ?", [itemId], (err, itemRes) => {
    if (err || itemRes.length === 0)
      return res.json({ success: false, message: "Item tidak ditemukan." });

    const item = itemRes[0];

    dbWeb.execute("SELECT Coin FROM user_wallet WHERE Username = ?", [username], (err2, saldoRes) => {
      if (err2 || saldoRes.length === 0)
        return res.json({ success: false, message: "User tidak ditemukan." });

      const saldo = saldoRes[0].Coin;
      if (saldo < item.Price)
        return res.json({ success: false, message: "Saldo kurang." });

      dbWeb.beginTransaction(err3 => {
        if (err3) return res.json({ success: false, message: "Gagal transaksi." });

        dbWeb.execute("UPDATE user_wallet SET Coin = Coin - ? WHERE Username = ?", [item.Price, username]);
        dbWeb.execute("INSERT INTO coin_transactions (Username, ItemName, Amount) VALUES (?, ?, ?)",
          [username, item.Name, item.Price]);

        dbWeb.commit(err4 => {
          if (err4) return dbWeb.rollback(() => res.json({ success: false, message: "Gagal commit." }));
          res.json({ success: true, message: `Berhasil membeli ${item.Name}.` });
        });
      });
    });
  });
});

// ========================= ADMIN =========================
app.get("/api/topup-pending", (_, res) => {
  dbWeb.query("SELECT * FROM topup_requests WHERE Status = 'pending'", (err, result) => {
    if (err) return res.json([]);
    res.json(result);
  });
});

app.post("/api/topup-konfirmasi", (req, res) => {
  const { id, username, amount } = req.body;

  dbWeb.beginTransaction(err => {
    if (err) return res.json({ success: false, message: "Gagal memulai." });

    dbWeb.execute("UPDATE user_wallet SET Coin = Coin + ? WHERE Username = ?", [amount, username]);
    dbWeb.execute("UPDATE topup_requests SET Status = 'done' WHERE ID = ?", [id]);

    dbWeb.commit(err2 => {
      if (err2) return dbWeb.rollback(() => res.json({ success: false, message: "Gagal commit." }));
      res.json({ success: true, message: "Top up dikonfirmasi." });
    });
  });
});

app.post("/api/topup-tolak", (req, res) => {
  const { id } = req.body;
  dbWeb.execute("UPDATE topup_requests SET Status = 'rejected' WHERE ID = ?", [id], (err) => {
    if (err) return res.json({ success: false });
    res.json({ success: true });
  });
});

app.post("/api/admin/add-item", (req, res) => {
  const { nama, kategori, harga, deskripsi } = req.body;
  if (!nama || !kategori || !harga || !deskripsi)
    return res.json({ success: false, message: "Data tidak lengkap." });

  dbWeb.execute(
    "INSERT INTO shop_items (Name, Category, Price, Description) VALUES (?, ?, ?, ?)",
    [nama, kategori, harga, deskripsi],
    (err) => {
      if (err) return res.json({ success: false });
      res.json({ success: true });
    }
  );
});

app.post("/api/admin/edit-coin", (req, res) => {
  const { username, type, amount } = req.body;

  if (!username || !type || amount === undefined) {
    return res.json({ success: false, message: "Data tidak lengkap." });
  }

  const safeAmount = parseInt(amount);
  if (isNaN(safeAmount)) {
    return res.json({ success: false, message: "Jumlah tidak valid." });
  }

  let sql, params;

  switch (type) {
    case "tambah":
      sql = "UPDATE user_wallet SET Coin = Coin + ? WHERE Username = ?";
      params = [safeAmount, username];
      break;
    case "kurangi":
      sql = "UPDATE user_wallet SET Coin = GREATEST(0, Coin - ?) WHERE Username = ?";
      params = [safeAmount, username];
      break;
    case "set":
      sql = "UPDATE user_wallet SET Coin = ? WHERE Username = ?";
      params = [safeAmount, username];
      break;
    default:
      return res.json({ success: false, message: "Tipe aksi tidak valid." });
  }

  dbWeb.execute(sql, params, (err, result) => {
    if (err) {
      console.error("Update coin gagal:", err);
      return res.json({ success: false, message: "Gagal update coin." });
    }

    res.json({ success: true, message: `Coin berhasil di${type}.` });
  });
});

app.post("/api/admin/ban-akun", (req, res) => {
  const { username, status } = req.body;

  if (!username || typeof status !== "boolean") {
    return res.json({ success: false, message: "Data tidak lengkap atau salah format." });
  }

  const sql = "UPDATE accounts SET IsBanned = ? WHERE Username = ?";
  dbAuth.execute(sql, [status ? 1 : 0, username], (err, result) => {
    if (err) {
      console.error("Ban akun gagal:", err);
      return res.json({ success: false, message: "Gagal memperbarui status akun." });
    }

    res.json({
      success: true,
      message: status
        ? "Akun berhasil dibanned."
        : "Ban akun telah dicabut."
    });
  });
});

app.listen(port, () => console.log(`Server jalan di http://localhost:${port}`));