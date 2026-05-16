const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, specify your frontend URL
  }
});

app.use(express.static('public')); // Serve static files

// Store users (simple in-memory for demo)
const users = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room (for private/group chats)
  socket.on('join', (data) => {
    const { username, room } = data;
    socket.username = username;
    socket.room = room;
    
    socket.join(room);
    users[socket.id] = username;

    // Notify room
    socket.to(room).emit('userJoined', {
      username,
      message: `${username} joined the room`
    });

    // Send current users
    io.to(room).emit('users', Object.values(users));
  });

  // Handle message
  socket.on('message', (data) => {
    const messageData = {
      id: Date.now(),
      username: socket.username || 'Anonymous',
      message: data.message,
      timestamp: new Date().toISOString(),
      room: socket.room
    };

    // Broadcast to room (or everyone if no room)
    if (socket.room) {
      io.to(socket.room).emit('message', messageData);
    } else {
      io.emit('message', messageData);
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    if (socket.room) {
      socket.to(socket.room).emit('typing', {
        username: socket.username,
        isTyping: data.isTyping
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.id];
      if (socket.room) {
        io.to(socket.room).emit('userLeft', {
          username: socket.username,
          message: `${socket.username} left the room`
        });
        io.to(socket.room).emit('users', Object.values(users));
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});