const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Ensure uploads folder exists
const uploadDir = 'public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer setup
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// SQLite Database
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error(err);
  else console.log('Connected to SQLite database');
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    username TEXT,
    message TEXT,
    fileUrl TEXT,
    fileName TEXT,
    timestamp TEXT
  )`);

  // ── NEW: Rooms table — persists all rooms across restarts ──
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    created_at TEXT
  )`);

  // Always ensure 'general' exists
  db.run(`INSERT OR IGNORE INTO rooms (name, created_at) VALUES ('general', ?)`,
    [new Date().toISOString()]);
});

const users = {}; // { socketId: username }

// ── Helper: broadcast updated room list to ALL connected clients ──
function broadcastRooms() {
  db.all("SELECT name FROM rooms ORDER BY created_at ASC", [], (err, rows) => {
    if (!err) {
      const roomNames = rows.map(r => r.name);
      io.emit('roomList', roomNames);   // every connected socket gets this
    }
  });
}

// ── REST: GET /rooms — lets clients fetch rooms on page load ──
app.get('/rooms', (req, res) => {
  db.all("SELECT name FROM rooms ORDER BY created_at ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.name));
  });
});

// ── REST: GET /messages?room=X&before=ID&limit=100 — paginated history ──
// 'before' = oldest message id currently loaded on client (scroll up loads older)
app.get('/messages', (req, res) => {
  const { room, before, limit = 100 } = req.query;
  if (!room) return res.status(400).json({ error: 'room required' });

  const pageSize = Math.min(parseInt(limit) || 100, 100);

  if (before) {
    // Load 'pageSize' messages older than the given id
    db.all(
      `SELECT * FROM (SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?)
       ORDER BY id ASC`,
      [room, parseInt(before), pageSize],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  } else {
    // Initial load: last 'pageSize' messages
    db.all(
      `SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?)
       ORDER BY id ASC`,
      [room, pageSize],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  }
});

// ====================== Socket.io Logic ======================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send the current room list immediately on connect
  db.all("SELECT name FROM rooms ORDER BY created_at ASC", [], (err, rows) => {
    if (!err) socket.emit('roomList', rows.map(r => r.name));
  });

  socket.on('join', ({ username, room }) => {
    // Leave previous room if any
    if (socket.room && socket.room !== room) {
      socket.leave(socket.room);
    }

    socket.username = username;
    socket.room = room;
    socket.join(room);
    users[socket.id] = username;

    // ── Save room to DB if new, then broadcast updated list to everyone ──
    db.run(
      `INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)`,
      [room, new Date().toISOString()],
      (err) => {
        if (!err) broadcastRooms(); // tell ALL clients about the new room
      }
    );

    // Confirm join to this socket
    socket.emit('joinSuccess', { room });

    // Send last 100 messages — subquery fetches newest 100 DESC, outer sorts ASC for display
    db.all(
      `SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC`,
      [room],
      (err, rows) => { if (!err) socket.emit('previousMessages', rows); }
    );

    // Notify others in the room
    socket.to(room).emit('userJoined', {
      username,
      message: `${username} joined the room`
    });

    io.to(room).emit('users', Object.values(users));
  });

  // Typing Indicator
  socket.on('typing', ({ isTyping }) => {
    if (socket.room) {
      socket.to(socket.room).emit('typing', {
        username: socket.username,
        isTyping
      });
    }
  });

  // Message
  socket.on('message', (data) => {
    const fileName = data.fileName || null;
    const fileUrl  = data.fileUrl  || null;
    const isImage  = fileUrl
      ? ['.jpg','.jpeg','.png','.gif','.webp'].some(e => (fileName || '').toLowerCase().endsWith(e))
      : false;

    const messageData = {
      room: socket.room,
      username: socket.username || 'Anonymous',
      message: data.message || '',
      fileUrl,
      fileName,
      isImage,
      timestamp: new Date().toISOString()
    };

    db.run(
      `INSERT INTO messages (room, username, message, fileUrl, fileName, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageData.room, messageData.username, messageData.message,
       messageData.fileUrl, messageData.fileName, messageData.timestamp]
    );

    io.to(socket.room).emit('message', messageData);
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.room) {
      delete users[socket.id];
      io.to(socket.room).emit('userLeft', {
        username: socket.username,
        message: `${socket.username} left the room`
      });
      io.to(socket.room).emit('users', Object.values(users));
    }
    console.log('User disconnected:', socket.id);
  });
});

// File Upload Route
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileUrl = `/uploads/${req.file.filename}`;
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].some(ext =>
    req.file.originalname.toLowerCase().endsWith(ext)
  );

  res.json({
    fileUrl,
    fileName: req.file.originalname,
    isImage
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
