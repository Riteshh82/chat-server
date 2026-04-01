const { v4: uuidv4 } = require('uuid');
const inMemoryRooms    = new Map();
const inMemoryMessages = new Map(); 

let Message, Room;
let dbConnected = false;

/**
 * Initialize socket handlers.
 * @param {import('socket.io').Server} io
 * @param {boolean} isDbConnected
 */
function initSocketHandlers(io, isDbConnected) {
  dbConnected = isDbConnected;

  if (dbConnected) {
    try {
      Message = require('../models/Message');
      Room    = require('../models/Room');
    } catch (_) {
      dbConnected = false;
    }
  }

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);
    socket.on('join_room', async ({ name, roomId }) => {
      if (!name || !roomId) return;

      socket.data.name   = name.trim();
      socket.data.roomId = roomId.trim();

      socket.join(roomId);
      console.log(`👤 ${name} joined room: ${roomId}`);
      if (dbConnected) {
        await upsertRoomParticipant(roomId, name, socket.id);
      } else {
        if (!inMemoryRooms.has(roomId)) inMemoryRooms.set(roomId, new Map());
        inMemoryRooms.get(roomId).set(socket.id, name);
      }

      // Send last 50 messages to the joining user
      const history = await getHistory(roomId, 50);
      socket.emit('message_history', history);

      // Build current participants list and broadcast
      const participants = await getParticipants(roomId);
      io.to(roomId).emit('room_participants', participants);

      // Notify others
      const systemMsg = buildSystemMessage(roomId, `${name} joined the chat`);
      io.to(roomId).emit('system_message', systemMsg);

      // Mark all existing messages as delivered for the new user
      if (dbConnected) {
        await Message.updateMany(
          { roomId, status: 'sent' },
          { $set: { status: 'delivered' } }
        );
        io.to(roomId).emit('bulk_status_update', { roomId, status: 'delivered' });
      }
    });

    // ── Send Message ────────────────────────────────────────
    socket.on('send_message', async (payload) => {
      const { roomId, content } = payload;
      if (!roomId || !content?.trim()) return;

      const name = socket.data.name || 'Anonymous';
      const msg  = {
        id:         uuidv4(),
        roomId,
        senderId:   socket.id,
        senderName: name,
        content:    content.trim(),
        status:     'sent',
        timestamp:  new Date().toISOString(),
      };

      // Persist
      if (dbConnected) {
        try {
          const saved = await Message.create({
            roomId,
            senderId:   socket.id,
            senderName: name,
            content:    content.trim(),
            status:     'sent',
            timestamp:  msg.timestamp,
          });
          msg.id = saved._id.toString();
        } catch (err) {
          console.error('Message save error:', err);
        }
      } else {
        if (!inMemoryMessages.has(roomId)) inMemoryMessages.set(roomId, []);
        inMemoryMessages.get(roomId).push(msg);
        // Keep last 200 messages in memory
        const arr = inMemoryMessages.get(roomId);
        if (arr.length > 200) arr.splice(0, arr.length - 200);
      }
      io.to(roomId).emit('new_message', msg);

      // Immediately mark as delivered if there are other people in the room
      const socketsInRoom = await io.in(roomId).fetchSockets();
      const othersPresent  = socketsInRoom.some((s) => s.id !== socket.id);

      if (othersPresent) {
        msg.status = 'delivered';
        if (dbConnected) {
          await Message.findByIdAndUpdate(msg.id, { status: 'delivered' });
        } else {
          // Update in-memory
          const arr = inMemoryMessages.get(roomId) || [];
          const m   = arr.find((x) => x.id === msg.id);
          if (m) m.status = 'delivered';
        }
        io.to(roomId).emit('message_status_update', { id: msg.id, status: 'delivered' });
      }
    });

    // ── Typing Indicator ────────────────────────────────────
    socket.on('typing_start', ({ roomId }) => {
      socket.to(roomId).emit('user_typing', {
        socketId: socket.id,
        name:     socket.data.name,
      });
    });

    socket.on('typing_stop', ({ roomId }) => {
      socket.to(roomId).emit('user_stop_typing', { socketId: socket.id });
    });

    // ── Mark Messages as Seen ───────────────────────────────
    socket.on('messages_seen', async ({ roomId, messageIds }) => {
      if (!roomId || !messageIds?.length) return;

      if (dbConnected) {
        await Message.updateMany(
          { _id: { $in: messageIds }, status: { $ne: 'seen' } },
          { $set: { status: 'seen' } }
        );
      } else {
        const arr = inMemoryMessages.get(roomId) || [];
        messageIds.forEach((id) => {
          const m = arr.find((x) => x.id === id);
          if (m) m.status = 'seen';
        });
      }

      // Notify the room so senders can update their tick icons
      io.to(roomId).emit('messages_seen_ack', {
        messageIds,
        seenBy: socket.data.name,
      });
    });

    // ── Disconnect ──────────────────────────────────────────
    socket.on('disconnect', async () => {
      const { name, roomId } = socket.data;
      if (!roomId) return;

      console.log(`❌ ${name || socket.id} disconnected from ${roomId}`);

      if (dbConnected) {
        await removeParticipant(roomId, socket.id);
      } else {
        inMemoryRooms.get(roomId)?.delete(socket.id);
      }

      const participants = await getParticipants(roomId);
      io.to(roomId).emit('room_participants', participants);

      if (name) {
        io.to(roomId).emit('system_message', buildSystemMessage(roomId, `${name} left the chat`));
      }
    });
  });
}


function buildSystemMessage(roomId, text) {
  return { id: uuidv4(), roomId, system: true, content: text, timestamp: new Date().toISOString() };
}

async function upsertRoomParticipant(roomId, name, socketId) {
  try {
    await Room.findOneAndUpdate(
      { roomId },
      {
        $pull:  { participants: { socketId } },
      },
      { upsert: true, new: true }
    );
    await Room.findOneAndUpdate(
      { roomId },
      {
        $push: { participants: { name, socketId, joinedAt: new Date() } },
      }
    );
  } catch (err) {
    console.error('upsertRoomParticipant error:', err);
  }
}

async function removeParticipant(roomId, socketId) {
  try {
    await Room.findOneAndUpdate({ roomId }, { $pull: { participants: { socketId } } });
  } catch (err) {
    console.error('removeParticipant error:', err);
  }
}

async function getParticipants(roomId) {
  if (dbConnected) {
    const room = await Room.findOne({ roomId }).lean();
    return (room?.participants || []).map((p) => ({ name: p.name, socketId: p.socketId }));
  }
  const map = inMemoryRooms.get(roomId);
  if (!map) return [];
  return Array.from(map.entries()).map(([socketId, name]) => ({ socketId, name }));
}

async function getHistory(roomId, limit) {
  if (dbConnected) {
    try {
      const messages = await Message.find({ roomId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();
      return messages.reverse().map((m) => ({
        id:         m._id.toString(),
        roomId:     m.roomId,
        senderId:   m.senderId,
        senderName: m.senderName,
        content:    m.content,
        status:     m.status,
        timestamp:  m.timestamp,
      }));
    } catch (err) {
      return [];
    }
  }
  const arr = inMemoryMessages.get(roomId) || [];
  return arr.slice(-limit);
}

module.exports = { initSocketHandlers };
