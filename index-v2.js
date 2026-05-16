const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
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

// Multer setup for file upload
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

// Create messages table
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT,
  username TEXT,
  message TEXT,
  fileUrl TEXT,
  fileName TEXT,
  timestamp TEXT
)`);

// In-memory users
const users = {};

// Socket.io Logic
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ username, room }) => {
    socket.username = username;
    socket.room = room;
    socket.join(room);
    users[socket.id] = username;

    // Send previous messages
    db.all("SELECT * FROM messages WHERE room = ? ORDER BY timestamp ASC", [room], (err, rows) => {
      if (!err) socket.emit('previousMessages', rows);
    });

    // Notify others
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

  // Message with optional file
  socket.on('message', (data) => {
    const messageData = {
      room: socket.room,
      username: socket.username || 'Anonymous',
      message: data.message || '',
      fileUrl: data.fileUrl || null,
      fileName: data.fileName || null,
      timestamp: new Date().toISOString()
    };

    // Save to database
    db.run(`INSERT INTO messages (room, username, message, fileUrl, fileName, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)`,
      [messageData.room, messageData.username, messageData.message,
       messageData.fileUrl, messageData.fileName, messageData.timestamp]
    );

    io.to(socket.room).emit('message', messageData);
  });

  // File Upload
  socket.on('upload', async (data, callback) => {
    // This is handled via HTTP route below
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
// ... (previous code remains same until file upload)

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