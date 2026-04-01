const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri || uri.includes('<user>')) {
      console.log('⚠️  No MongoDB URI found. Running without persistence (in-memory mode).');
      return false;
    }

    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    return true;
  } catch (err) {
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    console.log('⚠️  Falling back to in-memory mode.');
    return false;
  }
};

module.exports = connectDB;
