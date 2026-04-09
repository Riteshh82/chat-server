const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    clientId: { type: String },
    senderName: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true, maxlength: 4000 },
    replyTo: {
      id: { type: String },
      content: { type: String },
      senderName: { type: String },
    },
    status: {
      type: String,
      enum: ["sent", "delivered", "seen"],
      default: "sent",
    },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

MessageSchema.index({ roomId: 1, timestamp: 1 });

module.exports = mongoose.model("Message", MessageSchema);
