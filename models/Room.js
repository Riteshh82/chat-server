const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    participants: {
      type: [
        {
          name: String,
          socketId: String,
          joinedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Room', RoomSchema);
