// MCP Bridge CEP panel.
// Runs a WebSocket server on 127.0.0.1 and hands each command to ExtendScript (host/bridge-core.jsx).
// The MCP server finds the port and token in the discovery file written below.
//
// Protocol (JSON text frames):
//   client -> panel   { id, command, args }
//   panel  -> client  { id, ok: true, result, ms } | { id, ok: false, error }

/* global window, document */
(function () {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var crypto = require("crypto");

  var cep = window.__adobe_cep__;
  var extRoot = decodeURIComponent(String(cep.getSystemPath("extension")).replace(/^file:\/\//, ""));
  var WebSocketServer = require(path.join(extRoot, "node_modules", "ws")).WebSocketServer;

  var BASE_PORT = 47653;
  var MAX_PORT_TRIES = 10;
  var token = crypto.randomBytes(24).toString("hex");
  var discoveryFile = path.join(discoveryDir(), "bridge.json");

  var ui = {
    dot: document.getElementById("dot"),
    status: document.getElementById("status"),
    detail: document.getElementById("detail"),
    log: document.getElementById("log")
  };
  var port = null;
  var clients = 0;
  var hostVersion = null;
  try { hostVersion = JSON.parse(cep.getHostEnvironment()).appVersion; } catch (e) { /* not critical */ }

  function discoveryDir() {
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ae-mcp");
    if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "ae-mcp");
    return path.join(os.homedir(), ".ae-mcp");
  }

  function log(message, isError) {
    var line = document.createElement("div");
    line.textContent = new Date().toLocaleTimeString() + "  " + message;
    if (isError) line.className = "err";
    ui.log.insertBefore(line, ui.log.firstChild);
    while (ui.log.childNodes.length > 200) ui.log.removeChild(ui.log.lastChild);
  }

  function render(state, text) {
    ui.dot.className = "dot " + state;
    ui.status.textContent = text;
    ui.detail.textContent = port ? "ws://127.0.0.1:" + port + " · " + clients + " client" + (clients === 1 ? "" : "s") : "";
  }

  // ---- ExtendScript calls, one at a time so undo groups never interleave ----

  var queue = Promise.resolve();

  function jsLiteral(value) {
    return JSON.stringify(value === undefined ? null : value)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  function evalScript(script) {
    return new Promise(function (resolve) { cep.evalScript(script, resolve); });
  }

  function loadCore() {
    var corePath = path.join(extRoot, "host", "bridge-core.jsx");
    return evalScript("$.evalFile(" + jsLiteral(corePath) + "); typeof __AEMCP");
  }

  function dispatch(command, args) {
    var script = "typeof __AEMCP === 'undefined' ? '__AEMCP_MISSING__' : __AEMCP.dispatch(" +
      jsLiteral(command) + ", " + jsLiteral(args || {}) + ")";
    return evalScript(script).then(function (out) {
      if (out !== "__AEMCP_MISSING__") return out;
      return loadCore().then(function () { return evalScript(script); });
    });
  }

  function enqueue(command, args) {
    var run = queue.then(function () { return dispatch(command, args); });
    queue = run.catch(function () {});
    return run;
  }

  function parseResult(raw) {
    if (raw === "EvalScript error.") throw new Error("ExtendScript evaluation failed (is a modal dialog open in After Effects?)");
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  // ---- WebSocket server ----

  function safeEqual(a, b) {
    var x = Buffer.from(String(a || "")), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  // Browsers always send Origin, so refusing it stops web pages from reaching AE.
  // The token stops other local processes that have not read the discovery file.
  function verifyClient(info) {
    if (info.req.headers.origin) return false;
    return safeEqual(info.req.headers["x-aemcp-token"], token);
  }

  function handleMessage(socket, data) {
    var msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    var id = msg.id;
    var command = String(msg.command || "");
    var started = Date.now();

    if (command === "__ping") {
      socket.send(JSON.stringify({ id: id, ok: true, result: { pong: true, hostVersion: hostVersion } }));
      return;
    }

    enqueue(command, msg.args).then(function (raw) {
      var result = parseResult(raw);
      var ms = Date.now() - started;
      var failed = result && (result.status === "error" || result.success === false);
      log(command + " · " + ms + " ms" + (failed ? " · " + (result.message || "error") : ""), failed);
      socket.send(JSON.stringify({ id: id, ok: true, result: result, ms: ms }));
    }).catch(function (err) {
      log(command + " · " + err.message, true);
      socket.send(JSON.stringify({ id: id, ok: false, error: err.message }));
    });
  }

  function writeDiscovery() {
    fs.mkdirSync(path.dirname(discoveryFile), { recursive: true, mode: 448 });
    fs.writeFileSync(discoveryFile, JSON.stringify({ port: port, token: token, pid: process.pid, started: new Date().toISOString() }), { mode: 384 });
    fs.chmodSync(discoveryFile, 384);
  }

  function removeDiscovery() {
    try {
      var current = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      if (current.token === token) fs.unlinkSync(discoveryFile);
    } catch (e) { /* already gone */ }
  }

  function listen(attempt) {
    var candidate = BASE_PORT + attempt;
    var wss = new WebSocketServer({ host: "127.0.0.1", port: candidate, verifyClient: verifyClient, maxPayload: 16 * 1024 * 1024 });

    wss.on("listening", function () {
      port = candidate;
      activeServer = wss;
      writeDiscovery();
      render("warn", "Listening, no MCP client yet");
      log("Listening on 127.0.0.1:" + port);
    });

    wss.on("error", function (err) {
      if (err.code === "EADDRINUSE" && attempt + 1 < MAX_PORT_TRIES) { listen(attempt + 1); return; }
      render("err", "Server error");
      log(err.message, true);
    });

    wss.on("connection", function (socket) {
      clients++;
      render("ok", "MCP client connected");
      log("Client connected");
      socket.on("message", function (data) { handleMessage(socket, data); });
      socket.on("close", function () {
        clients--;
        render(clients > 0 ? "ok" : "warn", clients > 0 ? "MCP client connected" : "Listening, no MCP client yet");
        log("Client disconnected");
      });
    });

  }

  // Shut down when the panel closes or AE quits. ws.close() leaves open sockets alone,
  // so terminate clients explicitly; the MCP side then sees the bridge as gone.
  var activeServer = null;
  var stopped = false;
  function shutdown() {
    if (stopped) return;
    stopped = true;
    removeDiscovery();
    if (activeServer) {
      activeServer.clients.forEach(function (c) { c.terminate(); });
      activeServer.close();
    }
  }
  window.addEventListener("beforeunload", shutdown);
  window.addEventListener("unload", shutdown);
  try { cep.addEventListener("com.adobe.csxs.events.ApplicationBeforeQuit", shutdown); } catch (e) { /* older CEP */ }

  loadCore().then(function (type) {
    if (type !== "object") log("bridge-core.jsx did not load (got " + type + ")", true);
    listen(0);
  });
})();
