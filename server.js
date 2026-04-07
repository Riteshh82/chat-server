require('dotenv').config();

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const { initSocketHandlers } = require('./socket/handlers');

const app    = express();
const server = http.createServer(app);

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
app.use(cors({
  origin: [CLIENT_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));
app.use("/api", require("./routes/news"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const io = new Server(server, {
  cors: {
    origin: [CLIENT_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.json({
    app:     'ChatApp Backend',
    version: '1.0.0',
    status:  'running',
    docs:    'GET /api/health',
  });
});

const PORT = process.env.PORT || 5001;

(async () => {
  const dbOk = await connectDB();
  initSocketHandlers(io, dbOk);

  server.listen(PORT, () => {
    console.log(`Listening on  http://localhost:${PORT}`);
    console.log(`DB:  ${dbOk ? 'MongoDB Atlas' : 'In-memory (no DB)'}`);
  });
})();
