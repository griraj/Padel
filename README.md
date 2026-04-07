# 🎾 Padel 3D — Online Multiplayer

A real-time 3D multiplayer padel game built with Three.js + Socket.io, deployable on Render.

## Features
- ✅ Real-time multiplayer via WebSockets (Socket.io)
- ✅ Full 3D court with Three.js (glass walls, net, stadium lighting)
- ✅ Ball physics with gravity, wall bounces, spin
- ✅ Score tracking — first to 7 wins
- ✅ Countdown timer between points
- ✅ Mouse + keyboard controls
- ✅ Play Again system

---

## 🚀 Deploy to Render (5 minutes)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/padel-3d.git
git push -u origin main
```

### Step 2 — Deploy on Render
1. Go to [render.com](https://render.com) and sign in
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects settings from `render.yaml`:
   - **Build:** `npm install`
   - **Start:** `npm start`
5. Click **Deploy** — done! 🎉

Your game will be live at `https://padel-3d.onrender.com` (or similar)

---

## 🎮 Controls
| Input | Action |
|-------|--------|
| Mouse move | Move paddle left/right |
| A / ← | Move paddle left |
| D / → | Move paddle right |

---

## 🏗️ Project Structure
```
padel-game/
├── server.js          # Node.js + Socket.io game server + physics
├── public/
│   └── index.html     # Three.js 3D frontend (single file)
├── package.json
├── render.yaml        # Render deployment config
└── README.md
```

---

## 🔧 Run Locally
```bash
npm install
npm start
# Open http://localhost:3000 in two browser tabs
```

---

## ⚠️ Free Tier Note
Render's free tier spins down after 15 min of inactivity.
First load after idle takes ~30–50 seconds to wake up.
Upgrade to a paid plan ($7/mo) for always-on hosting.
