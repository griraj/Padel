/**
 * server_fallback.js  —  Node.js + Socket.io game server
 */
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ──────────────────────────────────────────────────
const COURT_W   = 10;
const COURT_H   = 20;
const WALL_H    = 4;
const BALL_R    = 0.15;
const PADDLE_W  = 1.2;
const PADDLE_H  = 1.4;
const PADDLE_D  = 0.12;
const BALL_SPD  = 12;
const TICK      = 1 / 60;
const WIN_SCORE = 7;

// ── State ──────────────────────────────────────────────────────
const rooms = {};
let   waitingSocket = null;  // the socket currently waiting for a match

// ── Helpers ────────────────────────────────────────────────────
function clamp(v, lo, hi)
{
    return Math.max(lo, Math.min(hi, v));
}

function makeBall()
{
    return {
        x: 0, y: 1.5, z: 0,
        vx: (Math.random() - 0.5) * 4,
        vy: 4,
        vz: BALL_SPD * (Math.random() > 0.5 ? 1 : -1),
        bounces: 0
    };
}

function makeRoom(p1Socket, p1Name, p2Socket, p2Name)
{
    const id = p1Socket.id + '_' + p2Socket.id;
    return {
        id,
        players: {
            [p1Socket.id]: { id: p1Socket.id, name: p1Name, side:  1, x: 0, z:  COURT_H / 2 - 1, score: 0, wantsRestart: false },
            [p2Socket.id]: { id: p2Socket.id, name: p2Name, side: -1, x: 0, z: -(COURT_H / 2 - 1), score: 0, wantsRestart: false }
        },
        ball: makeBall(),
        state: 'countdown',
        countdown: 3,
        countdownTimer: 0,
        interval: null
    };
}

function scorePoint(room, scorerId)
{
    if (!scorerId || !room.players[scorerId])
    {
        return;
    }

    const scorer = room.players[scorerId];
    scorer.score++;

    const playerList = Object.values(room.players).map(p => ({
        id: p.id, score: p.score, name: p.name
    }));

    io.to(room.id).emit('scored', { scorer: scorer.name, players: playerList });

    if (scorer.score >= WIN_SCORE)
    {
        room.state = 'gameover';
        io.to(room.id).emit('gameover', { winner: scorer.name });
        clearInterval(room.interval);
        room.interval = null;
        return;
    }

    // Reset for next point
    const ball   = makeBall();
    const loser  = Object.values(room.players).find(p => p.id !== scorerId);
    if (loser)
    {
        ball.vz = loser.side > 0 ? BALL_SPD : -BALL_SPD;
    }
    room.ball          = ball;
    room.state         = 'countdown';
    room.countdown     = 3;
    room.countdownTimer = 0;
    io.to(room.id).emit('countdown', 3);
}

function tickRoom(room)
{
    // ── Countdown ──────────────────────────────────────────
    if (room.state === 'countdown')
    {
        room.countdownTimer += TICK;
        if (room.countdownTimer >= 1)
        {
            room.countdownTimer = 0;
            room.countdown--;
            if (room.countdown <= 0)
            {
                room.state = 'playing';
            }
            io.to(room.id).emit('countdown', room.countdown);
        }
        return;
    }

    if (room.state !== 'playing')
    {
        return;
    }

    // ── Physics ────────────────────────────────────────────
    const b  = room.ball;
    const hw = COURT_W / 2;
    const hh = COURT_H / 2;

    b.x  += b.vx * TICK;
    b.y  += b.vy * TICK;
    b.z  += b.vz * TICK;
    b.vy -= 9.8  * TICK;

    // Floor
    if (b.y <= BALL_R)
    {
        b.y  = BALL_R;
        b.vy = Math.abs(b.vy) * 0.72;
        b.vx *= 0.88;
        b.vz *= 0.88;
        b.bounces++;
    }

    // Side walls
    if (b.x > hw - BALL_R)
    {
        b.x  =  hw - BALL_R;
        b.vx = -Math.abs(b.vx) * 0.85;
    }
    if (b.x < -(hw - BALL_R))
    {
        b.x  = -(hw - BALL_R);
        b.vx =  Math.abs(b.vx) * 0.85;
    }

    // Back wall +Z
    if (b.z > hh - BALL_R)
    {
        if (b.y <= WALL_H)
        {
            b.z  = hh - BALL_R;
            b.vz = -Math.abs(b.vz) * 0.75;
        }
        else
        {
            const loser = Object.values(room.players).find(p => p.side === -1);
            scorePoint(room, loser?.id);
            return;
        }
    }

    // Back wall -Z
    if (b.z < -(hh - BALL_R))
    {
        if (b.y <= WALL_H)
        {
            b.z  = -(hh - BALL_R);
            b.vz =  Math.abs(b.vz) * 0.75;
        }
        else
        {
            const loser = Object.values(room.players).find(p => p.side === 1);
            scorePoint(room, loser?.id);
            return;
        }
    }

    // Net
    if (Math.abs(b.z) < 0.12 && b.y < 1.0)
    {
        const loseSide = b.vz > 0 ? 1 : -1;
        const loser    = Object.values(room.players).find(p => p.side === loseSide);
        scorePoint(room, loser?.id);
        return;
    }

    // Paddle collisions
    for (const p of Object.values(room.players))
    {
        const dz = b.z - p.z;
        const dx = b.x - p.x;
        const dy = b.y - 0.9;

        if (Math.abs(dz) < PADDLE_D + BALL_R &&
            Math.abs(dx) < PADDLE_W / 2 + BALL_R &&
            Math.abs(dy) < PADDLE_H / 2 + BALL_R)
        {
            const sign = dz >= 0 ? 1 : -1;
            b.vz       = sign * (BALL_SPD + b.bounces * 0.5 + Math.random() * 3);
            b.vy       = Math.abs(b.vy) * 0.6 + 4;
            b.vx      += (dx / (PADDLE_W / 2)) * 5;
            b.bounces  = 0;
            b.z        = p.z + sign * (PADDLE_D + BALL_R + 0.01);
        }
    }

    // Fell through floor
    if (b.y < -2)
    {
        const loseSide = b.vz > 0 ? 1 : -1;
        const loser    = Object.values(room.players).find(p => p.side === loseSide);
        scorePoint(room, loser?.id);
        return;
    }

    // Broadcast game state
    io.to(room.id).emit('gameState', {
        ball: { x: b.x, y: b.y, z: b.z },
        players: Object.values(room.players).map(p => ({
            id: p.id, x: p.x, z: p.z, score: p.score, name: p.name
        }))
    });
}

// ── Socket.io ──────────────────────────────────────────────────
io.on('connection', (socket) =>
{
    console.log('[+] connected:', socket.id);

    socket.on('joinGame', (data) =>
    {
        const name = (data?.name || 'Player').substring(0, 16);
        console.log('[joinGame]', socket.id, 'name:', name, '| waiting:', waitingSocket?.id ?? 'none');

        if (waitingSocket && waitingSocket.id !== socket.id)
        {
            // ── Match found ────────────────────────────────
            const p1     = waitingSocket;
            const p1Name = p1._padelName || 'Player 1';
            waitingSocket = null;

            const room = makeRoom(p1, p1Name, socket, name);
            rooms[room.id] = room;

            p1.join(room.id);
            socket.join(room.id);

            console.log('[MATCH]', p1Name, 'vs', name, '| room:', room.id);

            const playerList = Object.values(room.players).map(p => ({
                id: p.id, name: p.name, side: p.side
            }));

            io.to(room.id).emit('matchFound', { roomId: room.id, players: playerList });
            io.to(room.id).emit('countdown', 3);

            room.interval = setInterval(() =>
            {
                if (rooms[room.id])
                {
                    tickRoom(room);
                }
                else
                {
                    clearInterval(room.interval);
                }
            }, TICK * 1000);
        }
        else
        {
            // ── Wait for opponent ──────────────────────────
            waitingSocket          = socket;
            waitingSocket._padelName = name;
            console.log('[waiting]', socket.id, 'queued');
            socket.emit('waiting', {});
        }
    });

    socket.on('paddleMove', (data) =>
    {
        for (const room of Object.values(rooms))
        {
            const player = room.players[socket.id];
            if (player)
            {
                player.x = clamp(data.x, -(COURT_W / 2 - PADDLE_W / 2), COURT_W / 2 - PADDLE_W / 2);
                player.z = clamp(data.z, -COURT_H / 2, COURT_H / 2);
                break;
            }
        }
    });

    socket.on('restartGame', () =>
    {
        for (const room of Object.values(rooms))
        {
            const player = room.players[socket.id];
            if (player)
            {
                player.wantsRestart = true;
                const allWant = Object.values(room.players).every(p => p.wantsRestart);

                if (allWant)
                {
                    Object.values(room.players).forEach(p =>
                    {
                        p.score        = 0;
                        p.wantsRestart = false;
                    });

                    room.ball           = makeBall();
                    room.state          = 'countdown';
                    room.countdown      = 3;
                    room.countdownTimer = 0;

                    io.to(room.id).emit('gameRestarted');
                    io.to(room.id).emit('countdown', 3);

                    if (!room.interval)
                    {
                        room.interval = setInterval(() =>
                        {
                            if (rooms[room.id])
                            {
                                tickRoom(room);
                            }
                            else
                            {
                                clearInterval(room.interval);
                            }
                        }, TICK * 1000);
                    }
                }
                else
                {
                    io.to(room.id).emit('waitingForRestart', { name: player.name });
                }
                break;
            }
        }
    });

    socket.on('disconnect', () =>
    {
        console.log('[-] disconnected:', socket.id);

        if (waitingSocket?.id === socket.id)
        {
            waitingSocket = null;
        }

        for (const [roomId, room] of Object.entries(rooms))
        {
            if (room.players[socket.id])
            {
                const otherId = Object.keys(room.players).find(id => id !== socket.id);
                if (otherId)
                {
                    io.to(otherId).emit('opponentLeft');
                }
                clearInterval(room.interval);
                delete rooms[roomId];
                console.log('[room closed]', roomId);
                break;
            }
        }
    });
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
{
    console.log(`[server] Padel 3D listening on http://localhost:${PORT}`);
});