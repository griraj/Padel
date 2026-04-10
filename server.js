const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Game Constants ──────────────────────────────────────────────
const COURT = { W: 10, H: 20, WALL_H: 4 };
const BALL_RADIUS = 0.15;
const PADDLE_W = 1.2, PADDLE_H = 1.4, PADDLE_D = 0.12;
const BALL_SPEED_INIT = 12;
const TICK = 1 / 60;
const WINNING_SCORE = 7;

// ── Room Management ─────────────────────────────────────────────
const rooms = {};
let waitingPlayer = null;

function createBall() {
  return {
    x: 0, y: 1.5, z: 0,
    vx: (Math.random() - 0.5) * 4,
    vy: 4,
    vz: BALL_SPEED_INIT * (Math.random() > 0.5 ? 1 : -1),
    bounces: 0
  };
}

function createRoom(p1id, p2id) {
  const room = {
    id: p1id + '_' + p2id,
    players: {
      [p1id]: { id: p1id, side: 1, x: 0, z: COURT.H / 2 - 1, score: 0, name: 'Player 1' },
      [p2id]: { id: p2id, side: -1, x: 0, z: -(COURT.H / 2 - 1), score: 0, name: 'Player 2' }
    },
    ball: createBall(),
    state: 'countdown',
    countdown: 3,
    countdownTimer: 0,
    interval: null,
    lastScorer: null
  };
  return room;
}

function resetBall(room, scorerId) {
  const b = createBall();
  // serve toward the player who just got scored on
  const loser = Object.values(room.players).find(p => p.id !== scorerId);
  if (loser) b.vz = loser.side > 0 ? BALL_SPEED_INIT : -BALL_SPEED_INIT;
  room.ball = b;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function tickRoom(room) {
  if (room.state === 'countdown') {
    room.countdownTimer += TICK;
    if (room.countdownTimer >= 1) {
      room.countdownTimer = 0;
      room.countdown--;
      if (room.countdown <= 0) room.state = 'playing';
      io.to(room.id).emit('countdown', room.countdown);
    }
    return;
  }

  if (room.state !== 'playing') return;

  const b = room.ball;
  const hw = COURT.W / 2;
  const hh = COURT.H / 2;

  // Move ball
  b.x += b.vx * TICK;
  b.y += b.vy * TICK;
  b.z += b.vz * TICK;

  // Gravity
  b.vy -= 9.8 * TICK;

  // Floor bounce
  if (b.y <= BALL_RADIUS) {
    b.y = BALL_RADIUS;
    b.vy = Math.abs(b.vy) * 0.72;
    b.vx *= 0.88;
    b.vz *= 0.88;
    b.bounces++;
  }

  // Side walls
  if (b.x > hw - BALL_RADIUS) { b.x = hw - BALL_RADIUS; b.vx = -Math.abs(b.vx) * 0.85; }
  if (b.x < -(hw - BALL_RADIUS)) { b.x = -(hw - BALL_RADIUS); b.vx = Math.abs(b.vx) * 0.85; }

  // Back walls (glass)
  if (b.z > hh - BALL_RADIUS) {
    if (b.y <= COURT.WALL_H) {
      b.z = hh - BALL_RADIUS; b.vz = -Math.abs(b.vz) * 0.75;
    } else {
      scorePoint(room, Object.values(room.players).find(p => p.side === -1)?.id);
      return;
    }
  }
  if (b.z < -(hh - BALL_RADIUS)) {
    if (b.y <= COURT.WALL_H) {
      b.z = -(hh - BALL_RADIUS); b.vz = Math.abs(b.vz) * 0.75;
    } else {
      scorePoint(room, Object.values(room.players).find(p => p.side === 1)?.id);
      return;
    }
  }

  // Net collision (z=0)
  if (Math.abs(b.z) < 0.12 && b.y < 1.0) {
    // Ball hits net — point to other side
    const side = b.vz > 0 ? 1 : -1;
    const scorer = Object.values(room.players).find(p => p.side === -side);
    scorePoint(room, scorer?.id);
    return;
  }

  // Paddle collisions
  for (const p of Object.values(room.players)) {
    const pz = p.z;
    const px = p.x;
    const dz = b.z - pz;
    const dx = b.x - px;
    const dy = b.y - 0.9;

    if (Math.abs(dz) < PADDLE_D + BALL_RADIUS &&
        Math.abs(dx) < PADDLE_W / 2 + BALL_RADIUS &&
        Math.abs(dy) < PADDLE_H / 2 + BALL_RADIUS) {
      // Hit paddle
      b.vz = -Math.sign(dz) * (BALL_SPEED_INIT + b.bounces * 0.5 + Math.random() * 3);
      b.vy = Math.abs(b.vy) * 0.6 + 4;
      b.vx += (dx / (PADDLE_W / 2)) * 5;
      b.bounces = 0;
      b.z = pz + Math.sign(dz) * (PADDLE_D + BALL_RADIUS + 0.01);
    }
  }

  // Ball out of bounds vertically (too high — just let gravity bring it back)
  // Ball fell through floor
  if (b.y < -2) {
    // determine who lost — ball going toward which side
    const side = b.vz > 0 ? 1 : -1;
    const scorer = Object.values(room.players).find(p => p.side !== side);
    scorePoint(room, scorer?.id);
    return;
  }

  // Emit state
  io.to(room.id).emit('gameState', {
    ball: { x: b.x, y: b.y, z: b.z },
    players: Object.values(room.players).map(p => ({ id: p.id, x: p.x, z: p.z, score: p.score, name: p.name }))
  });
}

function scorePoint(room, scorerId) {
  if (!scorerId) return;
  const scorer = room.players[scorerId];
  if (!scorer) return;
  scorer.score++;

  io.to(room.id).emit('scored', {
    scorer: scorer.name,
    players: Object.values(room.players).map(p => ({ id: p.id, score: p.score, name: p.name }))
  });

  if (scorer.score >= WINNING_SCORE) {
    room.state = 'gameover';
    io.to(room.id).emit('gameover', { winner: scorer.name });
    clearInterval(room.interval);
    return;
  }

  room.state = 'countdown';
  room.countdown = 3;
  room.countdownTimer = 0;
  resetBall(room, scorerId);
  io.to(room.id).emit('countdown', room.countdown);
}

// ── Socket.io ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinGame', (data) => {
    const playerName = (data && data.name) ? data.name.substring(0, 16) : 'Player';

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      // Match found
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      const room = createRoom(p1.id, p2.id);
      room.players[p1.id].name = p1.playerName || 'Player 1';
      room.players[p2.id].name = playerName;

      rooms[room.id] = room;
      p1.join(room.id);
      p2.join(room.id);

      io.to(room.id).emit('matchFound', {
        roomId: room.id,
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, side: p.side }))
      });

      io.to(room.id).emit('countdown', 3);

      room.interval = setInterval(() => {
        if (rooms[room.id]) tickRoom(room);
        else clearInterval(room.interval);
      }, TICK * 1000);

    } else {
      waitingPlayer = socket;
      waitingPlayer.playerName = playerName;
      socket.emit('waiting', { message: 'Waiting for opponent...' });
    }
  });

  socket.on('paddleMove', (data) => {
    // Find room this socket is in
    for (const room of Object.values(rooms)) {
      const player = room.players[socket.id];
      if (player) {
        const hw = COURT.W / 2 - PADDLE_W / 2;
        const hh = COURT.H / 2 - PADDLE_D;
        player.x = clamp(data.x, -hw, hw);
        player.z = clamp(data.z, -hh, hh);
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    for (const room of Object.values(rooms)) {
      if (room.players[socket.id]) {
        const remaining = Object.keys(room.players).find(id => id !== socket.id);
        if (remaining) {
          io.to(remaining).emit('opponentLeft');
        }
        clearInterval(room.interval);
        delete rooms[room.id];
        break;
      }
    }
  });

  socket.on('restartGame', () => {
    for (const room of Object.values(rooms)) {
      if (room.players[socket.id]) {
        room.players[socket.id].wantsRestart = true;
        const allWant = Object.values(room.players).every(p => p.wantsRestart);
        if (allWant) {
          Object.values(room.players).forEach(p => { p.score = 0; p.wantsRestart = false; });
          room.ball = createBall();
          room.state = 'countdown';
          room.countdown = 3;
          room.countdownTimer = 0;
          io.to(room.id).emit('gameRestarted');
          io.to(room.id).emit('countdown', 3);
          if (!room.interval || room.interval._destroyed) {
            room.interval = setInterval(() => {
              if (rooms[room.id]) tickRoom(room);
              else clearInterval(room.interval);
            }, TICK * 1000);
          }
        } else {
          io.to(room.id).emit('waitingForRestart', { name: room.players[socket.id].name });
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Padel server running on port ${PORT}`));
