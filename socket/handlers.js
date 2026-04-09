const { v4: uuidv4 } = require("uuid");

const inMemoryRooms = new Map();
const inMemoryMessages = new Map();

let Message, Room;
let dbConnected = false;

function initSocketHandlers(io, isDbConnected) {
  dbConnected = isDbConnected;

  if (dbConnected) {
    try {
      Message = require("../models/Message");
      Room = require("../models/Room");
    } catch (_) {
      dbConnected = false;
    }
  }

  io.on("connection", (socket) => {
    socket.on("join_room", async ({ name, roomId, clientId }) => {
      if (!name || !roomId) return;

      const socketsInRoom = await io.in(roomId).fetchSockets();
      const existingNames = socketsInRoom
        .filter((s) => s.id !== socket.id)
        .map((s) => s.data.name)
        .filter(Boolean);

      const isRejoin = existingNames.includes(name.trim());
      const uniqueOthers = new Set(existingNames).size;

      if (!isRejoin && uniqueOthers >= 2) {
        socket.emit("room_full", { roomId });
        return;
      }

      socket.data.name = name.trim();
      socket.data.roomId = roomId.trim();
      socket.data.clientId = clientId || socket.id;

      socket.join(roomId);

      if (dbConnected) {
        await upsertRoomParticipant(
          roomId,
          name,
          socket.id,
          socket.data.clientId
        );
      } else {
        if (!inMemoryRooms.has(roomId)) inMemoryRooms.set(roomId, new Map());
        const room = inMemoryRooms.get(roomId);
        for (const [sid, data] of room.entries()) {
          if (data.name === name.trim()) room.delete(sid);
        }
        room.set(socket.id, {
          name: name.trim(),
          clientId: socket.data.clientId,
        });
      }

      const history = await getHistory(roomId, 50);
      socket.emit("message_history", history);

      const participants = await getParticipants(roomId);
      io.to(roomId).emit("room_participants", participants);

      const systemMsg = buildSystemMessage(roomId, `${name} joined the chat`);
      io.to(roomId).emit("system_message", systemMsg);

      if (dbConnected) {
        await Message.updateMany(
          { roomId, status: "sent" },
          { $set: { status: "delivered" } }
        );
        io.to(roomId).emit("bulk_status_update", {
          roomId,
          status: "delivered",
        });
      }
    });

    socket.on("send_message", async ({ roomId, content, replyTo }) => {
      if (!roomId || !content?.trim()) return;

      const name = socket.data.name || "Anonymous";

      const msg = {
        id: uuidv4(),
        roomId,
        senderId: socket.id,
        clientId: socket.data.clientId || socket.id,
        senderName: name,
        content: content.trim(),
        replyTo: replyTo || null,
        status: "sent",
        timestamp: new Date().toISOString(),
      };

      if (dbConnected) {
        try {
          const saved = await Message.create({
            roomId,
            senderId: socket.id,
            clientId: socket.data.clientId || socket.id,
            senderName: name,
            content: content.trim(),
            replyTo: replyTo || null,
            status: "sent",
            timestamp: msg.timestamp,
          });
          msg.id = saved._id.toString();
        } catch (err) {
          console.error("Message save error:", err);
        }
      } else {
        if (!inMemoryMessages.has(roomId)) inMemoryMessages.set(roomId, []);
        inMemoryMessages.get(roomId).push(msg);
        const arr = inMemoryMessages.get(roomId);
        if (arr.length > 200) arr.splice(0, arr.length - 200);
      }

      io.to(roomId).emit("new_message", msg);

      const socketsInRoom = await io.in(roomId).fetchSockets();
      const othersPresent = socketsInRoom.some((s) => s.id !== socket.id);

      if (othersPresent) {
        msg.status = "delivered";
        if (dbConnected) {
          await Message.findByIdAndUpdate(msg.id, { status: "delivered" });
        } else {
          const arr = inMemoryMessages.get(roomId) || [];
          const m = arr.find((x) => x.id === msg.id);
          if (m) m.status = "delivered";
        }
        io.to(roomId).emit("message_status_update", {
          id: msg.id,
          status: "delivered",
        });
      }
    });

    socket.on("clear_chat", ({ roomId }) => {
      if (!roomId) return;
      if (dbConnected) {
        Message.deleteMany({ roomId }).catch(() => {});
        if (!inMemoryMessages.has(roomId)) inMemoryMessages.delete(roomId);
      } else {
        inMemoryMessages.delete(roomId);
      }
      io.to(roomId).emit("chat_cleared");
    });

    socket.on("typing_start", ({ roomId }) => {
      socket
        .to(roomId)
        .emit("user_typing", { socketId: socket.id, name: socket.data.name });
    });

    socket.on("typing_stop", ({ roomId }) => {
      socket.to(roomId).emit("user_stop_typing", { socketId: socket.id });
    });

    socket.on("messages_seen", async ({ roomId, messageIds }) => {
      if (!roomId || !messageIds?.length) return;

      if (dbConnected) {
        await Message.updateMany(
          { _id: { $in: messageIds }, status: { $ne: "seen" } },
          { $set: { status: "seen" } }
        );
      } else {
        const arr = inMemoryMessages.get(roomId) || [];
        messageIds.forEach((id) => {
          const m = arr.find((x) => x.id === id);
          if (m) m.status = "seen";
        });
      }

      io.to(roomId).emit("messages_seen_ack", {
        messageIds,
        seenBy: socket.data.name,
      });
    });

    socket.on("disconnect", async () => {
      const { name, roomId } = socket.data;
      if (!roomId) return;

      if (dbConnected) {
        await removeParticipant(roomId, socket.id);
      } else {
        inMemoryRooms.get(roomId)?.delete(socket.id);
      }

      const participants = await getParticipants(roomId);
      io.to(roomId).emit("room_participants", participants);

      if (name) {
        io.to(roomId).emit(
          "system_message",
          buildSystemMessage(roomId, `${name} left the chat`)
        );
      }
    });
  });
}

function buildSystemMessage(roomId, text) {
  return {
    id: uuidv4(),
    roomId,
    system: true,
    content: text,
    timestamp: new Date().toISOString(),
  };
}

async function upsertRoomParticipant(roomId, name, socketId, clientId) {
  try {
    await Room.findOneAndUpdate(
      { roomId },
      { $pull: { participants: { $or: [{ socketId }, { name }] } } },
      { upsert: true, new: true }
    );
    await Room.findOneAndUpdate(
      { roomId },
      {
        $push: {
          participants: { name, socketId, clientId, joinedAt: new Date() },
        },
      }
    );
  } catch (err) {
    console.error("upsertRoomParticipant error:", err);
  }
}

async function removeParticipant(roomId, socketId) {
  try {
    await Room.findOneAndUpdate(
      { roomId },
      { $pull: { participants: { socketId } } }
    );
  } catch (err) {
    console.error("removeParticipant error:", err);
  }
}

async function getParticipants(roomId) {
  if (dbConnected) {
    const room = await Room.findOne({ roomId }).lean();
    return (room?.participants || []).map((p) => ({
      name: p.name,
      socketId: p.socketId,
    }));
  }
  const map = inMemoryRooms.get(roomId);
  if (!map) return [];
  const seen = new Set();
  const result = [];
  for (const [socketId, { name }] of map.entries()) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ socketId, name });
    }
  }
  return result;
}

async function getHistory(roomId, limit) {
  if (dbConnected) {
    try {
      const messages = await Message.find({ roomId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();
      return messages.reverse().map((m) => ({
        id: m._id.toString(),
        roomId: m.roomId,
        senderId: m.senderId,
        clientId: m.clientId || m.senderId,
        senderName: m.senderName,
        content: m.content,
        replyTo: m.replyTo || null,
        status: m.status,
        timestamp: m.timestamp,
      }));
    } catch (err) {
      return [];
    }
  }
  const arr = inMemoryMessages.get(roomId) || [];
  return arr.slice(-limit);
}

module.exports = { initSocketHandlers };
