"""Small loopback Discord wire fixture; uses no bot token, network service or dependencies."""

from base64 import b64encode
from hashlib import sha1
from http.server import BaseHTTPRequestHandler
import json
from queue import Empty, Queue
from select import select
import struct
from threading import Event
from urllib.parse import parse_qs, urlsplit


class World:
    def __init__(self):
        self.history = [message("100", "cataly-test: old history")]
        self.events = Queue()
        self.replies = Queue()
        self.callbacks = Queue()
        self.auth = Queue()
        self.cleared = Queue()
        self.heartbeat = Event()
        self.ready = Event()
        self.nonces = []
        self.rate_limit = False
        self.bound = 0
        self.seq = 10
        self.force_plain_reply = False
        self.reject_text = None
        self.presence = Queue()
        self.active_threads = []
        self.history_channels = set()
        self.discovery = Queue()
        self.typings = Queue()

    def dispatch(self, name, data):
        self.seq += 1
        self.events.put({"op": 0, "t": name, "s": self.seq, "d": data})

    def add(self, *messages):
        self.history.extend(messages)
        for item in messages:
            self.dispatch("MESSAGE_CREATE", item)

    def click(self, ident, custom_id, user="10", card="300"):
        self.dispatch("INTERACTION_CREATE", {
            "type": 3, "application_id": "99", "channel_id": "20", "id": ident,
            "token": "callback-local-only", "member": {"user": {"id": user}},
            "message": {"id": card}, "data": {"component_type": 2, "custom_id": custom_id},
        })


def message(ident, text, user="10", channel="20"):
    return {"id": ident, "channel_id": channel, "type": 0, "author": {"id": user}, "content": text}


class Discord(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def world(self):
        return self.server.world

    def log_message(self, *_args):
        pass

    def json(self, data=None, status=200):
        payload = json.dumps(data).encode() if data is not None else b""
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        if self.headers.get("Authorization") == "Bot synthetic-discord-token":
            return True
        self.json({}, 401)
        return False

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == "/gateway":
            self.websocket()
        elif self.authorized():
            if path.path == "/api/v10/users/@me":
                self.json({"id": "99", "bot": True, "avatar": "already-configured"})
            elif path.path == "/api/v10/applications/@me":
                self.json({"flags": 1 << 19})
            elif path.path.startswith("/api/v10/channels/") and path.path.endswith("/messages"):
                channel = path.path.split("/")[-2]
                self.world.history_channels.add(channel)
                query = parse_qs(path.query)
                limit = int(query["limit"][0])
                before = int(query.get("before", [str(2 ** 64)])[0])
                records = sorted((msg for msg in self.world.history if msg["channel_id"] == channel),
                                 key=lambda msg: int(msg["id"]), reverse=True)
                self.json([msg for msg in records if int(msg["id"]) < before][:limit])
            elif path.path in ("/api/v10/channels/20", "/api/v10/channels/21"):
                channel = path.path.rsplit("/", 1)[1]
                self.json({"id": channel, "type": 0 if channel == "20" else 15, "guild_id": "40"})
            elif path.path == "/api/v10/guilds/40/channels":
                self.json([{"id": "20", "type": 0, "name": "work"}])
            elif path.path == "/api/v10/guilds/40/threads/active":
                self.json({"threads": self.world.active_threads})
                self.world.discovery.put(True)
            else:
                self.json({}, 404)

    def do_POST(self):
        if self.path.startswith("/api/v10/interactions/"):
            data = json.loads(self.rfile.read(int(self.headers["content-length"])))
            assert self.headers.get("Authorization") is None
            assert self.path.endswith("/callback-local-only/callback")
            self.world.callbacks.put((self.path.split("/")[4], data))
            self.json(status=204)
        elif self.authorized() and self.path.startswith("/api/v10/channels/") and self.path.endswith("/typing"):
            self.world.typings.put(self.path.split("/")[-2])
            self.json(status=204)
        elif self.authorized() and self.path.startswith("/api/v10/channels/") and self.path.endswith("/messages"):
            data = json.loads(self.rfile.read(int(self.headers["content-length"])))
            channel = self.path.split("/")[-2]
            card = "components" in data
            if self.world.reject_text is not None and self.world.reject_text == data.get("content"):
                self.json({}, 403)
                return
            if not card and "nonce" in data:
                self.world.nonces.append(data["nonce"])
                if self.world.rate_limit:
                    self.world.rate_limit = False
                    self.json({"retry_after": 0.01}, 429)
                    return
            self.world.replies.put(data)
            self.world.bound += 1
            reference = None if self.world.force_plain_reply else data.get("message_reference")
            self.json({"id": "300" if card else str(301 + self.world.bound), "channel_id": channel,
                       "type": 19 if reference else 0, "message_reference": reference})
        else:
            self.json({}, 404)

    def do_PATCH(self):
        data = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.authorized() and self.path == "/api/v10/channels/20/messages/300":
            self.world.cleared.put(data)
            self.json({"id": "300", "channel_id": "20"})
        else:
            self.json({}, 404)

    def ws_send(self, data):
        payload = json.dumps(data).encode()
        length = len(payload)
        prefix = bytes([0x81, length]) if length < 126 else bytes([0x81, 126]) + struct.pack("!H", length)
        self.wfile.write(prefix + payload)
        self.wfile.flush()

    def ws_read(self):
        header = self.rfile.read(2)
        if not header or header[0] & 15 == 8:
            return None
        length = header[1] & 127
        if length == 126:
            length, = struct.unpack("!H", self.rfile.read(2))
        if length == 127:
            length, = struct.unpack("!Q", self.rfile.read(8))
        mask = self.rfile.read(4)
        payload = self.rfile.read(length)
        return json.loads(bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

    def websocket(self):
        key = self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "upgrade")
        self.send_header("Sec-WebSocket-Accept", b64encode(sha1(key.encode()).digest()).decode())
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(4)
        self.ws_send({"op": 10, "d": {"heartbeat_interval": 200}})
        identify = self.ws_read()
        if identify is None:
            return
        self.world.auth.put(identify)
        if identify["op"] == 2:
            self.ws_send({"op": 0, "s": self.world.seq, "t": "READY", "d": {
                "session_id": "local-session", "resume_gateway_url": "ws://127.0.0.1/gateway",
            }})
        else:
            self.ws_send({"op": 0, "s": self.world.seq, "t": "RESUMED", "d": {}})
        self.world.ready.set()
        try:
            while True:
                try:
                    event = self.world.events.get_nowait()
                except Empty:
                    event = None
                if event is not None:
                    self.ws_send(event)
                    if event["op"] == 7:
                        return
                if select([self.connection], [], [], 0.025)[0]:
                    frame = self.ws_read()
                    if frame is None:
                        return
                    if frame["op"] == 1:
                        self.world.heartbeat.set()
                        self.ws_send({"op": 11})
                    elif frame["op"] == 3:
                        self.world.presence.put(frame["d"])
        except (EOFError, BrokenPipeError, ConnectionResetError):
            return
