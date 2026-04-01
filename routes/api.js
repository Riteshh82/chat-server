const express = require('express');
const router = express.Router();
let Message, Room;
try {
  Message = require('../models/Message');
  Room    = require('../models/Room');
} catch (_) {}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

router.get('/messages/:roomId', async (req, res) => {
  try {
    if (!Message) {
      return res.json({ messages: [], inMemory: true });
    }

    const { roomId } = req.params;
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : new Date();

    const messages = await Message.find({ roomId, timestamp: { $lt: before } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({ messages: messages.reverse() });
  } catch (err) {
    console.error('GET /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});
router.get('/rooms/:roomId/participants', async (req, res) => {
  try {
    if (!Room) return res.json({ participants: [] });

    const room = await Room.findOne({ roomId: req.params.roomId }).lean();
    res.json({ participants: room?.participants || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch participants' });
  }
});

module.exports = router;
