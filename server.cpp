
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/strand.hpp>
#include <boost/asio/steady_timer.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <deque>
#include <thread>
#include <unordered_map>
#include <vector>

namespace beast     = boost::beast;
namespace http      = beast::http;
namespace websocket = beast::websocket;
namespace net       = boost::asio;
using tcp           = net::ip::tcp;

static std::string jstr(const std::string& s) {
    std::string r = "\"";
    for (char c : s) {
        if (c == '"')  r += "\\\"";
        else if (c == '\\') r += "\\\\";
        else r += c;
    }
    return r + "\"";
}
static std::string jnum(double v) {
    std::ostringstream ss; ss << v; return ss.str();
}
static std::string jbool(bool v) { return v ? "true" : "false"; }

static std::string jsonGet(const std::string& src, const std::string& key)
{
    std::string needle = "\"" + key + "\"";
    auto pos = src.find(needle);

    if (pos == std::string::npos) return "";
    pos += needle.size();
    
    while (pos < src.size() && (src[pos] == ' ' || src[pos] == ':')) ++pos;

    if (pos >= src.size()) return "";

    if (src[pos] == '"')
    {
        ++pos;
        std::string val;
        
        while (pos < src.size() && src[pos] != '"') {
            if (src[pos] == '\\') ++pos;
            val += src[pos++];
        }
        return val;
    }
    // number / bool / null
    std::string val;
    while (pos < src.size() && src[pos] != ',' && src[pos] != '}' && src[pos] != ']')
        val += src[pos++];
    // trim
    while (!val.empty() && val.back() == ' ') val.pop_back();
    return val;
}

constexpr double COURT_W   = 10.0;
constexpr double COURT_H   = 20.0;
constexpr double WALL_H    = 4.0;
constexpr double BALL_R    = 0.15;
constexpr double PADDLE_W  = 1.2;
constexpr double PADDLE_H  = 1.4;
constexpr double PADDLE_D  = 0.12;
constexpr double BALL_SPD  = 12.0;
constexpr double TICK      = 1.0 / 60.0;
constexpr int    WIN_SCORE = 7;
constexpr double GRAVITY   = 9.8;

static std::mt19937 rng(std::random_device{}());
static double randf(double lo, double hi) {
    return lo + (hi - lo) * std::uniform_real_distribution<double>(0.0, 1.0)(rng);
}

struct Ball {
    double x=0, y=1.5, z=0;
    double vx=0, vy=4, vz=BALL_SPD;
    int bounces=0;
};

struct Player {
    std::string id;
    std::string name;
    int    side  = 1;   
    double x     = 0;
    double z     = 0;
    int    score = 0;
    bool   wantsRestart = false;
};

struct Room;
using RoomPtr = std::shared_ptr<Room>;

struct WsSession;
using WsSessionPtr = std::shared_ptr<WsSession>;
using WsSessionWeak = std::weak_ptr<WsSession>;

struct WsSession : public std::enable_shared_from_this<WsSession> {
    websocket::stream<tcp::socket> ws_;
    beast::flat_buffer buf_;
    std::string id_;
    std::string playerName_;

    std::mutex          sendMtx_;
    std::deque<std::string> sendQ_;
    bool sending_ = false;

    explicit WsSession(tcp::socket sock)
        : ws_(std::move(sock))
    {
        // Generate unique ID
        static std::atomic<uint64_t> counter{1};
        id_ = "s" + std::to_string(counter++);
    }

    void start() {
        ws_.async_accept([self=shared_from_this()](beast::error_code ec){
            if (!ec) self->doRead();
        });
    }

    void doRead() {
        ws_.async_read(buf_, [self=shared_from_this()](beast::error_code ec, std::size_t){
            if (ec) { self->onDisconnect(); return; }
            std::string msg = beast::buffers_to_string(self->buf_.data());
            self->buf_.consume(self->buf_.size());
            self->onMessage(msg);
            self->doRead();
        });
    }

    void send(const std::string& msg) {
        std::lock_guard<std::mutex> lk(sendMtx_);
        sendQ_.push_back(msg);
        if (!sending_) doSend();
    }

    void doSend() {
        if (sendQ_.empty()) { sending_ = false; return; }
        sending_ = true;
        auto msg = std::make_shared<std::string>(sendQ_.front());
        sendQ_.pop_front();
        ws_.async_write(net::buffer(*msg),
            [self=shared_from_this(), msg](beast::error_code ec, std::size_t){
                std::lock_guard<std::mutex> lk(self->sendMtx_);
                if (ec) { self->sending_ = false; return; }
                self->doSend();
            });
    }


    void onMessage(const std::string& msg);
    void onDisconnect();
};

struct Room : public std::enable_shared_from_this<Room> {
    std::string id;
    std::map<std::string, Player> players;  
    Ball   ball;
    std::string state = "countdown";  
    int    countdown  = 3;
    double countdownTimer = 0.0;

    std::map<std::string, WsSessionWeak> sessions;

    // Timer for game tick
    std::shared_ptr<net::steady_timer> ticker;

    Ball makeBall() {
        Ball b;
        b.x  = 0; b.y = 1.5; b.z = 0;
        b.vx = randf(-2, 2);
        b.vy = 4.0;
        b.vz = BALL_SPD * (randf(0,1) > 0.5 ? 1 : -1);
        b.bounces = 0;
        return b;
    }

    void resetBall(const std::string& scorerId) {
        ball = makeBall();
        // Serve toward the loser
        for (auto& [id, p] : players) {
            if (id != scorerId) {
                ball.vz = (p.side > 0) ? BALL_SPD : -BALL_SPD;
                break;
            }
        }
    }

    // Broadcast a raw JSON string to all sessions in this room
    void broadcast(const std::string& msg) {
        for (auto& [id, wp] : sessions) {
            if (auto sp = wp.lock()) sp->send(msg);
        }
    }

    // Send to one session
    void sendTo(const std::string& sid, const std::string& msg) {
        auto it = sessions.find(sid);
        if (it != sessions.end()) {
            if (auto sp = it->second.lock()) sp->send(msg);
        }
    }

    // Build gameState JSON
    std::string buildGameState() {
        std::string ps = "[";
        bool first = true;
        for (auto& [id, p] : players) {
            if (!first) ps += ",";
            first = false;
            ps += "{\"id\":" + jstr(p.id) +
                  ",\"x\":"  + jnum(p.x)  +
                  ",\"z\":"  + jnum(p.z)  +
                  ",\"score\":" + std::to_string(p.score) +
                  ",\"name\":" + jstr(p.name) + "}";
        }
        ps += "]";
        return "{\"event\":\"gameState\","
               "\"ball\":{\"x\":" + jnum(ball.x) +
               ",\"y\":"  + jnum(ball.y) +
               ",\"z\":"  + jnum(ball.z) + "},"
               "\"players\":" + ps + "}";
    }

    void scorePoint(const std::string& scorerId) {
        auto& scorer = players[scorerId];
        scorer.score++;

        // Build scored event
        std::string ps = "[";
        bool first = true;
        for (auto& [id, p] : players) {
            if (!first) ps += ",";
            first = false;
            ps += "{\"id\":" + jstr(p.id) +
                  ",\"score\":" + std::to_string(p.score) +
                  ",\"name\":" + jstr(p.name) + "}";
        }
        ps += "]";
        broadcast("{\"event\":\"scored\",\"scorer\":" + jstr(scorer.name) +
                  ",\"players\":" + ps + "}");

        if (scorer.score >= WIN_SCORE) {
            state = "gameover";
            broadcast("{\"event\":\"gameover\",\"winner\":" + jstr(scorer.name) + "}");
            if (ticker) ticker->cancel();
            return;
        }

        state = "countdown";
        countdown = 3;
        countdownTimer = 0.0;
        resetBall(scorerId);
        broadcast("{\"event\":\"countdown\",\"n\":3}");
    }

    static double clamp(double v, double lo, double hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    void tick() {
        if (state == "countdown") {
            countdownTimer += TICK;
            if (countdownTimer >= 1.0) {
                countdownTimer = 0.0;
                countdown--;
                if (countdown <= 0) state = "playing";
                broadcast("{\"event\":\"countdown\",\"n\":" + std::to_string(countdown) + "}");
            }
            return;
        }
        if (state != "playing") return;

        double hw = COURT_W / 2.0;
        double hh = COURT_H / 2.0;

        ball.x += ball.vx * TICK;
        ball.y += ball.vy * TICK;
        ball.z += ball.vz * TICK;
        ball.vy -= GRAVITY * TICK;

        // Floor
        if (ball.y <= BALL_R) {
            ball.y  = BALL_R;
            ball.vy = std::abs(ball.vy) * 0.72;
            ball.vx *= 0.88;
            ball.vz *= 0.88;
            ball.bounces++;
        }

        // Side walls
        if (ball.x >  hw - BALL_R) { ball.x =  hw - BALL_R; ball.vx = -std::abs(ball.vx) * 0.85; }
        if (ball.x < -(hw - BALL_R)) { ball.x = -(hw - BALL_R); ball.vx =  std::abs(ball.vx) * 0.85; }

        // Back walls
        if (ball.z > hh - BALL_R) {
            if (ball.y <= WALL_H) {
                ball.z = hh - BALL_R;
                ball.vz = -std::abs(ball.vz) * 0.75;
            } else {
                // Out — side +1 loses
                std::string sid;
                for (auto& [id, p] : players) if (p.side == -1) { sid = id; break; }
                if (!sid.empty()) scorePoint(sid);
                return;
            }
        }
        if (ball.z < -(hh - BALL_R)) {
            if (ball.y <= WALL_H) {
                ball.z = -(hh - BALL_R);
                ball.vz = std::abs(ball.vz) * 0.75;
            } else {
                std::string sid;
                for (auto& [id, p] : players) if (p.side == 1) { sid = id; break; }
                if (!sid.empty()) scorePoint(sid);
                return;
            }
        }

        // Net
        if (std::abs(ball.z) < 0.12 && ball.y < 1.0) {
            int loseSide = ball.vz > 0 ? 1 : -1;
            std::string sid;
            for (auto& [id, p] : players) if (p.side == loseSide) { sid = id; break; }
            if (!sid.empty()) scorePoint(sid);
            return;
        }

        // Paddle collisions
        for (auto& [id, p] : players) {
            double dz = ball.z - p.z;
            double dx = ball.x - p.x;
            double dy = ball.y - 0.9;
            if (std::abs(dz) < PADDLE_D + BALL_R &&
                std::abs(dx) < PADDLE_W/2 + BALL_R &&
                std::abs(dy) < PADDLE_H/2 + BALL_R)
            {
                double sign = dz >= 0 ? 1.0 : -1.0;
                ball.vz = sign * (BALL_SPD + ball.bounces*0.5 + randf(0,3));
                ball.vy = std::abs(ball.vy)*0.6 + 4.0;
                ball.vx += (dx / (PADDLE_W/2)) * 5.0;
                ball.bounces = 0;
                ball.z = p.z + sign*(PADDLE_D + BALL_R + 0.01);
            }
        }

        // Fell through
        if (ball.y < -2.0) {
            int side = ball.vz > 0 ? 1 : -1;
            std::string sid;
            for (auto& [id, p] : players) if (p.side == side) { sid = id; break; }
            if (!sid.empty()) scorePoint(sid);
            return;
        }

        broadcast(buildGameState());
    }
};

struct Server {
    std::mutex                                     mtx;
    std::map<std::string, WsSessionWeak>           sessions;   // id → session
    std::map<std::string, RoomPtr>                 rooms;      // roomId → room
    std::string                                    waitingId;  // socket id waiting
    net::io_context&                               ioc;

    explicit Server(net::io_context& ioc) : ioc(ioc) {}

    void addSession(WsSessionPtr s) {
        std::lock_guard<std::mutex> lk(mtx);
        sessions[s->id_] = s;
        std::cout << "[+] Connected: " << s->id_ << "\n";
    }

    void onJoinGame(WsSessionPtr sess, const std::string& name) {
        std::lock_guard<std::mutex> lk(mtx);
        sess->playerName_ = name.substr(0, 16);

        if (!waitingId.empty() && waitingId != sess->id_) {
            // Match!
            std::string p1id = waitingId;
            std::string p2id = sess->id_;
            waitingId.clear();

            auto wp1 = sessions.find(p1id);
            if (wp1 == sessions.end()) {
                // p1 gone, just wait again
                waitingId = p2id;
                sess->send("{\"event\":\"waiting\"}");
                return;
            }
            auto sp1 = wp1->second.lock();
            if (!sp1) {
                waitingId = p2id;
                sess->send("{\"event\":\"waiting\"}");
                return;
            }

            auto room = std::make_shared<Room>();
            room->id = p1id + "_" + p2id;

            Player player1;
            player1.id   = p1id;
            player1.name = sp1->playerName_.empty() ? "Player 1" : sp1->playerName_;
            player1.side = 1;
            player1.z    = COURT_H/2 - 1;

            Player player2;
            player2.id   = p2id;
            player2.name = sess->playerName_.empty() ? "Player 2" : sess->playerName_;
            player2.side = -1;
            player2.z    = -(COURT_H/2 - 1);

            room->players[p1id] = player1;
            room->players[p2id] = player2;
            room->sessions[p1id] = sp1;
            room->sessions[p2id] = sess;
            room->ball   = room->makeBall();
            room->state  = "countdown";
            room->countdown = 3;
            room->countdownTimer = 0.0;

            rooms[room->id] = room;

            // Build matchFound
            std::string ps = "[";
            bool first = true;
            for (auto& [id, p] : room->players) {
                if (!first) ps += ",";
                first = false;
                ps += "{\"id\":" + jstr(p.id) +
                      ",\"name\":" + jstr(p.name) +
                      ",\"side\":" + std::to_string(p.side) + "}";
            }
            ps += "]";
            std::string matchMsg = "{\"event\":\"matchFound\",\"roomId\":" +
                                   jstr(room->id) + ",\"players\":" + ps + "}";
            room->broadcast(matchMsg);
            room->broadcast("{\"event\":\"countdown\",\"n\":3}");

            // Start tick timer
            auto timer = std::make_shared<net::steady_timer>(ioc);
            room->ticker = timer;
            scheduleRoomTick(room, timer);

            std::cout << "[MATCH] " << player1.name << " vs " << player2.name << "\n";
        } else {
            waitingId = sess->id_;
            sess->send("{\"event\":\"waiting\"}");
        }
    }

    void scheduleRoomTick(RoomPtr room, std::shared_ptr<net::steady_timer> timer) {
        timer->expires_after(std::chrono::milliseconds(static_cast<int>(TICK * 1000)));
        timer->async_wait([this, room, timer](boost::system::error_code ec) {
            if (ec) return; // cancelled
            {
                std::lock_guard<std::mutex> lk(mtx);
                if (rooms.find(room->id) == rooms.end()) return;
            }
            room->tick();
            scheduleRoomTick(room, timer);
        });
    }

    void onPaddleMove(const std::string& sid, double x, double z) {
        std::lock_guard<std::mutex> lk(mtx);
        for (auto& [rid, room] : rooms) {
            auto it = room->players.find(sid);
            if (it != room->players.end()) {
                double hw = COURT_W/2 - PADDLE_W/2;
                double hh = COURT_H/2 - PADDLE_D;
                it->second.x = Room::clamp(x, -hw, hw);
                it->second.z = Room::clamp(z, -hh, hh);
                break;
            }
        }
    }

    void onRestartGame(const std::string& sid) {
        std::lock_guard<std::mutex> lk(mtx);
        for (auto& [rid, room] : rooms) {
            auto it = room->players.find(sid);
            if (it != room->players.end()) {
                it->second.wantsRestart = true;
                bool allWant = true;
                for (auto& [pid, p] : room->players) {
                    if (!p.wantsRestart) { allWant = false; break; }
                }
                if (allWant) {
                    for (auto& [pid, p] : room->players) {
                        p.score = 0; p.wantsRestart = false;
                    }
                    room->ball  = room->makeBall();
                    room->state = "countdown";
                    room->countdown = 3;
                    room->countdownTimer = 0.0;
                    room->broadcast("{\"event\":\"gameRestarted\"}");
                    room->broadcast("{\"event\":\"countdown\",\"n\":3}");
                    // Restart ticker if needed
                    if (!room->ticker) {
                        auto timer = std::make_shared<net::steady_timer>(ioc);
                        room->ticker = timer;
                        scheduleRoomTick(room, timer);
                    }
                } else {
                    std::string nm = it->second.name;
                    room->broadcast("{\"event\":\"waitingForRestart\",\"name\":" + jstr(nm) + "}");
                }
                break;
            }
        }
    }

    void onDisconnect(const std::string& sid) {
        std::lock_guard<std::mutex> lk(mtx);
        sessions.erase(sid);
        if (waitingId == sid) waitingId.clear();
        std::cout << "[-] Disconnected: " << sid << "\n";

        for (auto it = rooms.begin(); it != rooms.end(); ++it) {
            auto& room = it->second;
            if (room->players.count(sid)) {
                // Notify remaining player
                for (auto& [pid, p] : room->players) {
                    if (pid != sid) {
                        if (auto sp = room->sessions[pid].lock())
                            sp->send("{\"event\":\"opponentLeft\"}");
                    }
                }
                if (room->ticker) room->ticker->cancel();
                rooms.erase(it);
                break;
            }
        }
    }
};


static Server* g_server = nullptr;

void WsSession::onMessage(const std::string& msg) {
    if (!g_server) return;
    std::string event = jsonGet(msg, "event");

    if (event == "joinGame") {
        std::string name = jsonGet(msg, "name");
        if (name.empty()) name = "Player";
        g_server->onJoinGame(shared_from_this(), name);

    } else if (event == "paddleMove") {
        double x = std::stod(jsonGet(msg, "x").empty() ? "0" : jsonGet(msg, "x"));
        double z = std::stod(jsonGet(msg, "z").empty() ? "0" : jsonGet(msg, "z"));
        g_server->onPaddleMove(id_, x, z);

    } else if (event == "restartGame") {
        g_server->onRestartGame(id_);
    }
}

void WsSession::onDisconnect() {
    if (g_server) g_server->onDisconnect(id_);
}

class HttpSession : public std::enable_shared_from_this<HttpSession> {
    tcp::socket                    sock_;
    beast::flat_buffer             buf_;
    http::request<http::string_body> req_;

public:
    explicit HttpSession(tcp::socket s) : sock_(std::move(s)) {}

    void run() { doRead(); }

    void doRead() {
        http::async_read(sock_, buf_, req_,
            [self=shared_from_this()](beast::error_code ec, std::size_t) {
                if (!ec) self->handleRequest();
            });
    }

    void handleRequest()
    {
        if (websocket::is_upgrade(req_))
        {
            auto ws = std::make_shared<WsSession>(std::move(sock_));

            if (g_server) g_server->addSession(ws);
            ws->ws_.async_accept(req_, [ws](beast::error_code ec) {
                if (!ec) ws->doRead();
            });
            return;
        }

        std::string target = std::string(req_.target());
        if (target == "/" || target.empty()) target = "/index.html";

        auto qpos = target.find('?');
        if (qpos != std::string::npos) target = target.substr(0, qpos);

        if (target.find("..") != std::string::npos) {
            sendError(http::status::bad_request, "Bad path");
            return;
        }

        std::string path = "./public" + target;
        std::ifstream file(path, std::ios::binary);
        if (!file) { sendError(http::status::not_found, "Not found"); return; }

        std::string body((std::istreambuf_iterator<char>(file)),
                          std::istreambuf_iterator<char>());

        auto endsWith = [](const std::string& str, const std::string& suffix) -> bool
        {
            if (suffix.size() > str.size())
            {
                return false;
            }
            return str.rfind(suffix) == (str.size() - suffix.size());
        };

        auto mime = [&endsWith](const std::string& p) -> std::string
        {
            if (endsWith(p, ".html")) return "text/html";
            if (endsWith(p, ".js"))   return "application/javascript";
            if (endsWith(p, ".css"))  return "text/css";
            if (endsWith(p, ".png"))  return "image/png";
            return "application/octet-stream";
        };

        http::response<http::string_body> res{http::status::ok, req_.version()};
        res.set(http::field::content_type, mime(path));
        res.set(http::field::access_control_allow_origin, "*");
        res.content_length(body.size());
        res.body() = std::move(body);
        res.prepare_payload();

        auto sp = std::make_shared<http::response<http::string_body>>(std::move(res));
        http::async_write(sock_, *sp,
            [self=shared_from_this(), sp](beast::error_code, std::size_t){});
    }

    void sendError(http::status status, const std::string& msg) {
        http::response<http::string_body> res{status, req_.version()};
        res.set(http::field::content_type, "text/plain");
        res.body() = msg;
        res.prepare_payload();
        auto sp = std::make_shared<http::response<http::string_body>>(std::move(res));
        http::async_write(sock_, *sp,
            [self=shared_from_this(), sp](beast::error_code, std::size_t){});
    }
};

class Listener : public std::enable_shared_from_this<Listener> {
    net::io_context& ioc_;
    tcp::acceptor    acceptor_;

public:
    Listener(net::io_context& ioc, tcp::endpoint ep)
        : ioc_(ioc), acceptor_(ioc)
    {
        beast::error_code ec;
        acceptor_.open(ep.protocol(), ec);
        acceptor_.set_option(net::socket_base::reuse_address(true), ec);
        acceptor_.bind(ep, ec);
        acceptor_.listen(net::socket_base::max_listen_connections, ec);
        if (ec) { std::cerr << "Listener error: " << ec.message() << "\n"; }
    }

    void run() { doAccept(); }

    void doAccept() {
        acceptor_.async_accept(
            [self=shared_from_this()](beast::error_code ec, tcp::socket sock) {
                if (!ec)
                    std::make_shared<HttpSession>(std::move(sock))->run();
                self->doAccept();
            });
    }
};

int main() {
    unsigned short port = 3000;
    const char* envPort = std::getenv("PORT");
    if (envPort) port = static_cast<unsigned short>(std::atoi(envPort));

    net::io_context ioc{1};

    Server srv(ioc);
    g_server = &srv;

    auto ep = tcp::endpoint{tcp::v4(), port};
    auto listener = std::make_shared<Listener>(ioc, ep);
    listener->run();

    std::cout << "Padel 3D C++ server listening on port " << port << "\n";
    ioc.run();
    return 0;
}
