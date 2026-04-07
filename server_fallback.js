/**
 * server_fallback.js
 * Pure Node.js / Socket.io fallback — identical game logic to the C++ server.
 * Used automatically by start.js if C++ compilation fails on the host.
 */
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const COURT     = { W: 10, H: 20, WALL_H: 4 };
const BALL_R    = 0.15;
const PADDLE_W  = 1.2, PADDLE_H = 1.4, PADDLE_D = 0.12;
const BALL_SPD  = 12;
const TICK      = 1 / 60;
const WIN_SCORE = 7;

const rooms = {};
let waitingPlayer = null;

function mkBall() {
  return {
    x:0, y:1.5, z:0,
    vx:(Math.random()-0.5)*4, vy:4,
    vz: BALL_SPD*(Math.random()>0.5?1:-1),
    bounces:0
  };
}

function mkRoom(p1id, p2id) {
  return {
    id: p1id+'_'+p2id,
    players: {
      [p1id]:{ id:p1id, side:1,  x:0, z: COURT.H/2-1,  score:0, name:'Player 1' },
      [p2id]:{ id:p2id, side:-1, x:0, z:-(COURT.H/2-1), score:0, name:'Player 2' }
    },
    ball: mkBall(), state:'countdown', countdown:3, countdownTimer:0, interval:null
  };
}

const cl = (v,lo,hi) => Math.max(lo,Math.min(hi,v));

function scorePoint(room, scorerId) {
  if (!scorerId) return;
  const s = room.players[scorerId]; if (!s) return;
  s.score++;
  io.to(room.id).emit('scored',{ scorer:s.name, players:Object.values(room.players).map(p=>({id:p.id,score:p.score,name:p.name})) });
  if (s.score >= WIN_SCORE) {
    room.state = 'gameover';
    io.to(room.id).emit('gameover',{ winner:s.name });
    clearInterval(room.interval); return;
  }
  const b=mkBall();
  const loser=Object.values(room.players).find(p=>p.id!==scorerId);
  if(loser) b.vz=loser.side>0?BALL_SPD:-BALL_SPD;
  room.ball=b; room.state='countdown'; room.countdown=3; room.countdownTimer=0;
  io.to(room.id).emit('countdown',3);
}

function tick(room) {
  if (room.state==='countdown') {
    room.countdownTimer+=TICK;
    if (room.countdownTimer>=1){ room.countdownTimer=0; room.countdown--;
      if(room.countdown<=0) room.state='playing';
      io.to(room.id).emit('countdown',room.countdown); }
    return;
  }
  if (room.state!=='playing') return;
  const b=room.ball, hw=COURT.W/2, hh=COURT.H/2;
  b.x+=b.vx*TICK; b.y+=b.vy*TICK; b.z+=b.vz*TICK; b.vy-=9.8*TICK;
  if(b.y<=BALL_R){b.y=BALL_R;b.vy=Math.abs(b.vy)*0.72;b.vx*=0.88;b.vz*=0.88;b.bounces++;}
  if(b.x> hw-BALL_R){b.x= hw-BALL_R;b.vx=-Math.abs(b.vx)*0.85;}
  if(b.x<-(hw-BALL_R)){b.x=-(hw-BALL_R);b.vx=Math.abs(b.vx)*0.85;}
  if(b.z>hh-BALL_R){
    if(b.y<=COURT.WALL_H){b.z=hh-BALL_R;b.vz=-Math.abs(b.vz)*0.75;}
    else{scorePoint(room,Object.values(room.players).find(p=>p.side===-1)?.id);return;}
  }
  if(b.z<-(hh-BALL_R)){
    if(b.y<=COURT.WALL_H){b.z=-(hh-BALL_R);b.vz=Math.abs(b.vz)*0.75;}
    else{scorePoint(room,Object.values(room.players).find(p=>p.side===1)?.id);return;}
  }
  if(Math.abs(b.z)<0.12&&b.y<1.0){
    const side=b.vz>0?1:-1;
    scorePoint(room,Object.values(room.players).find(p=>p.side===-side)?.id);return;
  }
  for(const p of Object.values(room.players)){
    const dz=b.z-p.z,dx=b.x-p.x,dy=b.y-0.9;
    if(Math.abs(dz)<PADDLE_D+BALL_R&&Math.abs(dx)<PADDLE_W/2+BALL_R&&Math.abs(dy)<PADDLE_H/2+BALL_R){
      b.vz=-Math.sign(dz)*(BALL_SPD+b.bounces*0.5+Math.random()*3);
      b.vy=Math.abs(b.vy)*0.6+4;b.vx+=(dx/(PADDLE_W/2))*5;b.bounces=0;
      b.z=p.z+Math.sign(dz)*(PADDLE_D+BALL_R+0.01);
    }
  }
  if(b.y<-2){
    const side=b.vz>0?1:-1;
    scorePoint(room,Object.values(room.players).find(p=>p.side!==side)?.id);return;
  }
  io.to(room.id).emit('gameState',{
    ball:{x:b.x,y:b.y,z:b.z},
    players:Object.values(room.players).map(p=>({id:p.id,x:p.x,z:p.z,score:p.score,name:p.name}))
  });
}

io.on('connection',(socket)=>{
  console.log('+',socket.id);
  socket.on('joinGame',(data)=>{
    const name=(data?.name||'Player').substring(0,16);
    if(waitingPlayer&&waitingPlayer.id!==socket.id){
      const p1=waitingPlayer; waitingPlayer=null;
      const room=mkRoom(p1.id,socket.id);
      room.players[p1.id].name=p1._name||'Player 1';
      room.players[socket.id].name=name;
      rooms[room.id]=room; p1.join(room.id); socket.join(room.id);
      io.to(room.id).emit('matchFound',{roomId:room.id,players:Object.values(room.players).map(p=>({id:p.id,name:p.name,side:p.side}))});
      io.to(room.id).emit('countdown',3);
      room.interval=setInterval(()=>{ if(rooms[room.id])tick(room); else clearInterval(room.interval); },TICK*1000);
    } else { waitingPlayer=socket; socket._name=name; socket.emit('waiting',{}); }
  });
  socket.on('paddleMove',(d)=>{
    for(const room of Object.values(rooms)){
      const p=room.players[socket.id];
      if(p){p.x=cl(d.x,-(COURT.W/2-PADDLE_W/2),COURT.W/2-PADDLE_W/2);p.z=cl(d.z,-COURT.H/2,COURT.H/2);break;}
    }
  });
  socket.on('restartGame',()=>{
    for(const room of Object.values(rooms)){
      const p=room.players[socket.id];
      if(p){
        p.wantsRestart=true;
        if(Object.values(room.players).every(q=>q.wantsRestart)){
          Object.values(room.players).forEach(q=>{q.score=0;q.wantsRestart=false;});
          room.ball=mkBall();room.state='countdown';room.countdown=3;room.countdownTimer=0;
          io.to(room.id).emit('gameRestarted');io.to(room.id).emit('countdown',3);
        } else { io.to(room.id).emit('waitingForRestart',{name:p.name}); }
        break;
      }
    }
  });
  socket.on('disconnect',()=>{
    console.log('-',socket.id);
    if(waitingPlayer?.id===socket.id) waitingPlayer=null;
    for(const room of Object.values(rooms)){
      if(room.players[socket.id]){
        const other=Object.keys(room.players).find(id=>id!==socket.id);
        if(other) io.to(other).emit('opponentLeft');
        clearInterval(room.interval); delete rooms[room.id]; break;
      }
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`[fallback] Node.js server on port ${PORT}`));
